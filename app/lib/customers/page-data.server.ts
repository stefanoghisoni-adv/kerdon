// app/lib/customers/page-data.server.ts
//
// I dati lenti della tab Clienti: il report dal database del merchant e i
// campi personalizzati dei clienti da Shopify.
//
// Stanno fuori dalla rotta perche' la loro forma e' il punto: le due letture
// partono INSIEME, nel momento in cui si chiama questa funzione, e nessuna
// aspetta l'altra. Prima la domanda a Shopify si attendeva per intero e solo
// dopo partiva il report; ora il tempo e' quello della piu' lenta delle due,
// non la somma. E la rotta non le aspetta affatto: le consegna alla pagina come
// promessa, cosi' la tab si apre subito e i numeri arrivano dopo.

import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { birthdateNoticeDismissedFor } from './birthdate-dismissal.server';
import {
  BIRTHDATE_METAFIELD_KEY,
  birthdateFieldState,
  birthdateMetafieldOf,
  formatMetafieldKey,
  isDateMetafieldType,
} from './birthdate-metafield';
import { loadCustomersReport, type CustomersReport } from './customers.server';
import { customerMetafieldsUrl } from '~/utils/admin-page';
import type { ServerTiming } from '~/lib/timing/server-timing';
import { connectionStatus } from '~/lib/integrations/connections.server';
import { importInProgress } from '~/lib/integrations/import.server';
import { prisma } from '~/db.server';

export interface CustomerDefinition {
  key: string;
  name: string;
  type: string;
}

export interface BirthdateData {
  /** Il campo da cui si legge oggi, vuoto se non ne e' stato scelto uno. */
  configured: string;
  /**
   * Nessuno, in uso, oppure scelto ma non presente sul negozio.
   *
   * Lo decide il server perche' e' l'unico ad avere in mano tutt'e due le
   * meta' della domanda: la scelta salvata e l'elenco vero delle definizioni.
   * L'elenco non letto vale `null` e non "vuoto" — non sapere non e' lo stesso
   * che sapere di no, e su un dubbio non si smentisce una configurazione che il
   * merchant ha fatto davvero.
   */
  state: ReturnType<typeof birthdateFieldState>;
  /** La nostra definizione esiste gia' sul negozio? */
  ourDefinitionPresent: boolean | null;
  definitions: CustomerDefinition[];
  /**
   * Il campo in uso non contiene una data: si avvisa, perche' da un testo
   * libero la data si ricava solo se e' scritta in modo riconoscibile, e quello
   * che non lo e' lascia la colonna vuota. Nessun avviso quando il campo non e'
   * fra le definizioni: di quello non si conosce il tipo, e un avviso a caso e'
   * peggio di nessuno.
   */
  notADate: boolean;
  adminUrl: string | null;
  /**
   * Per quale campo l'avviso di conferma risulta gia' chiuso.
   *
   * Viene da qui e non dal browser: `localStorage` appartiene all'indirizzo da
   * cui la pagina arriva, e dentro l'admin questa pagina sta in un iframe di
   * un'altra origine — storage di terze parti, che Safari blocca e Chrome
   * partiziona. Arrivando dal server il riquadro sa gia', quindi non c'e' il
   * lampo fra quel che si mostra e quel che l'idratazione corregge.
   */
  dismissedFor: string | null;
}

export interface IntegrationStatus {
  provider: 'klaviyo';
  status: 'connected' | 'not_connected' | 'needs_reconnect';
  accountName?: string | null;
  mapping: { sourceKey: string; dateFormat: string } | null;
  lastRun: {
    status: 'completed' | 'interrupted';
    finishedAt: string | null;
    counters: { filled?: number; conflicts?: number; [key: string]: unknown };
  } | null;
  /** Un import e' in corso adesso: il pulsante resta fermo e lo dice. */
  running: boolean;
  openConflicts: number;
}

export interface CustomersPageData {
  report: CustomersReport;
  /** Il riquadro del campo "Data di nascita". */
  birthdate: BirthdateData;
  /** Le integrazioni disponibili. null se il piano non include clienti. */
  integrations: IntegrationStatus[] | null;
}

/**
 * Fa partire le due letture e restituisce la promessa del loro esito.
 *
 * Non rifiuta mai per un guasto delle due letture: un report che non si legge
 * diventa `unavailable: 'failed'`, campi personalizzati che non si leggono
 * diventano un elenco "non letto" — gli stessi esiti di quando la rotta li
 * aspettava da se'.
 */
export function startCustomersPageData(opts: {
  shopDomain: string;
  shop: {
    id: string;
    birthdateMetafieldNamespace?: string | null;
    birthdateMetafieldKey?: string | null;
  };
  range: { from: string; to: string };
  timing?: ServerTiming;
}): Promise<CustomersPageData> {
  const measure = <T>(name: string, work: () => Promise<T>): Promise<T> =>
    opts.timing ? opts.timing.measure(name, work) : work();

  // Anche col piano giusto una lettura puo' fallire — tabella non ancora
  // creata, progetto irraggiungibile. Un guasto sul database del merchant non
  // deve diventare una pagina d'errore dell'app.
  const report: Promise<CustomersReport> = loadCustomersReport({
    shopDomain: opts.shopDomain,
    ...opts.range,
    timing: opts.timing,
  }).catch((error) => {
    console.warn(
      '[customers] lettura non riuscita:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    return { rows: [], currency: 'EUR', lifetimeCustomers: 0, unavailable: 'failed' as const };
  });

  // I campi personalizzati che il negozio ha sui clienti.
  //
  // Una domanda sola a Shopify, che pero' ne risolve due: riempie la tendina da
  // cui il merchant indica un campo che ha gia', e dice se il nostro c'e' —
  // quest'ultima e' una rilevazione vera, non la deduzione da un tentativo di
  // scrittura andato a vuoto.
  //
  // Un guasto qui non porta via la pagina: l'elenco resta "non letto" e il
  // pulsante si comporta come se il campo mancasse. Crearlo due volte non fa
  // danno, Shopify risponde che quella chiave e' gia' occupata.
  const definitions: Promise<CustomerDefinition[] | null> = measure('definitions', () =>
    ShopifyAPIClient.forShop(opts.shopDomain).then((client) =>
      client.listCustomerMetafieldDefinitions(),
    ),
  )
    .then((list) =>
      list.map((d) => ({ key: formatMetafieldKey(d), name: d.name, type: d.type })),
    )
    .catch((error) => {
      console.warn(
        '[customers] campi personalizzati dei clienti non leggibili:',
        error instanceof Error ? error.message : 'errore sconosciuto',
      );
      return null;
    });

  const configuredKey = formatMetafieldKey(birthdateMetafieldOf(opts.shop));
  const dismissedFor = birthdateNoticeDismissedFor(opts.shop.id, configuredKey);

  const birthdate: Promise<BirthdateData> = Promise.all([definitions, dismissedFor]).then(
    ([read, dismissed]) => {
      const list = read ?? [];
      const configuredDefinition = list.find((d) => d.key === configuredKey);
      return {
        configured: configuredKey,
        state: birthdateFieldState(configuredKey, read ? read.map((d) => d.key) : null),
        ourDefinitionPresent: read
          ? read.some((d) => d.key === formatMetafieldKey(BIRTHDATE_METAFIELD_KEY))
          : null,
        definitions: list,
        notADate: configuredDefinition != null && !isDateMetafieldType(configuredDefinition.type),
        adminUrl: customerMetafieldsUrl(opts.shopDomain),
        dismissedFor: dismissed,
      };
    },
  );

  // Le integrazioni disponibili (oggi solo Klaviyo).
  const integrations: Promise<IntegrationStatus[]> = measure('integrations', async () => {
    const provider = 'klaviyo' as const;
    const { status: rawStatus, accountName } = await connectionStatus(opts.shop.id);

    // Mappa lo status da connectionStatus a quello atteso da IntegrationStatus
    const status: 'connected' | 'not_connected' | 'needs_reconnect' =
      rawStatus === 'connected'
        ? 'connected'
        : rawStatus === 'needs_reconnect'
        ? 'needs_reconnect'
        : 'not_connected';

    const mappingRow = await prisma.integrationFieldMapping.findUnique({
      where: {
        shopId_provider_targetField: {
          shopId: opts.shop.id,
          provider,
          targetField: 'birthdate',
        },
      },
    });

    const mapping = mappingRow
      ? { sourceKey: mappingRow.sourceKey, dateFormat: mappingRow.dateFormat ?? 'auto' }
      : null;

    const lastRunRow = await prisma.integrationImportRun.findFirst({
      where: {
        shopId: opts.shop.id,
        provider,
        status: { in: ['completed', 'interrupted'] },
      },
      orderBy: { startedAt: 'desc' },
    });

    const lastRun = lastRunRow
      ? {
          status: lastRunRow.status as 'completed' | 'interrupted',
          finishedAt: lastRunRow.finishedAt?.toISOString() ?? null,
          counters: lastRunRow.counters as { filled?: number; conflicts?: number; [key: string]: unknown },
        }
      : null;

    const openConflicts = await prisma.integrationConflict.count({
      where: {
        shopId: opts.shop.id,
        provider,
        status: 'open',
      },
    });

    const running = await importInProgress(opts.shop.id, provider);

    return [{ provider, status, accountName, mapping, lastRun, running, openConflicts }];
  }).catch((error) => {
    console.warn(
      '[customers] integrazioni non leggibili:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    return [];
  });

  return Promise.all([report, birthdate, integrations]).then(([r, b, i]) => {
    // Queste fasi finiscono dopo che la risposta e' partita, quindi non
    // possono stare nell'header: si scrivono nei log, una riga per apertura.
    if (opts.timing) console.info('[customers] tempi:', opts.timing.summary());
    return { report: r, birthdate: b, integrations: i };
  });
}
