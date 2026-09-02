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

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GdprStep, QueryError } from './steps';
import { toStep } from './steps';

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
 * L'esito di una lettura paginata.
 *
 * `expected` e' quante righe il database dice che esistono, quando lo dice:
 * serve a distinguere "ho letto tutto" da "ho smesso di leggere". Se resta
 * null, il conteggio non e' arrivato e ci si affida alla pagina corta.
 */
export interface PagedRead {
  rows: Record<string, unknown>[];
  error: unknown;
  expected: number | null;
}

/** Gli id, a gruppi che stanno in una richiesta. */
export function inBatches<T>(ids: readonly T[], size: number = IDS_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}

/**
 * Scorre una lettura pagina per pagina fino a esaurirla.
 *
 * Il caso che questa funzione esiste per evitare: PostgREST ha un tetto di
 * righe per risposta, e una risposta al tetto sembra identica a una risposta
 * completa. Chi chiedeva una volta sola e prendeva quello che tornava
 * consegnava alla persona un'esportazione troncata dichiarandola intera — e
 * nella cancellazione lasciava indietro righe dichiarando di averle tolte.
 *
 * L'avanzamento e' di quante righe sono davvero arrivate, non di `PAGE_SIZE`:
 * se il progetto ha un tetto piu' basso di quello che chiediamo, saltare di
 * PAGE_SIZE lascerebbe fuori tutto quello che sta in mezzo.
 */
export async function drainPages(
  page: (from: number, to: number) => PromiseLike<{
    data?: unknown;
    error?: unknown;
    count?: number | null;
  }>,
): Promise<PagedRead> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  let expected: number | null = null;

  for (;;) {
    const response = await page(offset, offset + PAGE_SIZE - 1);
    if (response.error) return { rows, error: response.error, expected };

    const got = (response.data ?? []) as Record<string, unknown>[];
    rows.push(...got);
    if (typeof response.count === 'number') expected = response.count;

    // Una pagina vuota e' la fine, sempre: anche se il conteggio dicesse altro,
    // continuare vorrebbe dire girare a vuoto per sempre.
    if (got.length === 0) break;
    offset += got.length;

    if (expected !== null ? rows.length >= expected : got.length < PAGE_SIZE) break;
  }

  return { rows, error: null, expected };
}

/** Tutte le righe di una tabella con `column = value`, paginate. */
export function readAllByEq(
  supabase: SupabaseClient,
  table: string,
  column: string,
  value: string,
): Promise<PagedRead> {
  return drainPages((from, to) =>
    supabase.from(table).select('*', { count: 'exact' }).eq(column, value).range(from, to),
  );
}

/**
 * Tutte le righe di una tabella con `column IN (...)`, a lotti e ciascun lotto
 * paginato.
 *
 * Due tetti diversi, e servono entrambi: gli id nel filtro finiscono in un URL,
 * che ha una lunghezza massima, e le righe che tornano finiscono in una
 * risposta, che ha un numero massimo di righe. Cento ordini stanno nell'URL ma
 * le loro righe possono essere migliaia, quindi ogni lotto si pagina come una
 * lettura qualsiasi.
 */
export async function readAllByIn(
  supabase: SupabaseClient,
  table: string,
  column: string,
  values: readonly (string | number)[],
): Promise<PagedRead> {
  const rows: Record<string, unknown>[] = [];
  let expected: number | null = 0;

  for (const batch of inBatches(values)) {
    const read = await drainPages((from, to) =>
      supabase.from(table).select('*', { count: 'exact' }).in(column, batch).range(from, to),
    );

    rows.push(...read.rows);
    if (read.error) return { rows, error: read.error, expected: null };

    // Basta un lotto senza conteggio perche' il totale atteso non sia piu'
    // affidabile: meglio nessun controllo che un controllo su un numero falso.
    expected = expected === null || read.expected === null ? null : expected + read.expected;
  }

  return { rows, error: null, expected };
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
