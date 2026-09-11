// app/lib/ingest/ingest-replay.server.ts
//
// Lo stesso messaggio, mandato due volte.
//
// LE DUE DIFESE SONO DIVERSE E NON SI SOSTITUISCONO, ed e' la cosa da tenere
// ferma leggendo questo file.
//
// LA PRIMA E' LA FINESTRA, e sta in `ingest-model`. Una firma porta dentro il
// suo istante, e fuori da cinque minuti non vale piu': una richiesta catturata
// oggi non si puo' rigiocare domani, e non c'e' niente da ricordare per
// ottenerlo. E' una garanzia che vale sempre, su qualunque istanza, anche dopo
// un riavvio — perche' non dipende da nessuna memoria.
//
// LA SECONDA E' QUESTA, e vale DENTRO la finestra: la stessa chiave di
// idempotenza, dalla stessa credenziale, non si accetta due volte. Chiude i
// cinque minuti che la prima lascia aperti.
//
// E' TENUTA IN MEMORIA, PER ISTANZA, e va detto cosa questo significa invece di
// lasciarlo scoprire: con piu' istanze vive, una ripetizione mandata a
// un'istanza diversa dalla prima passa. Non e' una svista, e' il prezzo di non
// mettere un viaggio di rete davanti a ogni scrittura su una rotta chiamata a
// ogni visita — lo stesso conto gia' fatto per il limite di frequenza, e con la
// stessa conclusione. Quel che resta scoperto e' UNA ripetizione dentro cinque
// minuti; la rigiocata sistematica, che e' l'attacco vero, la ferma la finestra
// e la fermerebbe comunque.
//
// PERCHE' NON UNA TABELLA. Perche' sarebbe una riga scritta e cancellata per
// ogni visita di ogni vetrina di ogni negozio — un registro che cresce come il
// traffico e non come i fatti — per chiudere una finestra di cinque minuti che
// e' gia' chiusa a meta'. Le tabelle di questo progetto tengono cose che devono
// sopravvivere a un riavvio: una revoca da applicare, un webhook da lavorare,
// una prova di cancellazione. Una chiave di idempotenza scaduta fra cinque
// minuti non e' una di quelle.

import { INGEST_SIGNATURE_WINDOW_MS } from './ingest-model';

/**
 * Tetto alle chiavi ricordate.
 *
 * Le chiavi arrivano da fuori, quindi la mappa cresce su input altrui: senza
 * tetto e' una perdita di memoria con un altro nome. Cinquantamila coprono
 * comodamente cinque minuti di traffico vero; oltre, si butta il piu' vecchio —
 * che e' anche quello piu' vicino a scadere da solo.
 */
const MAX_KEYS = 50_000;

const visti = new Map<string, number>();

/** Butta via tutto. Serve ai test, che devono partire senza memoria. */
export function clearIngestReplayMemory(): void {
  visti.clear();
}

function prune(now: number): void {
  for (const [key, scadenza] of visti) {
    if (scadenza <= now) visti.delete(key);
  }
  while (visti.size >= MAX_KEYS) {
    const piuVecchio = visti.keys().next();
    if (piuVecchio.done) break;
    visti.delete(piuVecchio.value);
  }
}

/**
 * Prende in carico una chiave di idempotenza, o dice che era gia' passata.
 *
 * `true` = e' la prima volta e la richiesta puo' proseguire. `false` = si e'
 * gia' vista, ed e' una ripetizione.
 *
 * La credenziale entra nella chiave insieme all'idempotenza: due negozi che
 * scelgono per caso la stessa etichetta non devono bloccarsi a vicenda, e
 * lasciare che succeda vorrebbe dire che chiunque puo' far rifiutare le
 * scritture altrui indovinando una stringa.
 *
 * Si ricorda per la durata della finestra e non di piu': oltre, a rifiutare
 * basta la finestra stessa, e continuare a tenere la chiave sarebbe memoria
 * spesa per una risposta che si sa gia'.
 */
export function claimIdempotencyKey(
  keyId: string,
  idempotencyKey: string,
  now: number = Date.now(),
  window: number = INGEST_SIGNATURE_WINDOW_MS,
): boolean {
  prune(now);

  const chiave = `${keyId}:${idempotencyKey}`;
  const scadenza = visti.get(chiave);
  if (scadenza != null && scadenza > now) return false;

  visti.set(chiave, now + window);
  return true;
}
