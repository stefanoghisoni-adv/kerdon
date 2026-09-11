// app/lib/gdpr/paged-read.ts
//
// Come si legge tutto quello che c'e', quando "tutto" non entra in una risposta.
//
// Sta in un file suo per la stessa ragione di steps.ts, ed e' meccanica:
// l'inventario dei dati personali (customer-record.server) ha bisogno del grafo
// delle identita' (identity-graph.server), quindi il grafo non puo' importare
// dall'inventario. Ma le due letture hanno lo stesso problema e meritano la
// stessa risposta: una richiesta GDPR che legge meta' delle righe e' peggio di
// una che fallisce, perche' si dichiara riuscita.
//
// PERCHE' PER CHIAVE E NON PER SCOSTAMENTO, che e' come si faceva prima.
// `.range(from, to)` senza `ORDER BY` chiede a Postgres la fetta n-esima di un
// ordine che Postgres non ha promesso: senza ordinamento esplicito il piano puo'
// cambiare fra una pagina e l'altra, e basta una scrittura in corso perche' la
// stessa riga esca in due pagine — o non esca affatto. Il confronto con il
// conteggio non se ne accorgeva, perche' un doppione e una riga persa insieme
// fanno tornare il totale: l'esportazione risultava completa ed era sbagliata.
//
// Adesso ogni pagina dice due cose che prima non diceva: da che colonna e'
// ordinata, e da quale valore riparte. La colonna arriva da una mappa nostra
// (`subject-keys`) e mai da fuori — dettagliato li'. L'avanzamento e' "tutto
// cio' che viene dopo l'ultima chiave vista": una riga inserita prima del
// cursore non ci fa saltare niente, e una cancellata non fa scorrere indietro
// la finestra.
//
// QUANDO SI SMETTE. Mai perche' una pagina e' arrivata corta: il tetto di righe
// per risposta e' del progetto, non nostro, e un progetto configurato a cento
// righe risponde con cento anche quando gliene chiediamo cinquecento. "Corta
// quindi ultima" avrebbe troncato la lettura al primo giro dichiarandola
// intera. Si smette quando si sono raccolte tutte le righe che il database
// aveva dichiarato all'inizio, e — se quel conteggio non e' arrivato — solo
// davanti a una pagina vuota.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GdprStep, QueryError } from './steps';
import { toStep } from './steps';
import { orderKeyOf, type GdprTableId } from './subject-keys';

/**
 * Quante righe si chiedono per pagina.
 *
 * PostgREST ha un tetto configurato per risposta (di default 1000), e un URL
 * troppo lungo puo' essere rifiutato dal proxy. Cinquecento e' abbastanza
 * grande da essere efficiente — poche richieste per cliente — e abbastanza
 * piccolo da non rischiare ne' troncamenti ne' problemi di lunghezza.
 */
export const PAGE_SIZE = 500;

/**
 * Quanti identificativi si mettono in un solo `.in()`.
 *
 * Diecimila id in una query non e' una query, e' un errore che aspetta: il
 * filtro diventa un URL troppo lungo, e anche quando passa la richiesta e'
 * lenta. Si spezza in lotti, ciascuno abbastanza grande da ammortizzare
 * l'andata e ritorno ma abbastanza piccolo da stare in una richiesta.
 */
export const IDS_BATCH_SIZE = 100;

/**
 * Una tabella da leggere: chi e' per noi, e come si chiama la' dentro.
 *
 * I due nomi sono separati apposta. `name` puo' essere scelto dal merchant — la
 * tabella dei clienti lo e' — mentre `id` e' un tipo chiuso, ed e' l'unica cosa
 * da cui si ricava la colonna di ordinamento.
 */
export interface PagedTable {
  id: GdprTableId;
  name: string;
}

/**
 * L'esito di una lettura paginata.
 *
 * `keys` sono le chiavi delle righe uscite, nell'ordine in cui sono uscite:
 * servono a chi deve dimostrare non solo QUANTE righe ha letto ma QUALI — un
 * conteggio uguale non prova che siano le stesse righe.
 *
 * `expected` e' quante righe il database diceva che esistessero quando la
 * lettura e' cominciata, quando lo dice: serve a distinguere "ho letto tutto"
 * da "ho smesso di leggere". Se resta null, il conteggio non e' arrivato.
 */
export interface PagedRead {
  rows: Record<string, unknown>[];
  keys: string[];
  error: unknown;
  expected: number | null;
}

/** Gli id, a gruppi che stanno in una richiesta. */
export function inBatches<T>(ids: readonly T[], size: number = IDS_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}

/** Il valore di una chiave, quando c'e' ed e' utilizzabile come cursore. */
function keyOf(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Scorre una lettura pagina per pagina fino a esaurirla, avanzando per chiave.
 *
 * `page` riceve l'ultima chiave vista (null alla prima pagina) e deve
 * restituire le righe che vengono DOPO di quella, ordinate per la stessa
 * colonna. Chi la scrive non sceglie ne' la colonna ne' l'ordine: glieli passa
 * questa funzione, che li prende dalla mappa.
 *
 * Una riga senza chiave interrompe la lettura con un errore invece di essere
 * saltata. Non e' pignoleria: senza chiave non c'e' da dove ripartire, quindi
 * proseguire vorrebbe dire o rileggere in eterno la stessa pagina o saltare
 * tutto quello che viene dopo — e la seconda finirebbe in un'esportazione
 * dichiarata completa.
 */
export async function drainPages(
  table: PagedTable,
  page: (after: string | null, limit: number) => PromiseLike<{
    data?: unknown;
    error?: unknown;
    count?: number | null;
  }>,
): Promise<PagedRead> {
  const column = orderKeyOf(table.id);
  const rows: Record<string, unknown>[] = [];
  const keys: string[] = [];
  const visti = new Set<string>();
  let after: string | null = null;
  let expected: number | null = null;

  for (;;) {
    const response = await page(after, PAGE_SIZE);
    if (response.error) return { rows, keys, error: response.error, expected };

    // Il conteggio della PRIMA pagina, e solo quello: e' la fotografia di
    // quante righe c'erano quando la lettura e' cominciata. Prendere quello
    // dell'ultima pagina vorrebbe dire confrontare le righe raccolte in mezz'ora
    // con un totale di adesso, che e' un confronto fra due istanti diversi.
    if (expected === null && typeof response.count === 'number') expected = response.count;

    const got = (response.data ?? []) as Record<string, unknown>[];
    if (got.length === 0) break;

    let ultima: string | null = null;
    for (const row of got) {
      const chiave = keyOf(row, column);
      if (chiave === null) {
        return {
          rows,
          keys,
          error: {
            code: 'GDPR_CHIAVE_MANCANTE',
            message: `una riga di ${table.name} non ha ${column}: impaginazione non ripetibile`,
          } satisfies QueryError,
          expected,
        };
      }

      ultima = chiave;
      // Un doppione non puo' arrivare finche' il cursore e' un `>` stretto, ma
      // se arrivasse non deve entrare due volte nell'esportazione.
      if (visti.has(chiave)) continue;
      visti.add(chiave);
      rows.push(row);
      keys.push(chiave);
    }

    // Nessun avanzamento: la pagina successiva sarebbe identica a questa, e si
    // girerebbe per sempre. Non deve succedere con un cursore stretto — questa
    // e' la cintura di sicurezza, non il meccanismo.
    if (ultima === null || ultima === after) break;
    after = ultima;

    // Raccolte tutte quelle che il database aveva dichiarato: la pagina dopo
    // sarebbe vuota, e chiederla e' un'andata e ritorno per sentirselo dire.
    // Senza conteggio non si indovina — si va avanti fino alla pagina vuota.
    if (expected !== null && rows.length >= expected) break;
  }

  return { rows, keys, error: null, expected };
}

/**
 * Tutte le righe di una tabella con `column = value`, impaginate per chiave.
 *
 * `select` esiste per un caso solo, ed e' quello che rende corta la finestra
 * sotto il lucchetto: la fotografia del soggetto legge le sole chiavi, e leggere
 * le sole chiavi e' molte volte piu' rapido che leggere le righe intere.
 */
export async function readAllByEq(
  supabase: SupabaseClient,
  table: PagedTable,
  column: string,
  value: string,
  select = '*',
): Promise<PagedRead> {
  const key = orderKeyOf(table.id);

  return drainPages(table, (after, limit) => {
    // I filtri PRIMA di `.order()`: dopo l'ordinamento PostgREST non accetta
    // piu' condizioni, e la catena non compilerebbe nemmeno.
    let query = supabase.from(table.name).select(select, { count: 'exact' }).eq(column, value);
    if (after !== null) query = query.gt(key, after);
    return query.order(key, { ascending: true }).limit(limit);
  });
}

/**
 * Tutte le righe di una tabella con `column IN (...)`, a lotti e ciascun lotto
 * impaginato.
 *
 * Due tetti diversi, e servono entrambi: gli id nel filtro finiscono in un URL,
 * che ha una lunghezza massima, e le righe che tornano finiscono in una
 * risposta, che ha un numero massimo di righe. Cento ordini stanno nell'URL ma
 * le loro righe possono essere migliaia, quindi ogni lotto si impagina come una
 * lettura qualsiasi.
 */
export async function readAllByIn(
  supabase: SupabaseClient,
  table: PagedTable,
  column: string,
  values: readonly (string | number)[],
  select = '*',
): Promise<PagedRead> {
  const key = orderKeyOf(table.id);
  const rows: Record<string, unknown>[] = [];
  const keys: string[] = [];
  let expected: number | null = 0;

  for (const batch of inBatches(values)) {
    const read = await drainPages(table, (after, limit) => {
      let query = supabase.from(table.name).select(select, { count: 'exact' }).in(column, batch);
      if (after !== null) query = query.gt(key, after);
      return query.order(key, { ascending: true }).limit(limit);
    });

    rows.push(...read.rows);
    keys.push(...read.keys);
    if (read.error) return { rows, keys, error: read.error, expected: null };

    // Basta un lotto senza conteggio perche' il totale atteso non sia piu'
    // affidabile: meglio nessun controllo che un controllo su un numero falso.
    expected = expected === null || read.expected === null ? null : expected + read.expected;
  }

  return { rows, keys, error: null, expected };
}

/**
 * Il passo da registrare per una lettura paginata.
 *
 * Se il database aveva dichiarato un totale e le righe raccolte non lo
 * raggiungono, il passo fallisce: la richiesta viene ritentata invece di
 * consegnare un'esportazione parziale che a chi la legge sembra completa.
 */
export function pagedStep(table: string, read: PagedRead): GdprStep {
  if (read.error) return toStep(table, 'read', { error: read.error as QueryError });

  if (read.expected !== null && read.rows.length !== read.expected) {
    return {
      table,
      outcome: 'failed',
      rows: read.rows.length,
      detail: `il database ne dichiara ${read.expected}, esportate ${read.rows.length}: esportazione incompleta`,
    };
  }

  return toStep(table, 'read', { error: null, count: read.rows.length });
}
