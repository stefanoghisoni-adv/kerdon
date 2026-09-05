// app/lib/supabase/delete-merchant-data.server.ts
// Eliminare dal database del merchant le tabelle che l'app ha creato — e non
// dichiararlo fatto finche' non lo e'.
//
// Com'era prima, e perche' era grave: lo scollegamento con "elimina tabelle e
// dati" faceva DROP su due nomi soli (quelli configurati per prodotti e
// clienti) mentre l'app di tabelle ne crea cinque; qualunque errore finiva in
// un `console.warn`; e token OAuth e configurazione venivano cancellati
// COMUNQUE. Il risultato era il peggiore possibile: dati ancora li', credenziali
// buttate via, e al merchant la conferma che era andato tutto bene. Da quello
// stato l'app non poteva piu' finire il lavoro nemmeno volendo.
//
// L'ordine adesso e' questo, e non e' negoziabile:
//
//   lucchetto → collegamento spento → DROP in una transazione → verifica →
//   solo allora token e configurazione via.
//
// Ogni passo prima dell'ultimo puo' fallire lasciando il merchant esattamente
// dov'era, con le credenziali per riprovare.

import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQuery, runQueryRows } from '~/lib/supabase-management.server';
import { runWithShopLease, type ShopLease } from '~/lib/queue/shop-lock.server';
import { clearShopStatsCache } from '~/lib/cache/stats-cache.server';
import { InvalidIdentifierError } from './identifiers';
import {
  buildDropTransactionSQL,
  buildExistenceCheckSQL,
  qualifiedName,
  remainingResources,
  type ExistingTableRow,
  type ManagedResource,
} from './managed-resources';
import { ownedResources } from './managed-resources.server';

export type DeleteMerchantDataStatus =
  /** Tabelle eliminate e verificate: token e configurazione sono stati tolti. */
  | 'completed'
  /** Non c'era niente di nostro da eliminare. Anche questo e' un successo. */
  | 'nothing_owned'
  /** Qualcun altro sta gia' facendo la stessa cosa su questo negozio. */
  | 'already_running'
  /** Non e' riuscita: token e configurazione sono ancora li'. */
  | 'failed';

export interface DeleteMerchantDataResult {
  status: DeleteMerchantDataStatus;
  /** I nomi qualificati che il tentativo si prefiggeva di eliminare. */
  attempted: string[];
  /** Quelli che dopo il COMMIT risultavano ancora presenti. */
  remaining: string[];
  /**
   * Se riprovare ha senso.
   *
   * false su un nome malformato: quello non diventa valido riprovandolo, e va
   * corretto prima. true su tutto il resto — un token scaduto, un progetto in
   * pausa, la Management API che non risponde sono guasti passeggeri.
   */
  retryable: boolean;
  error?: string;
}

function names(resources: readonly ManagedResource[]): string[] {
  return resources.map((r) => `${r.schemaName}.${r.resourceName}`);
}

/**
 * Elimina i dati e, solo se ci riesce, revoca l'accesso.
 *
 * Il lucchetto e' quello della sincronizzazione, non uno nuovo, e la ragione e'
 * proprio che dev'essere lo stesso: mentre le tabelle spariscono nessuna corsa
 * deve poterci scrivere dentro, e una corsa gia' partita deve finire prima che
 * si cominci. Chi arriva secondo non fa niente e lo dice — non e' un errore,
 * e' qualcun altro che sta gia' facendo quella cosa.
 *
 * E se il lucchetto non si puo' nemmeno chiedere — il database owner non
 * risponde — non si elimina niente. Prima si tirava dritto senza lucchetto, e
 * questo e' il posto dove quella scelta costava di piu': qui si fa DROP TABLE
 * sul database di un merchant.
 */
export async function deleteMerchantData(
  shopId: string,
): Promise<DeleteMerchantDataResult> {
  let result: DeleteMerchantDataResult | null = null;

  const esito = await runWithShopLease(shopId, async (lease) => {
    result = await runDeletion(shopId, lease);
  });

  if (esito !== 'eseguito') {
    return {
      status: 'already_running',
      attempted: [],
      remaining: [],
      retryable: true,
    };
  }

  // Il lucchetto e' stato preso ma `runDeletion` non ha restituito niente: non
  // puo' succedere, e proprio per questo non si finge un successo.
  return (
    result ?? {
      status: 'failed',
      attempted: [],
      remaining: [],
      retryable: true,
      error: 'eliminazione interrotta senza esito',
    }
  );
}

async function runDeletion(
  shopId: string,
  lease?: ShopLease,
): Promise<DeleteMerchantDataResult> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { supabaseConfig: true },
  });
  const config = shop?.supabaseConfig;
  if (!shop || !config) {
    // Niente configurazione, niente database: non c'e' nulla da eliminare e
    // nulla da revocare oltre a quello che il chiamante fara' comunque.
    return { status: 'nothing_owned', attempted: [], remaining: [], retryable: false };
  }

  const ref =
    config.supabaseProjectRef ||
    config.supabaseUrl.match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1] ||
    null;

  // Senza `ref` non si sa a quale progetto chiedere: e senza saperlo, ogni
  // affermazione sull'esito sarebbe inventata.
  if (!ref) {
    return {
      status: 'failed',
      attempted: [],
      remaining: [],
      retryable: false,
      error: 'progetto Supabase non identificabile',
    };
  }

  const resources = await ownedResources(shopId, ref);
  if (resources.length === 0) {
    // Il registro non conosce niente di nostro su questo progetto. E' la
    // lettura conservativa e la si tiene: eliminare "quello che di solito
    // creiamo" su un database dove non risulta che l'abbiamo creato noi e'
    // esattamente l'errore da cui questo file nasce.
    console.warn(
      `[delete-merchant-data] shop ${shopId}: nessuna risorsa registrata come nostra sul progetto ${ref}`,
    );
    return { status: 'nothing_owned', attempted: [], remaining: [], retryable: false };
  }

  // La costruzione del DDL viene PRIMA di qualunque cosa succeda davvero: un
  // nome che non e' un identificatore lecito ferma tutto adesso, quando non e'
  // ancora stato fatto niente. A meta' di un DROP non c'e' piu' niente da
  // salvare.
  let dropSQL: string;
  let checkSQL: string;
  try {
    dropSQL = buildDropTransactionSQL(resources);
    checkSQL = buildExistenceCheckSQL(resources);
  } catch (err) {
    if (err instanceof InvalidIdentifierError) {
      console.error(
        `[delete-merchant-data] shop ${shopId}: nome non ammesso nel DDL (${err.identifier})`,
      );
      return {
        status: 'failed',
        attempted: names(resources),
        remaining: names(resources),
        retryable: false,
        error: err.message,
      };
    }
    throw err;
  }

  const attempted = resources.map((r) => qualifiedName(r));

  // Da qui in poi il collegamento e' spento. `connectionVerifiedAt` e' il solo
  // interruttore che tutto il resto guarda — corsa periodica, coda, webhook di
  // prodotti, clienti e ordini — quindi azzerarlo PRIMA del DDL e' cio' che
  // impedisce a una scrittura di arrivare su una tabella che sta cadendo, o di
  // ricrearne una appena tolta.
  await prisma.supabaseConfig.update({
    where: { shopId },
    data: { connectionVerifiedAt: null },
  });
  const deletion = await prisma.supabaseDataDeletion.create({
    data: {
      shopId,
      projectRef: ref,
      status: 'processing',
      resources: attempted,
      remaining: [],
    },
  });

  const fail = async (
    error: string,
    remaining: string[],
    retryable = true,
  ): Promise<DeleteMerchantDataResult> => {
    await prisma.supabaseDataDeletion.update({
      where: { id: deletion.id },
      data: { status: 'failed', lastError: error.slice(0, 1000), remaining },
    });
    console.error(`[delete-merchant-data] shop ${shopId}: ${error}`);
    return { status: 'failed', attempted, remaining, retryable, error };
  };

  let token: string;
  try {
    token = await getValidAccessToken(shopId);
  } catch (err) {
    return fail(
      `token Supabase non disponibile: ${err instanceof Error ? err.message : 'errore sconosciuto'}`,
      attempted,
    );
  }

  try {
    // L'ultimo controllo prima del DROP. Se il lucchetto nel frattempo e'
    // passato a un'altra corsa — la nostra e' stata lenta, il lease e' scaduto
    // — quella corsa sta scrivendo proprio nelle tabelle che stiamo per far
    // cadere. Lanciare qui costa un'eliminazione rimandata; non lanciare costa
    // una tabella che sparisce sotto una scrittura in corso.
    await lease?.assertHeld();
    await runQuery(token, ref, dropSQL);
  } catch (err) {
    // La transazione si e' gia' annullata da sola: Postgres, dentro a un
    // BEGIN, trasforma il COMMIT in ROLLBACK appena un'istruzione fallisce.
    // Quindi qui il database del merchant e' come prima, per intero.
    return fail(
      `DROP non riuscito: ${err instanceof Error ? err.message : 'errore sconosciuto'}`,
      attempted,
    );
  }

  // La verifica, e non e' una formalita': un DROP con IF EXISTS non protesta
  // per una tabella che non ha toccato, e la Management API risponde 2xx
  // all'SQL eseguito, non all'esito che ci aspettavamo. L'unica prova che le
  // tabelle non ci sono piu' e' andarle a cercare.
  let rows: ExistingTableRow[];
  try {
    rows = await runQueryRows<ExistingTableRow>(token, ref, checkSQL);
  } catch (err) {
    // Non sapere non e' sapere di si': si conserva tutto e si riprova.
    return fail(
      `verifica non riuscita: ${err instanceof Error ? err.message : 'errore sconosciuto'}`,
      attempted,
    );
  }

  const stillThere = remainingResources(resources, rows);
  if (stillThere.length > 0) {
    return fail(
      `eliminazione incompleta: ${names(stillThere).join(', ')}`,
      stillThere.map((r) => qualifiedName(r)),
    );
  }

  // Solo adesso si revoca. Prima di questa riga il merchant ha ancora tutto
  // quello che serve a riprovare; dopo, non serve piu' a niente.
  await prisma.supabaseOAuthToken.deleteMany({ where: { shopId } });
  // Il registro segue le tabelle che descriveva: senza di loro non descrive
  // piu' niente, e lasciarlo li' vorrebbe dire che un collegamento futuro allo
  // stesso progetto si crederebbe padrone di tabelle che dovra' ricreare da
  // capo.
  await prisma.supabaseManagedResource.deleteMany({ where: { shopId, projectRef: ref } });
  await prisma.supabaseConfig.deleteMany({ where: { shopId } });
  // Scollegarsi riporta il negozio al punto di partenza: la configurazione si
  // rifa' da capo.
  await prisma.shop.update({ where: { id: shopId }, data: { setupCompletedAt: null } });
  await prisma.supabaseDataDeletion.update({
    where: { id: deletion.id },
    data: { status: 'completed', completedAt: new Date(), remaining: [] },
  });

  // I conteggi in cache raccontano un database che non esiste piu'. Best
  // effort: scadrebbero da soli, ma un giorno intero di numeri credibili e
  // falsi e' peggio di nessun numero.
  await clearShopStatsCache(shopId);

  return { status: 'completed', attempted, remaining: [], retryable: false };
}
