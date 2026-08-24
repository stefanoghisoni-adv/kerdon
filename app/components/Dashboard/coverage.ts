/**
 * Quanta parte di un insieme e' utilizzabile.
 *
 * La differenza che questo file esiste per tenere ferma: **copertura non e'
 * consumo del piano**. "13 su 200" dice quanto del tetto e' occupato; "13 su
 * 26" dice quanta parte del catalogo e' pronta. Sono due domande diverse, e
 * mostrarle con la stessa forma le faceva leggere come una sola — con il
 * risultato che un catalogo per meta' incompleto sembrava un piano quasi vuoto,
 * cioe' una buona notizia.
 */

export interface Coverage {
  /** Da 0 a 100. null quando non c'e' niente da coprire. */
  percent: number | null;
  ready: number;
  total: number;
  missing: number;
}

export function coverage(ready: number, total: number): Coverage {
  const missing = Math.max(total - ready, 0);
  return {
    // Senza niente da coprire non e' zero per cento: e' una domanda che non si
    // pone, e uno zero rosso su un negozio vuoto sarebbe un allarme inventato.
    percent: total <= 0 ? null : Math.round((ready / total) * 100),
    ready,
    total,
    missing,
  };
}

/**
 * Il tono con cui si scrive una copertura.
 *
 * Verde solo quando non manca niente: una copertura al 96% resta una copertura
 * incompleta, e dipingerla di verde toglie la ragione per cui la si mostra.
 */
export function coverageTone(value: Coverage): 'success' | 'warning' | undefined {
  if (value.percent == null) return undefined;
  if (value.missing === 0) return 'success';
  return 'warning';
}

export type FreshnessState = 'fresh' | 'stale' | 'never';

/**
 * Se il dato e' aggiornato, letto dalle date invece che dai minuti.
 *
 * Il merchant non vuole sapere quando e' passata l'ultima sincronizzazione:
 * vuole sapere se cio' che sta guardando e' di oggi. La soglia e' la cadenza
 * prevista dal suo piano, con un margine — una corsa che parte con qualche ora
 * di ritardo non e' un guasto, e chiamarlo tale insegnerebbe a ignorare
 * l'avviso.
 */
export function freshness(opts: {
  lastSync: Date | string | null | undefined;
  frequencyHours: number | null | undefined;
  now?: Date;
}): FreshnessState {
  if (!opts.lastSync) return 'never';

  const last = new Date(opts.lastSync).getTime();
  if (Number.isNaN(last)) return 'never';

  // Senza una cadenza nota si concede un giorno: e' la piu' lenta fra quelle
  // dei piani, quindi non accusa nessuno ingiustamente.
  const hours = opts.frequencyHours && opts.frequencyHours > 0 ? opts.frequencyHours : 24;
  const tolerance = 1.5;
  const now = (opts.now ?? new Date()).getTime();

  return now - last <= hours * tolerance * 3_600_000 ? 'fresh' : 'stale';
}
