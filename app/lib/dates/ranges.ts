/**
 * Periodi, come li sceglie chi guarda i numeri.
 *
 * Nessuno apre un calendario per chiedere "gli ultimi 30 giorni": lo pensa
 * gia' come una cosa sola, e cercarne l'inizio e la fine e' lavoro che la
 * macchina puo' fare al posto suo. Il calendario resta per le domande che
 * davvero hanno due date.
 *
 * Tutto qui dentro lavora in date di calendario (`AAAA-MM-GG`) e in UTC: sono
 * le stesse che finiscono nelle query, e passare per l'ora locale del browser
 * farebbe scivolare un giorno a chi guarda dopo mezzanotte.
 */

export interface DateRange {
  /** Primo giorno compreso. */
  from: string;
  /** Ultimo giorno compreso. */
  to: string;
}

export type PresetId =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'last90'
  | 'monthToDate'
  | 'quarterToDate'
  | 'yearToDate'
  | 'lastMonth'
  | 'lastQuarter'
  | 'lastYear'
  | 'custom';

export function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function fromIso(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Quanti giorni copre un intervallo, estremi compresi. */
export function lengthInDays(range: DateRange): number {
  const ms = fromIso(range.to).getTime() - fromIso(range.from).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfQuarter(date: Date): Date {
  const quarter = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), quarter, 1));
}

function startOfYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function endOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

/**
 * L'intervallo di un periodo predefinito.
 *
 * "Ultimi 30 giorni" comprende oggi: e' quello che si aspetta chi lo sceglie a
 * meta' giornata, e escluderlo farebbe sparire gli ordini appena arrivati.
 */
export function presetRange(preset: PresetId, now: Date = new Date()): DateRange | null {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  switch (preset) {
    case 'today':
      return { from: iso(today), to: iso(today) };
    case 'yesterday': {
      const day = shiftDays(today, -1);
      return { from: iso(day), to: iso(day) };
    }
    case 'last7':
      return { from: iso(shiftDays(today, -6)), to: iso(today) };
    case 'last30':
      return { from: iso(shiftDays(today, -29)), to: iso(today) };
    case 'last90':
      return { from: iso(shiftDays(today, -89)), to: iso(today) };
    case 'monthToDate':
      return { from: iso(startOfMonth(today)), to: iso(today) };
    case 'quarterToDate':
      return { from: iso(startOfQuarter(today)), to: iso(today) };
    case 'yearToDate':
      return { from: iso(startOfYear(today)), to: iso(today) };
    case 'lastMonth': {
      const previous = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      return { from: iso(previous), to: iso(endOfMonth(previous)) };
    }
    case 'lastQuarter': {
      const start = startOfQuarter(today);
      const previous = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 3, 1));
      const end = new Date(Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth() + 3, 0));
      return { from: iso(previous), to: iso(end) };
    }
    case 'lastYear': {
      const year = today.getUTCFullYear() - 1;
      return { from: iso(new Date(Date.UTC(year, 0, 1))), to: iso(new Date(Date.UTC(year, 11, 31))) };
    }
    case 'custom':
      return null;
  }
}

/**
 * Il periodo scelto, riconosciuto fra quelli predefiniti.
 *
 * Serve a riaprire la tendina sulla voce giusta: chi ha scelto "Ultimi 30
 * giorni" e riapre deve ritrovare quella evidenziata, non "Intervallo
 * personalizzato" con le stesse due date dentro.
 */
export function matchPreset(range: DateRange, now: Date = new Date()): PresetId {
  const candidates: PresetId[] = [
    'today',
    'yesterday',
    'last7',
    'last30',
    'last90',
    'monthToDate',
    'quarterToDate',
    'yearToDate',
    'lastMonth',
    'lastQuarter',
    'lastYear',
  ];

  for (const preset of candidates) {
    const found = presetRange(preset, now);
    if (found && found.from === range.from && found.to === range.to) return preset;
  }
  return 'custom';
}

export type ComparisonId = 'none' | 'previousPeriod' | 'previousYear' | 'previousYearWeekday';

/**
 * Il periodo con cui confrontare.
 *
 * `previousPeriod` e' lungo uguale e finisce il giorno prima: e' il confronto
 * che risponde a "sta salendo?". `previousYear` sposta indietro di un anno le
 * stesse date, e serve a chi vende cose che dipendono dalla stagione.
 *
 * `previousYearWeekday` sposta di 52 settimane invece che di un anno: cade
 * sullo stesso giorno della settimana, e per un negozio che vende molto di piu'
 * nel fine settimana e' l'unico confronto che non mette a paragone un sabato
 * con un mercoledi'.
 */
export function comparisonRange(
  range: DateRange,
  comparison: ComparisonId,
  now: Date = new Date(),
): DateRange | null {
  if (comparison === 'none') return null;

  const from = fromIso(range.from);
  const to = fromIso(range.to);

  if (comparison === 'previousPeriod') {
    const days = lengthInDays(range);
    const end = shiftDays(from, -1);
    return { from: iso(shiftDays(end, -(days - 1))), to: iso(end) };
  }

  if (comparison === 'previousYearWeekday') {
    // 364 giorni = 52 settimane esatte.
    return { from: iso(shiftDays(from, -364)), to: iso(shiftDays(to, -364)) };
  }

  const back = (date: Date) =>
    new Date(Date.UTC(date.getUTCFullYear() - 1, date.getUTCMonth(), date.getUTCDate()));
  void now;
  return { from: iso(back(from)), to: iso(back(to)) };
}

/**
 * L'etichetta del comando: una data sola quando il periodo e' un giorno.
 *
 * "1 ago 2026 – 1 ago 2026" dice due volte la stessa cosa e costringe a
 * leggerle entrambe per accorgersene.
 */
export function formatRange(range: DateRange, locale: string): string {
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  };
  const format = new Intl.DateTimeFormat(locale, options);
  const from = format.format(fromIso(range.from));
  if (range.from === range.to) return from;
  return `${from} – ${format.format(fromIso(range.to))}`;
}

/** Le due date in ordine, comunque il calendario le abbia consegnate. */
export function orderRange(a: string, b: string): DateRange {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}
