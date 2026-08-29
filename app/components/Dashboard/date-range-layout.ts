/**
 * Il conto delle larghezze della tendina del periodo.
 *
 * Serve a una cosa sola: accorgersi qui, e non a schermo, che il calendario non
 * ci sta piu'. Il difetto che questo previene si vedeva come una barra di
 * scorrimento orizzontale in fondo alla tendina — cioe' un pezzo di calendario
 * fuori dal riquadro, che il popover di Polaris taglia con `overflow: hidden` —
 * e nasceva da una somma sbagliata di poche decine di pixel: nessuno la
 * rifaceva cambiando la misura di una casella.
 *
 * Le misure vere stanno in `dashboard.css`, che e' l'unico posto dove hanno
 * effetto. Qui c'e' solo l'aritmetica, e il test le legge di la' e le passa a
 * queste funzioni: cambiando una variabile nel foglio di stile senza rifare il
 * conto, il test cade.
 */

/** Le misure dichiarate, in pixel CSS. */
export interface PickerWidths {
  /** La larghezza della tendina sul desktop. */
  root: number;
  /** La colonna dei periodi. */
  sidebar: number;
  /** Il margine interno del corpo, per lato. */
  bodyPadding: number;
  /** Il lato di una casella del calendario. */
  day: number;
  /** Mezzo stacco fra i due mesi: ce n'e' uno per lato del divisore. */
  gutter: number;
  /** Il divisore verticale fra i due mesi. */
  divider: number;
}

/** Quanto e' largo un mese: sette caselle, niente altro. */
export function monthWidth(widths: Pick<PickerWidths, 'day'>): number {
  return widths.day * 7;
}

/**
 * Sotto questa larghezza un mese non ci sta piu' nella sua meta'.
 *
 * E' la soglia che fa impilare i due mesi invece di tagliarli: il mese piu' il
 * mezzo stacco che gli sta accanto.
 */
export function monthMinWidth(widths: Pick<PickerWidths, 'day' | 'gutter'>): number {
  return monthWidth(widths) + widths.gutter;
}

export interface CalendarBudget {
  /** Lo spazio che il corpo lascia al calendario. */
  available: number;
  /** Lo spazio che i due mesi chiedono. */
  required: number;
  /** Quello che avanza. Negativo vuol dire che qualcosa esce dal riquadro. */
  slack: number;
  fits: boolean;
}

/**
 * Il conto che deve tornare.
 *
 * Da sinistra: la tendina meno la colonna dei periodi da' il corpo, il corpo
 * meno i suoi due margini da' il calendario. Dall'altra parte i due mesi, i due
 * mezzi stacchi e il filo del divisore. La differenza fra i due numeri e'
 * tutto quello che c'e' da sapere.
 */
export function calendarBudget(widths: PickerWidths): CalendarBudget {
  const available = widths.root - widths.sidebar - widths.bodyPadding * 2;
  const required = monthWidth(widths) * 2 + widths.gutter * 2 + widths.divider;
  const slack = available - required;
  return { available, required, slack, fits: slack >= 0 };
}

/**
 * Il calendario ci sta anche nella tendina stretta?
 *
 * Nel ripiego stretto la colonna dei periodi passa sopra, quindi il corpo vale
 * tutta la tendina: basta che un mese solo entri fra i due margini, perche' il
 * secondo va a capo.
 */
export function narrowFits(widths: PickerWidths, viewport: number): boolean {
  // La tendina non supera mai la finestra meno i suoi margini.
  const root = Math.min(widths.root, viewport - 32);
  return root - widths.bodyPadding * 2 >= monthMinWidth(widths);
}
