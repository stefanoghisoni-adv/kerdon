// app/lib/sync/watermark.ts
//
// Il confine incrementale: da quando rileggere Shopify, e quando si ha il
// diritto di spostarlo in avanti.
//
// COS'E' CAMBIATO E PERCHE'. Prima il confine era implicito: la corsa
// successiva cercava l'ultimo `SyncJob` con stato `completed` e ne prendeva
// `startedAt`. Due difetti, e il secondo e' quello che costava dati.
//
// 1. `completed` lo diventava anche una corsa che aveva ignorato una manciata
//    di errori. Il confine avanzava sopra risorse che nessuno aveva scritto.
// 2. "Quando la corsa e' cominciata" e "fin dove la corsa ha diritto di dire di
//    essere arrivata" venivano dalla stessa colonna, quindi non c'era modo di
//    far avanzare l'una senza l'altra.
//
// Adesso sono due cose separate: `startedAt` dice quando si e' partiti,
// `watermarkAt` dice fin dove si e' arrivati davvero — e si scrive solo se ogni
// lavoro critico e' riuscito o e' passato, nello stesso commit, a una riga di
// riparazione durevole. Chi cerca il confine cerca `watermarkAt`, non uno
// stato.

/**
 * Di quanto si rilegge all'indietro rispetto al confine.
 *
 * Due ragioni sommate in un numero solo, perche' agiscono nello stesso verso e
 * separarle darebbe l'illusione di poterne togliere una.
 *
 * La prima e' che i due orologi non sono lo stesso: `updated_at` lo scrive
 * Shopify sulle sue macchine, il confine lo scriviamo noi sulle nostre, e
 * qualche secondo di scarto basta a far cadere una modifica dalla parte
 * sbagliata.
 *
 * La seconda e' il confine stesso: una modifica avvenuta nell'istante esatto in
 * cui la corsa leggeva quella pagina puo' non essere ne' nella corsa vecchia ne'
 * in quella nuova. Sovrapporre le due finestre e' l'unico modo di non avere una
 * fessura fra loro.
 *
 * Rileggere di piu' non costa niente: sono upsert, e riscrivere una riga
 * identica e' un aggiornamento a vuoto. Rileggere di meno costa una riga persa
 * per sempre.
 */
export const WATERMARK_OVERLAP_MS = 120_000;

/**
 * Da quale istante chiedere a Shopify le modifiche.
 *
 * `checkpoint` e' il confine dell'ultima corsa che se l'e' guadagnato. Senza
 * nessuno — primo giro, oppure nessuna corsa ha ancora chiuso bene — si parte
 * dal ripiego, che e' l'istante in cui il database e' stato collegato.
 */
export function deltaFloor(checkpoint: Date | null | undefined, fallback: Date): Date {
  if (!checkpoint) return fallback;
  return new Date(checkpoint.getTime() - WATERMARK_OVERLAP_MS);
}

/**
 * Il confine che questa corsa ha diritto di scrivere.
 *
 * Di norma e' l'istante in cui e' partita — tutto cio' che e' cambiato prima e'
 * stato letto. Ma se restano risorse che il delta deve riportare, il confine
 * non le puo' scavalcare: si ferma alla piu' vecchia fra loro, cosi' la corsa
 * successiva se le ritrova davanti invece di passarci sopra.
 *
 * Non va mai in avanti oltre l'inizio della corsa e non torna indietro oltre il
 * trattenimento: e' un minimo fra due, e non c'e' un terzo caso.
 */
export function watermarkToCommit(runStartedAt: Date, holdBackTo: Date | null): Date {
  if (holdBackTo === null) return runStartedAt;
  return holdBackTo.getTime() < runStartedAt.getTime() ? holdBackTo : runStartedAt;
}

/**
 * Gli stati con cui una corsa puo' chiudersi.
 *
 * `completed_with_repairs` non e' un `completed` piu' gentile: e' lo stato in
 * cui i dati del merchant NON sono ancora allineati, e resta finche' le
 * riparazioni non sono chiuse. Nell'interfaccia si legge come parziale, e la
 * corsa torna `completed` quando l'ultima riparazione che aveva aperto si
 * chiude.
 */
export type SyncRunStatus = 'completed' | 'completed_with_repairs' | 'failed';

export function runStatusFor(repairsOpened: number): SyncRunStatus {
  return repairsOpened > 0 ? 'completed_with_repairs' : 'completed';
}

/** Gli stati in cui la corsa ha davvero scritto i dati, in tutto o in parte. */
export const SUCCESSFUL_RUN_STATUSES: readonly SyncRunStatus[] = [
  'completed',
  'completed_with_repairs',
];
