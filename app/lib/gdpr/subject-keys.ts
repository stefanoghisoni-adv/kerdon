// app/lib/gdpr/subject-keys.ts
//
// Con quale colonna si ordina e si impagina ogni tabella del progetto del
// merchant, e da dove quel nome puo' arrivare.
//
// PERCHE' UNA MAPPA E NON UN PARAMETRO. Il nome della chiave finisce dentro
// `ORDER BY` e dentro `> ultimo_valore`, cioe' in due punti della query dove
// PostgREST si aspetta un identificatore e non un valore. Un nome che venisse
// da fuori — dalla configurazione del merchant, da una colonna letta, da un
// payload — sarebbe un pezzo di query scritto da qualcun altro. Qui il nome
// della tabella resta configurabile (la tabella dei clienti lo e' davvero, il
// merchant sceglie come chiamarla), ma la CHIAVE no: si sceglie da un'identita'
// logica che e' un tipo chiuso, e se quell'identita' non e' nella mappa non si
// interroga niente. Meglio una richiesta GDPR che fallisce di una che chiede al
// database di ordinare per una colonna che le abbiamo suggerito noi.
//
// PERCHE' PROPRIO QUESTE COLONNE. Devono essere stabili — mai riscritte dopo
// l'inserimento — uniche e non nulle, altrimenti l'impaginazione per chiave
// perde o ripete righe esattamente come faceva quella per scostamento. Sono le
// chiavi primarie che la DDL crea (`lib/supabase-schema`): `id` UUID per
// clienti, ordini e righe d'ordine, e `external_id` per i browser, dove la
// chiave primaria e' l'identificativo stesso.

/**
 * Le tabelle del merchant che una richiesta GDPR legge, con il nome che
 * l'applicazione da' a ognuna.
 *
 * NON e' il nome nel database: quello della tabella dei clienti lo sceglie il
 * merchant. E' l'identita' logica, ed e' l'unica cosa da cui si puo' dedurre
 * una colonna.
 */
export type GdprTableId = 'customers' | 'orders' | 'order_lines' | 'users';

const ORDER_KEYS: Record<GdprTableId, string> = {
  customers: 'id',
  orders: 'id',
  order_lines: 'id',
  users: 'external_id',
};

/** Vero se questa stringa e' una delle tabelle che sappiamo impaginare. */
export function isGdprTableId(value: unknown): value is GdprTableId {
  return typeof value === 'string' && Object.hasOwn(ORDER_KEYS, value);
}

/**
 * La colonna con cui si ordina e si avanza, per un'identita' logica nota.
 *
 * Solleva su tutto il resto, ed e' il punto: `Object.hasOwn` e non un accesso
 * diretto perche' `ORDER_KEYS['constructor']` non e' undefined — un accesso
 * diretto avrebbe restituito qualcosa anche per un nome che nella mappa non
 * c'e'. Il lancio arriva PRIMA di qualunque chiamata al database, cosi' un
 * nome sconosciuto non diventa mai una query.
 */
export function orderKeyOf(id: GdprTableId): string {
  if (!isGdprTableId(id)) {
    throw new Error(
      `tabella '${String(id)}' non prevista dalla mappa delle chiavi: nessuna colonna da usare per impaginare`,
    );
  }
  return ORDER_KEYS[id];
}
