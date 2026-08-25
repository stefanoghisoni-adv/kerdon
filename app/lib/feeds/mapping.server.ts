import { prisma } from '~/db.server';
import { defaultMapping, isVariable, type Variable } from './gmc';

/**
 * La mappatura fra colonne del catalogo e campi di una piattaforma.
 *
 * Salvata per negozio: due merchant tengono il codice a barre in due posti
 * diversi, e imporne uno vorrebbe dire che uno dei due ha il feed sbagliato.
 *
 * `recent` non e' una comodita' da poco: chi mappa venti campi cambia idea,
 * torna indietro, riprova. Ritrovare in cima le variabili gia' provate su
 * QUESTO campo vale piu' di qualunque ordinamento — e sono per campo, non per
 * negozio, perche' le variabili che si provano su `gtin` non sono quelle che si
 * provano su `title`.
 */

/** Quante scelte precedenti si tengono. */
export const RECENT_LIMIT = 5;

export interface FieldMapping {
  variable: Variable;
  recent: Variable[];
}

export type Mapping = Record<string, FieldMapping>;

/**
 * La mappatura del negozio, completata con i suggerimenti.
 *
 * Un campo mai toccato non ha una riga sul database: torna comunque, con la
 * variabile suggerita. Cosi' aggiungere un campo nuovo al feed non richiede di
 * scrivere righe per tutti i negozi che esistono.
 */
export async function loadMapping(shopId: string, platform: string): Promise<Mapping> {
  const rows = await prisma.feedFieldMapping.findMany({ where: { shopId, platform } });
  const saved = new Map(rows.map((row) => [row.field, row]));

  const mapping: Mapping = {};
  for (const [field, suggested] of Object.entries(defaultMapping())) {
    const row = saved.get(field);
    mapping[field] = {
      // Una variabile che non esiste piu' (rinominata, tolta) torna al
      // suggerimento: meglio un campo che funziona di uno che punta nel vuoto.
      variable: row && isVariable(row.variable) ? row.variable : suggested,
      recent: (row?.recent ?? []).filter(isVariable),
    };
  }
  return mapping;
}

/** Solo le variabili scelte, come le vuole il generatore del feed. */
export function variablesOf(mapping: Mapping): Record<string, Variable> {
  return Object.fromEntries(
    Object.entries(mapping).map(([field, value]) => [field, value.variable]),
  );
}

/**
 * Salva la scelta su un campo.
 *
 * La variabile che si lascia entra fra le recenti, non quella che si prende:
 * quella nuova e' gia' in cima come scelta corrente, e averla due volte nella
 * stessa tendina la farebbe sembrare due opzioni diverse.
 */
export async function saveField(
  shopId: string,
  platform: string,
  field: string,
  variable: Variable,
): Promise<void> {
  const existing = await prisma.feedFieldMapping.findUnique({
    where: { shopId_platform_field: { shopId, platform, field } },
  });

  const previous = existing?.variable;
  const recent = [
    ...(previous && previous !== variable ? [previous] : []),
    ...(existing?.recent ?? []),
  ]
    // Senza duplicati e senza quella appena scelta: la tendina non deve
    // ripetere la stessa voce in due sezioni.
    .filter((value, index, all) => value !== variable && all.indexOf(value) === index)
    .slice(0, RECENT_LIMIT);

  await prisma.feedFieldMapping.upsert({
    where: { shopId_platform_field: { shopId, platform, field } },
    create: { shopId, platform, field, variable, recent },
    update: { variable, recent },
  });
}
