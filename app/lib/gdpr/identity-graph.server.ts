// app/lib/gdpr/identity-graph.server.ts
//
// Il grafo delle identita' dentro una richiesta GDPR: quali righe della tabella
// dei browser riguardano una persona, e come si tolgono.
//
// La tabella `users` non porta un nome, un'email o un indirizzo, e per un pezzo
// e' bastato quello a tenerla fuori dall'inventario. Era sbagliato: ogni riga
// tiene `shopify_customer_id`, cioe' il collegamento esplicito a una persona
// identificata, piu' l'identificativo del suo browser, il browser, il tipo di
// dispositivo, quando e' comparsa la prima volta e quando l'ultima. Messe in
// fila sono l'elenco dei dispositivi di quella persona e delle sue visite: dato
// personale in pieno, e per giunta l'unico che dice qualcosa che il cliente da
// Shopify non ha mai dichiarato.
//
// PERCHE' NON BASTA CERCARE PER shopify_customer_id. Quando due browser si
// rivelano della stessa persona, il piu' recente non viene cancellato: gli si
// scrive `merged_into` con l'identificativo del piu' vecchio, che diventa il
// canonico. Il legame e' quindi un grafo, non una coppia di colonne, e puo'
// avere piu' di un salto — A punta a B che punta a C. Una riga raggiungibile
// solo attraverso quella catena riguarda la stessa persona esattamente come le
// altre: dimenticarla vorrebbe dire consegnare un'esportazione monca in accesso
// e lasciare indietro un identificativo in cancellazione.
//
// PERCHE' UN LIMITE DI PROFONDITA' E NON UNA RICORSIONE. Niente, nel database
// del merchant, impedisce a `merged_into` di chiudere un anello: non c'e' una
// chiave esterna, non c'e' un vincolo, e la riga la scrive un'app che gira su
// funzioni che possono sovrapporsi. Un anello e' improbabile, ma una richiesta
// GDPR che ci finisce dentro non da' un errore: gira, consuma il tempo della
// funzione e muore in timeout, e il merchant si ritrova una cancellazione che
// non finisce mai senza nessuno che sappia dire perche'. Si visita quindi con
// un insieme di gia' visti e un tetto esplicito ai salti, e quando il tetto si
// tocca lo si dichiara nella traccia invece di far finta di niente.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GdprStep, QueryError } from './steps';
import { toStep } from './steps';
import { inBatches, pagedStep, readAllByEq, readAllByIn, type PagedTable } from './paged-read';

/** Il nome e' cablato nella DDL: chi scrive queste righe non lo configura. */
export const USERS_TABLE = 'users';

/**
 * La stessa tabella come la vuole l'impaginazione: chi e' per noi, e come si
 * chiama la' dentro. Qui i due nomi coincidono — e' la tabella dei clienti a
 * essere configurabile, non questa — ma passare l'identita' logica resta
 * l'unico modo per cui la colonna di ordinamento arrivi dalla mappa e non da
 * una stringa scritta qui.
 */
const USERS: PagedTable = { id: 'users', name: USERS_TABLE };

/**
 * Quanti salti di `merged_into` si seguono prima di fermarsi.
 *
 * In un grafo scritto come si deve la catena e' lunga uno: chi si unisce punta
 * sempre al piu' vecchio, mai a un intermedio. Otto e' quindi larghissimo per
 * i dati veri e stretto abbastanza da chiudere in fretta su un anello.
 */
export const MAX_MERGE_DEPTH = 8;

interface Row extends Record<string, unknown> {
  external_id?: string | null;
  merged_into?: string | null;
}

const externalId = (row: Row): string | null =>
  typeof row.external_id === 'string' && row.external_id.length > 0 ? row.external_id : null;

const mergedInto = (row: Row): string | null =>
  typeof row.merged_into === 'string' && row.merged_into.length > 0 ? row.merged_into : null;

export interface IdentityGraph {
  /** Le righe trovate, nell'ordine in cui il grafo le ha rivelate. */
  rows: Row[];
  /** I loro identificativi, che sono la chiave primaria della tabella. */
  ids: string[];
  /** Il passo da mettere nella traccia: lettura riuscita, saltata o fallita. */
  step: GdprStep;
  /** Vero se il tetto ai salti e' stato toccato: il grafo puo' continuare. */
  truncated: boolean;
}

/**
 * Tutte le righe che riguardano una persona, partendo dal suo id Shopify.
 *
 * Si parte dalle righe che lo portano scritto, poi si allarga nelle due
 * direzioni: verso il canonico che una riga dichiara (`merged_into`) e verso
 * chi dichiara una riga come proprio canonico. Servono entrambe — la prima
 * trova il browser vecchio a cui i nuovi si sono uniti, la seconda i browser
 * che si sono uniti a lui.
 *
 * Una tabella che non esiste non e' un errore: i collegamenti anteriori alla
 * DDL del grafo non ce l'hanno, e li' non c'e' nessuna riga da consegnare ne'
 * da cancellare.
 */
export async function resolveIdentityGraph(
  supabase: SupabaseClient,
  customerId: string,
): Promise<IdentityGraph> {
  // Paginata, e non per scrupolo: una persona che naviga da telefono, tablet e
  // due computer ha gia' quattro righe, e un negozio che riconosce i browser da
  // anni puo' averne molte di piu'. Una lettura che si ferma al tetto di righe
  // del progetto qui non troncherebbe solo un'esportazione: farebbe dichiarare
  // completa una cancellazione che ha lasciato indietro delle righe.
  const seeds = await readAllByEq(supabase, USERS, 'shopify_customer_id', customerId);
  const seedsStep = pagedStep(USERS_TABLE, seeds);

  // Si esce su qualunque errore, non solo su quelli fatali: una tabella che non
  // c'e' produce un passo 'skipped', e quel passo deve arrivare nella traccia
  // invece di essere sostituito da un "letto, zero righe" che non e' vero.
  if (seeds.error || seedsStep.outcome === 'failed') {
    return { rows: [], ids: [], step: seedsStep, truncated: false };
  }

  const found = new Map<string, Row>();
  const collect = (rows: Row[]): string[] => {
    const fresh: string[] = [];
    for (const row of rows) {
      const id = externalId(row);
      if (!id || found.has(id)) continue;
      found.set(id, row);
      fresh.push(id);
    }
    return fresh;
  };

  let frontier = collect(seeds.rows as Row[]);
  let truncated = false;
  let depth = 0;

  while (frontier.length > 0) {
    if (depth >= MAX_MERGE_DEPTH) {
      // Toccato il tetto con roba ancora da visitare: il grafo continua, e chi
      // legge la traccia deve saperlo. E' il caso che non deve capitare mai —
      // e se capita e' quasi certamente un anello.
      truncated = true;
      break;
    }
    depth++;

    // Il canonico dichiarato dalle righe appena trovate, e chi dichiara loro
    // come canonico. Due letture per salto, entrambe per chiave.
    const targets = frontier
      .map((id) => mergedInto(found.get(id) as Row))
      .filter((id): id is string => id !== null && !found.has(id));

    const next: Row[] = [];

    if (targets.length > 0) {
      const parents = await readAllByIn(supabase, USERS, 'external_id', targets);
      const parentsStep = pagedStep(USERS_TABLE, parents);
      if (parents.error || parentsStep.outcome === 'failed') {
        return {
          rows: [...found.values()],
          ids: [...found.keys()],
          step: parentsStep,
          truncated,
        };
      }
      next.push(...(parents.rows as Row[]));
    }

    const children = await readAllByIn(supabase, USERS, 'merged_into', frontier);
    const childrenStep = pagedStep(USERS_TABLE, children);
    if (children.error || childrenStep.outcome === 'failed') {
      return {
        rows: [...found.values()],
        ids: [...found.keys()],
        step: childrenStep,
        truncated,
      };
    }
    next.push(...(children.rows as Row[]));

    frontier = collect(next);
  }

  const rows = [...found.values()];
  return {
    rows,
    ids: [...found.keys()],
    step: {
      table: USERS_TABLE,
      outcome: 'read',
      rows: rows.length,
      ...(truncated
        ? {
            detail: `catena di unioni oltre ${MAX_MERGE_DEPTH} salti: lettura interrotta, possibile anello`,
          }
        : {}),
    },
    truncated,
  };
}

/**
 * Le righe del grafo per una richiesta di accesso.
 *
 * Escono cosi' come sono scritte, colonne comprese: l'identificativo del
 * browser e' un dato della persona quanto il resto — e' quello con cui e'
 * stata riconosciuta — e consegnarlo non aggiunge niente a cio' che di lei gia'
 * sappiamo.
 */
export async function collectLinkedBrowsers(
  supabase: SupabaseClient,
  customerId: string,
): Promise<{ rows: Record<string, unknown>[]; step: GdprStep }> {
  const graph = await resolveIdentityGraph(supabase, customerId);
  return { rows: graph.rows, step: graph.step };
}

/**
 * Toglie dal grafo tutto quello che riporta alla persona.
 *
 * LA SCELTA: si CANCELLA, non si anonimizza. Il perche' esteso sta in
 * customer-record.server, accanto a quella opposta presa sugli ordini; qui
 * conta la conseguenza pratica — svuotare `shopify_customer_id` e lasciare la
 * riga non sarebbe una cancellazione. L'identificativo del browser vive ancora
 * dentro il browser di quella persona, quindi la riga resterebbe raggiungibile
 * da lei alla prima visita: un profilo pseudonimo, che l'art. 4(5) chiama dato
 * personale a tutti gli effetti, e che nessun obbligo legale ci impone di
 * conservare — quella tabella serve a riconoscere chi torna, non a tenere i
 * conti.
 *
 * L'ORDINE E' PARTE DEL RIMEDIO. Prima si sciolgono i `merged_into` che
 * puntano dentro il gruppo, poi si cancella. Al contrario, una cancellazione
 * riuscita seguita da uno scioglimento fallito lascerebbe puntatori appesi che
 * il tentativo dopo non saprebbe piu' ritrovare — senza righe da cui partire,
 * non c'e' piu' nessun id da cui dedurli. Cosi' invece ogni ritentativo
 * ricomincia da un grafo ancora intero.
 *
 * Ripetibile senza danno: alla seconda passata non ci sono righe da cui
 * partire, e i due passi si dichiarano saltati con zero righe.
 */
/**
 * La stessa scrittura su tutti gli id, un lotto alla volta.
 *
 * Gli identificativi finiscono nell'URL della richiesta, che ha una lunghezza
 * massima: mille id in un solo `.in()` non sono una scrittura piu' veloce, sono
 * una richiesta rifiutata. I conteggi si sommano, e al primo errore ci si ferma
 * — quello che era gia' stato fatto resta fatto, e il ritentativo lo ritrova.
 */
async function inGroups(
  ids: readonly string[],
  write: (batch: string[]) => PromiseLike<{ error?: QueryError | null; count?: number | null }>,
): Promise<{ error: QueryError | null; count: number }> {
  let count = 0;

  for (const batch of inBatches(ids)) {
    const result = await write(batch);
    count += result.count ?? 0;
    if (result.error) return { error: result.error, count };
  }

  return { error: null, count };
}

export async function eraseBrowsersOfCustomer(
  supabase: SupabaseClient,
  customerId: string,
): Promise<GdprStep[]> {
  const graph = await resolveIdentityGraph(supabase, customerId);

  // Lettura fallita: non si cancella al buio. Cancellare per il solo
  // `shopify_customer_id` toglierebbe le righe dirette e lascerebbe indietro
  // proprio quelle che la lettura non e' riuscita a elencare, che e' il modo
  // peggiore di fallire — sembra fatto, e non lo e'.
  if (graph.step.outcome === 'failed') return [graph.step];

  // Nessuna riga: o la tabella non c'e', o quella persona da questo negozio non
  // ci e' mai passata con un browser che abbiamo riconosciuto. In tutti e due i
  // casi non c'e' niente da cancellare — ed e' anche cio' che si vede alla
  // seconda passata di una cancellazione gia' eseguita.
  if (graph.ids.length === 0) {
    return [
      {
        table: USERS_TABLE,
        outcome: 'skipped',
        rows: 0,
        detail: graph.step.detail ?? 'nessun browser collegato a questa persona',
      },
    ];
  }

  const steps: GdprStep[] = [];

  // I puntatori che entrano nel gruppo da fuori. Dentro il gruppo ci sono gia'
  // tutti — il grafo li ha seguiti in entrambe le direzioni — quindi qui si
  // raccoglie solo cio' che il tetto ai salti ha tagliato via o una scrittura
  // arrivata nel frattempo. Un `merged_into` che punta al nulla non e' un
  // dettaglio estetico: e' un identificativo che resta scritto su una riga viva
  // e continua a dire "questo browser e' quella persona".
  // A lotti, come le letture: gli id finiscono nell'URL della richiesta, e
  // milleduecento non ci stanno. Un solo lotto rifiutato per lunghezza avrebbe
  // fatto fallire lo scioglimento di tutti.
  const unlinked = await inGroups(graph.ids, (batch) =>
    supabase
      .from(USERS_TABLE)
      .update({ merged_into: null }, { count: 'exact' })
      .in('merged_into', batch),
  );
  steps.push({
    ...toStep(`${USERS_TABLE}.merged_into`, 'anonymized', unlinked),
    detail: 'riferimenti che entravano nel gruppo dall esterno, sciolti prima di cancellare',
  });

  // Se lo scioglimento e' fallito non si cancella: cancellare adesso creerebbe
  // esattamente i puntatori appesi che il passo di sopra doveva togliere.
  if (steps[0].outcome === 'failed') return steps;

  const deleted = await inGroups(graph.ids, (batch) =>
    supabase.from(USERS_TABLE).delete({ count: 'exact' }).in('external_id', batch),
  );
  steps.push(toStep(USERS_TABLE, 'deleted', deleted));

  // Il tetto toccato NON rende fallita la richiesta, e vale la pena dire
  // perche': i due passi di sopra bastano comunque a chiudere il conto. Le
  // righe con l'id della persona sono tutte fra le partenze — quella lettura
  // non e' limitata in profondita' — e quindi tutte cancellate; e ogni catena
  // che arrivava fin li' e' stata tagliata dallo scioglimento, perche' il suo
  // ultimo anello puntava dentro il gruppo. Cio' che resta oltre il tetto non
  // ha ne' l'id ne' una strada per raggiungerlo. Si dichiara lo stesso, con un
  // avviso nel log: un grafo cosi' profondo e' quasi certamente un anello, e
  // qualcuno deve andarci a guardare.
  if (graph.truncated) {
    console.warn(
      `[gdpr] grafo delle identita' oltre ${MAX_MERGE_DEPTH} salti: possibile anello in ${USERS_TABLE}`,
    );
    steps.push({
      table: USERS_TABLE,
      outcome: 'skipped',
      rows: 0,
      detail: `catena di unioni oltre ${MAX_MERGE_DEPTH} salti: percorso interrotto, riferimenti residui sciolti`,
    });
  }

  return steps;
}
