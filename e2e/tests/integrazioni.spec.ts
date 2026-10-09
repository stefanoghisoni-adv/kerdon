// e2e/tests/integrazioni.spec.ts
//
// L'integrazione Klaviyo da un capo all'altro: collegamento, associazione del
// campo, import, conflitto, decisione in blocco.
//
// COSA E' VERO E COSA NO. Vere: le rotte dell'app (loader e action), il
// database dell'app, la coda e il suo drenaggio, il connettore Klaviyo con i
// suoi tentativi e la sua paginazione, il client Supabase e il client
// dell'Admin API. Il popup dell'autorizzazione e' un popup vero in un browser
// vero, e la pagina di ritorno e' quella dell'app. Finti, dietro `fetch`:
// Klaviyo, l'Admin API di Shopify e il database del merchant
// (`e2e/server/fakes/rete.ts`, `klaviyo.server.ts`).
//
// IL CONTRATTO CON LA PAGINA. La tabella Clienti e il dettaglio Klaviyo non si
// montano qui (il server di prova chiama loader e action, non renderizza le
// pagine embedded, che vivono di App Bridge e di `useFetcher`). La catena si
// prova allora in pezzi che si toccano, come in `spedizioni.spec.ts`: le
// risposte delle rotte sono quelle che la pagina riceve, e le si passa alle
// stesse funzioni che la pagina usa (`effectiveView`, `conflictRows`) e allo
// stesso dizionario da cui prende le etichette. La selezione delle righe nella
// tabella diventa l'elenco di id che «Usa Klaviyo» manda alla rotta: e' quello
// che si manda qui.
//
// TUTTO E' INVENTATO: negozio, clienti, profili, email.

import { expect } from '@playwright/test';
import { test as prova } from './support/prova';
import {
  azzera,
  cosaHannoVisto,
  db,
  drenaCoda,
  entraComeNegozio,
  finti,
  NEGOZIO,
  seminaNegozio,
} from './support/server';
import { BASE } from '../ambiente';
import { encrypt } from '~/utils/crypto.server';
import { it as italiano } from '~/lib/i18n/it';
import { conflictRows, effectiveView } from '~/lib/customers/conflict-rows';

const HOST_DATABASE_MERCHANT = 'merchant-finto.supabase.co';

/** Un profilo Klaviyo nella forma JSON:API, con la data di nascita in `Birthday` (gg/mm/aaaa). */
function profilo(id: string, email: string, birthday: string) {
  return { id, attributes: { email, phone_number: null, external_id: null, location: null, properties: { Birthday: birthday } } };
}

/** Una riga della tabella clienti del merchant, con le sole colonne che l'import legge. */
function cliente(id: number, shopifyId: number, email: string, nascita: string | null, consenso: boolean) {
  return {
    id,
    shopify_customer_id: shopifyId,
    email_address: email,
    phone_number: null,
    country_code: 'IT',
    date_of_birth: nascita,
    created_at: '2026-01-0' + id + 'T10:00:00Z',
    accepts_marketing: consenso,
  };
}

prova.describe('integrazione Klaviyo', () => {
  prova('collega, associa Birthday gg/mm, importa, e «Usa Klaviyo» chiude il conflitto', async ({
    page,
    context,
    request,
  }) => {
    await azzera(request);

    // ---- Il negozio: piano con i clienti, campo data di nascita standard ----
    const negozio = await seminaNegozio(request, {
      currentPlan: 'Core',
      birthdateMetafieldNamespace: 'facts',
      birthdateMetafieldKey: 'birth_date',
    });
    await db(request, 'supabaseConfig', 'create', {
      data: {
        shopId: negozio.id,
        supabaseUrl: `https://${HOST_DATABASE_MERCHANT}`,
        supabasePublicKey: 'chiave-pubblica-finta',
        supabaseServiceRoleKey: encrypt('chiave-di-servizio-finta'),
        supabaseProjectRef: 'merchant-finto',
        connectionVerifiedAt: new Date().toISOString(),
      },
    });
    await entraComeNegozio(context, NEGOZIO);

    await finti(request, {
      sessioni: [NEGOZIO],
      graphql: [
        {
          match: 'SetCustomerBirthdates',
          body: { data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } } },
        },
        // L'import riempie solo dove Shopify non ha gia' la data.
        {
          match: 'FillCustomerBirthdates',
          body: { data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } } },
        },
      ],
      databaseMerchant: {
        customers: [
          // Anna: data vuota, consenso → si riempie.
          cliente(1, 1001, 'anna@esempio.test', null, true),
          // Bruno: data diversa da quella di Klaviyo → conflitto, nessuna scrittura.
          cliente(2, 1002, 'bruno@esempio.test', '19750601', true),
          // Carla: data vuota ma SENZA consenso → non si tocca.
          cliente(3, 1003, 'carla@esempio.test', null, false),
        ],
      },
      klaviyo: {
        nomeAccount: 'Negozio di prova',
        // Due per pagina: l'import deve seguire `links.next` per arrivare a tutti.
        dimensionePagina: 2,
        profili: [
          profilo('P1', 'anna@esempio.test', '25/12/1988'),
          profilo('P2', 'bruno@esempio.test', '03/02/1980'),
          profilo('P3', 'carla@esempio.test', '14/07/1992'),
          profilo('P4', 'nessuno@esempio.test', '01/01/1970'),
        ],
      },
    });

    // ---- 1. Collega: OAuth nel popup -----------------------------------------
    // La pagina di Klaviyo e' deviata sul finto, su questo server. Una pagina
    // che rimanda e non un 302: WebKit non accetta un rimando in `fulfill`.
    await context.route('https://www.klaviyo.com/oauth/authorize**', (route) => {
      const vero = new URL(route.request().url());
      const locale = `${BASE}/__fake/klaviyo/www.klaviyo.com${vero.pathname}${vero.search}`;
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${locale.replace(/&/g, '&amp;')}">`,
      });
    });

    const urlRisposta = await context.request.get('/api/integrations/klaviyo/oauth-url');
    expect(urlRisposta.status()).toBe(200);
    const { url: authorizeUrl } = (await urlRisposta.json()) as { url: string };
    expect(authorizeUrl.startsWith('https://www.klaviyo.com/oauth/authorize?')).toBe(true);

    // La finestra dell'app: stessa origine dell'app, come l'iframe in produzione.
    await page.goto('/__test/fakes');
    const messaggio = await page.evaluate(
      (url) =>
        new Promise<{ origin: string; daPopup: boolean; data: Record<string, unknown> }>((risolvi, rifiuta) => {
          const popup = window.open('', 'klaviyo-oauth', 'width=600,height=700');
          if (!popup) return rifiuta(new Error('popup bloccato'));
          window.addEventListener('message', (evento) => {
            risolvi({ origin: evento.origin, daPopup: evento.source === popup, data: evento.data });
          });
          popup.location.href = url;
          setTimeout(() => rifiuta(new Error('nessun messaggio dal popup')), 15_000);
        }),
      authorizeUrl,
    );

    // I controlli che fa `isValidOAuthMessage` nella pagina vera.
    expect(messaggio.origin).toBe(BASE);
    expect(messaggio.daPopup).toBe(true);
    expect(messaggio.data.type).toBe('klaviyo-oauth');
    expect(typeof messaggio.data.code).toBe('string');
    expect(typeof messaggio.data.state).toBe('string');

    const collega = await context.request.post('/api/integrations/klaviyo/connect', {
      data: { code: messaggio.data.code, state: messaggio.data.state },
    });
    expect(collega.status()).toBe(200);
    expect(await collega.json()).toEqual({ ok: true, accountName: 'Negozio di prova' });

    // I gettoni sono salvati cifrati: nessuno dei due e' leggibile nella riga.
    const connessione = await db<{ status: string; accessToken: string; refreshToken: string } | null>(
      request,
      'integrationConnection',
      'findFirst',
      { where: { shopId: negozio.id, provider: 'klaviyo' } },
    );
    expect(connessione?.status).toBe('connected');
    expect(connessione?.accessToken).not.toContain('klaviyo-accesso-');
    expect(connessione?.refreshToken).not.toContain('klaviyo-rinnovo-');

    // ---- 2. Associa la proprieta' Birthday, formato gg/mm ---------------------
    const proprieta = await context.request.get('/api/integrations/klaviyo?view=properties');
    expect(proprieta.status()).toBe(200);
    const { properties } = (await proprieta.json()) as {
      properties: Array<{ key: string; ambiguous: boolean; samples: Array<{ raw: string }> }>;
    };
    const birthday = properties.find((p) => p.key === 'Birthday');
    expect(birthday, 'la proprieta Birthday compare fra quelle con una data').toBeTruthy();
    expect(birthday!.samples.map((s) => s.raw)).toContain('25/12/1988');

    const associa = await context.request.post('/api/integrations/klaviyo', {
      data: {
        intent: 'save-mapping',
        sourceKey: 'Birthday',
        targetField: 'birthdate',
        dateFormat: 'DMY',
        ambiguous: birthday!.ambiguous,
      },
    });
    expect(await associa.json()).toEqual({ ok: true });

    // ---- 3. Importa: si accoda, poi la coda lo lavora ---------------------------
    const importa = await context.request.post('/api/integrations/klaviyo/import');
    expect(await importa.json()).toEqual({ queued: true });

    const esito = await drenaCoda(request, negozio.id);
    expect(esito.errors).toEqual([]);
    expect(esito.completed).toBeGreaterThanOrEqual(1);

    const giro = await db<{ status: string; counters: Record<string, number> } | null>(
      request,
      'integrationImportRun',
      'findFirst',
      { where: { shopId: negozio.id }, orderBy: { startedAt: 'desc' } },
    );
    expect(giro?.status).toBe('completed');
    expect(giro?.counters).toMatchObject({ filled: 1, conflicts: 1, skippedNoMatch: 2 });

    // Il cliente vuoto e' stato riempito su Shopify, e solo lui; e solo se
    // Shopify non aveva gia' una data (compareDigest null). Nessuna
    // sovrascrittura durante l'import.
    const dopoImport = await cosaHannoVisto(request);
    expect(dopoImport.adminLog.filter((c) => c.query.includes('SetCustomerBirthdates'))).toEqual([]);
    const scritture = dopoImport.adminLog.filter((c) => c.query.includes('FillCustomerBirthdates'));
    expect(scritture.map((c) => c.variables)).toEqual([
      {
        metafields: [
          {
            ownerId: 'gid://shopify/Customer/1001',
            namespace: 'facts',
            key: 'birth_date',
            type: 'date',
            value: '1988-12-25',
            compareDigest: null,
          },
        ],
      },
    ],
    );

    // Il cliente diverso compare in «Dati diversi da Klaviyo».
    const elenco = await context.request.get('/api/integrations/conflicts');
    const { conflicts } = (await elenco.json()) as {
      conflicts: Array<{ customerId: number; ours: string | null; theirs: string; field: string; provider: string }>;
    };
    expect(conflicts).toEqual([
      { customerId: 1002, field: 'birthdate', ours: '1975-06-01', theirs: '1980-02-03', provider: 'klaviyo' },
    ]);

    const statoCard = (await (await context.request.get('/api/integrations/klaviyo')).json()) as {
      status: string;
      openConflicts: number;
    };
    expect(statoCard).toMatchObject({ status: 'connected', openConflicts: 1 });

    // La pagina: la tab c'e', `?view=conflicts` la apre, la riga e' Bruno.
    expect(italiano.customers.conflicts.tabConflicts(statoCard.openConflicts)).toBe('Dati diversi da Klaviyo (1)');
    expect(effectiveView(new URLSearchParams('view=conflicts'), statoCard.openConflicts)).toBe('conflicts');
    const righe = conflictRows(conflicts, []);
    expect(righe.map((r) => [r.customerId, r.ours, r.theirs])).toEqual([[1002, '1975-06-01', '1980-02-03']]);

    // ---- 4. Selezione → «Usa Klaviyo» in blocco --------------------------------
    expect(italiano.customers.conflicts.bulkUseTheirs).toBe('Usa Klaviyo');
    const selezionati = righe.map((r) => r.customerId);
    const usa = await context.request.post('/api/integrations/conflicts', {
      data: { customerIds: selezionati, choice: 'used_theirs' },
    });
    expect(usa.status()).toBe(200);
    expect(await usa.json()).toEqual({ ok: true, resolved: 1, notWritten: [] });

    // La data di Klaviyo e' andata su Shopify per Bruno...
    const dopoDecisione = await cosaHannoVisto(request);
    const ultima = dopoDecisione.adminLog.filter((c) => c.query.includes('SetCustomerBirthdates')).at(-1);
    expect(ultima?.variables).toEqual({
      metafields: [
        {
          ownerId: 'gid://shopify/Customer/1002',
          namespace: 'facts',
          key: 'birth_date',
          type: 'date',
          value: '1980-02-03',
        },
      ],
    });

    // ...e il conflitto e' chiuso: non e' piu' fra gli aperti, e la riga dice cosa si e' scelto.
    const aperti = (await (await context.request.get('/api/integrations/conflicts')).json()) as {
      conflicts: unknown[];
    };
    expect(aperti.conflicts).toEqual([]);
    const riga = await db<{ status: string; decidedAt: string | null } | null>(
      request,
      'integrationConflict',
      'findFirst',
      { where: { shopId: negozio.id } },
    );
    expect(riga?.status).toBe('used_theirs');
    expect(riga?.decidedAt).not.toBeNull();

    // Carla, senza consenso, non e' mai stata scritta.
    expect(JSON.stringify(dopoDecisione.adminLog)).not.toContain('Customer/1003');

    // ---- Verso Klaviyo nessuna scrittura ------------------------------------
    // Le sole richieste non-GET sono lo scambio del codice: niente revoca (non si
    // e' scollegato), niente POST/PATCH sull'API.
    const nonLetture = dopoDecisione.klaviyoRichieste.filter((r) => !r.startsWith('GET '));
    expect(nonLetture).toEqual(['POST a.klaviyo.com/oauth/token']);
    // E i profili sono stati letti a pagine: due da due, piu' l'anteprima.
    expect(dopoDecisione.klaviyoRichieste.filter((r) => r === 'GET a.klaviyo.com/api/profiles').length).toBeGreaterThanOrEqual(4);
  });
});
