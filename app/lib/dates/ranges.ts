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

/**
 * Oggi per il negozio, non per il server ne' per chi guarda.
 *
 * "Oggi", "questo mese", "ultimi 30 giorni": sono tutte domande che partono da
 * un giorno solo, e quel giorno era preso in UTC. Per un negozio a Roma dopo
 * la mezzanotte "oggi" era ancora ieri; per uno a Los Angeles dopo le 16
 * "oggi" era gia' domani. Il merchant apriva la dashboard e vedeva un periodo
 * che non era quello che aveva in mente — e con esso i numeri di un altro
 * giorno.
 *
 * Il fuso e' quello che il negozio dichiara a Shopify. Quando non lo sappiamo
 * si resta su UTC: e' quello che c'era prima, ed e' meglio di un fuso
 * inventato.
 *
 * Torna un giorno di calendario (`AAAA-MM-GG`) e non una `Date` di proposito:
 * un istante porta sempre con se' un'ora, e sarebbe di nuovo l'ora sbagliata.
 * Da qui, `fromIso` per i conti e `toLocalDate` per il calendario.
 */
export function todayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  if (!timeZone) return iso(now);

  try {
    // `en-CA` scrive le date come AAAA-MM-GG, che e' gia' la forma che serve.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    // Un fuso che l'ambiente non conosce non deve spegnere la dashboard: si
    // torna a UTC, che e' il comportamento di prima.
    return iso(now);
  }
}

export function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function fromIso(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

/**
 * La stessa data, ma come la legge un calendario.
 *
 * `fromIso` mette la mezzanotte UTC: giusto per i conti, sbagliato per il
 * calendario, che di una `Date` guarda giorno, mese e anno LOCALI. A ovest di
 * Greenwich la mezzanotte UTC del primo agosto e' ancora il pomeriggio del 31
 * luglio, e il giorno acceso — con la sua etichetta letta ad alta voce — era
 * quello prima. Qui i tre numeri si costruiscono a mano, quindi nessun fuso li
 * puo' spostare: il primo agosto resta il primo agosto a Roma come a Los
 * Angeles.
 */
export function toLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Il viaggio di ritorno: una data locale, riscritta come giorno di calendario. */
export function fromLocalDate(date: Date): string {
  return iso(new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())));
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

/* ------------------------------------------------------------------------- *
 * I periodi come menu: due livelli, non un elenco solo.
 * ------------------------------------------------------------------------- */

export type SimplePresetId = Exclude<PresetId, 'custom'>;

export type Quarter = 1 | 2 | 3 | 4;

/**
 * Una voce che sceglie davvero un periodo.
 *
 * Tre forme e non una: "ultimi 7 giorni" e' sempre la stessa cosa e basta il
 * nome, mentre un trimestre e un Black Friday esistono una volta per anno e
 * senza l'anno non si sa quale. Tenerli in tre casi distinti evita l'elenco di
 * identificativi scritti a mano tipo `q3-2026`, che si sbagliano di battitura e
 * non li corregge nessuno.
 */
export type PresetLeaf =
  | { kind: 'preset'; preset: SimplePresetId }
  | { kind: 'quarter'; year: number; quarter: Quarter }
  | { kind: 'bfcm'; year: number };

/** Un identificativo stabile: serve a confrontare due voci e a dare una chiave a React. */
export function leafKey(leaf: PresetLeaf): string {
  switch (leaf.kind) {
    case 'preset':
      return `preset:${leaf.preset}`;
    case 'quarter':
      return `quarter:${leaf.year}-${leaf.quarter}`;
    case 'bfcm':
      return `bfcm:${leaf.year}`;
  }
}

/**
 * Il Black Friday di un anno, fino al Cyber Monday.
 *
 * Non e' una data fissa: il Ringraziamento e' il quarto giovedi' di novembre, il
 * Black Friday e' il giorno dopo e il fine settimana si chiude il lunedi'. Si
 * parte dal primo giovedi' del mese e si aggiungono tre settimane — cosi' il
 * conto vale anche per i novembre che cominciano di giovedi', dove il "quarto
 * giovedi'" cade il 22 e non il 29.
 */
export function bfcmRange(year: number): DateRange {
  const first = new Date(Date.UTC(year, 10, 1));
  const firstThursday = 1 + ((4 - first.getUTCDay() + 7) % 7);
  const thursday = new Date(Date.UTC(year, 10, firstThursday + 21));
  return { from: iso(shiftDays(thursday, 1)), to: iso(shiftDays(thursday, 4)) };
}

/**
 * Un trimestre di calendario, che pero' non sconfina nel futuro.
 *
 * Il trimestre in corso finisce oggi e non il 30 settembre: dare per chiuso un
 * trimestre che deve ancora finire farebbe leggere come "trimestre magro" un
 * trimestre solo cominciato. Un trimestre non ancora iniziato non esiste
 * proprio, e infatti non viene nemmeno offerto.
 */
export function quarterRange(
  year: number,
  quarter: Quarter,
  now: Date = new Date(),
): DateRange | null {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  if (start > today) return null;
  const end = new Date(Date.UTC(year, quarter * 3, 0));
  return { from: iso(start), to: iso(end > today ? today : end) };
}

/** L'intervallo di una voce, qualunque delle tre forme abbia. */
export function leafRange(leaf: PresetLeaf, now: Date = new Date()): DateRange | null {
  switch (leaf.kind) {
    case 'preset':
      return presetRange(leaf.preset, now);
    case 'quarter':
      return quarterRange(leaf.year, leaf.quarter, now);
    case 'bfcm':
      return bfcmRange(leaf.year);
  }
}

export type GroupId = 'last' | 'periodToDate' | 'bfcm' | 'quarters';

export interface PresetGroup {
  id: GroupId;
  leaves: PresetLeaf[];
}

/** Le due voci che stanno in cima e non hanno bisogno di un sottomenu. */
export const HEAD_LEAVES: PresetLeaf[] = [
  { kind: 'preset', preset: 'today' },
  { kind: 'preset', preset: 'yesterday' },
];

/** Quanti Black Friday passati offrire, e quanti trimestri gia' cominciati. */
const BFCM_YEARS = 3;
const QUARTERS_SHOWN = 4;

/**
 * I quattro gruppi del menu, con dentro le voci che oggi hanno senso.
 *
 * "Oggi hanno senso" e' la parte che cambia da sola: il Black Friday di
 * quest'anno compare solo quando e' passato — offrirlo prima vorrebbe dire
 * proporre un periodo che finisce nel futuro, cioe' delle card vuote — e i
 * trimestri sono gli ultimi quattro gia' cominciati, che a fine gennaio vuol
 * dire tre dell'anno prima e uno di questo. Gli anni si scrivono accanto
 * proprio per questo: senza, "T1" a gennaio sarebbe ambiguo.
 */
export function presetGroups(now: Date = new Date()): PresetGroup[] {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayIso = iso(today);

  const bfcm: PresetLeaf[] = [];
  for (let year = today.getUTCFullYear(); bfcm.length < BFCM_YEARS; year -= 1) {
    if (bfcmRange(year).to <= todayIso) bfcm.push({ kind: 'bfcm', year });
  }

  const quarters: PresetLeaf[] = [];
  let year = today.getUTCFullYear();
  let quarter = (Math.floor(today.getUTCMonth() / 3) + 1) as Quarter;
  while (quarters.length < QUARTERS_SHOWN) {
    quarters.push({ kind: 'quarter', year, quarter });
    if (quarter === 1) {
      quarter = 4;
      year -= 1;
    } else {
      quarter = (quarter - 1) as Quarter;
    }
  }

  return [
    {
      id: 'last',
      leaves: (
        ['last7', 'last30', 'last90', 'lastMonth', 'lastQuarter', 'lastYear'] as SimplePresetId[]
      ).map((preset) => ({ kind: 'preset', preset })),
    },
    {
      id: 'periodToDate',
      leaves: (['monthToDate', 'quarterToDate', 'yearToDate'] as SimplePresetId[]).map(
        (preset) => ({ kind: 'preset', preset }),
      ),
    },
    { id: 'bfcm', leaves: bfcm },
    { id: 'quarters', leaves: quarters },
  ];
}

/**
 * La voce che descrive davvero il periodo scelto, se ce n'e' una.
 *
 * `null` vuol dire intervallo personalizzato: non e' una voce, e' l'assenza di
 * tutte le altre. Le voci senza anno si provano per prime, perche' quando due
 * si sovrappongono — dal primo luglio a oggi e' insieme "da inizio trimestre" e
 * "il trimestre in corso" — vince quella che descrive l'intenzione piu' comune.
 */
export function matchLeaf(range: DateRange, now: Date = new Date()): PresetLeaf | null {
  const preset = matchPreset(range, now);
  if (preset !== 'custom') return { kind: 'preset', preset };

  for (const group of presetGroups(now)) {
    for (const leaf of group.leaves) {
      const found = leafRange(leaf, now);
      if (found && found.from === range.from && found.to === range.to) return leaf;
    }
  }
  return null;
}

/** In quale gruppo sta una voce: serve a evidenziare anche il capofila chiuso. */
export function groupOfLeaf(leaf: PresetLeaf, now: Date = new Date()): GroupId | null {
  const key = leafKey(leaf);
  for (const group of presetGroups(now)) {
    if (group.leaves.some((candidate) => leafKey(candidate) === key)) return group.id;
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Una data da leggere e una da scrivere.
 * ------------------------------------------------------------------------- */

/** Il giorno per esteso: "10 agosto 2026", non "2026-08-10". */
export function formatDay(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(fromIso(value));
}

/** Lo stesso giorno in cifre, nell'ordine in cui la lingua lo scrive. */
export function formatDayNumeric(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(fromIso(value));
}

/**
 * Una data qualunque, fatta a pezzi da Intl.
 *
 * Il 22 novembre e' scelto apposta: giorno e mese sono due numeri diversi e
 * nessuno dei due sta sotto il 13, quindi guardando il risultato si capisce
 * senza ambiguita' chi e' finito prima. Con il 3 aprile non si saprebbe.
 */
function numericParts(locale: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).formatToParts(new Date(Date.UTC(2026, 10, 22)));
}

/**
 * In che ordine questa lingua scrive giorno, mese e anno.
 *
 * Non c'e' una tabella da tenere aggiornata: si chiede a Intl di formattare una
 * data qualunque e si guarda in che ordine ha messo i pezzi. Aggiungendo una
 * lingua all'app, il campo impara a leggerla da solo.
 */
function numericOrder(locale: string): ('day' | 'month' | 'year')[] {
  return numericParts(locale)
    .filter((part): part is Intl.DateTimeFormatPart & { type: 'day' | 'month' | 'year' } =>
      part.type === 'day' || part.type === 'month' || part.type === 'year',
    )
    .map((part) => part.type);
}

/**
 * Il formato atteso, scritto dentro il campo vuoto.
 *
 * "GG/MM/AAAA" e non "AAAA-MM-GG": il campo mostra le date come le scrive la
 * lingua, e un segnaposto che ne annuncia un'altra insegnerebbe la forma
 * sbagliata. Ordine e separatori vengono dallo stesso Intl che formatta il
 * valore e dallo stesso ordine che `parseDay` usa per rileggerlo, quindi le tre
 * cose non possono discordare: si passano solo le tre lettere, che sono
 * l'unico pezzo che cambia da lingua a lingua e sta nel dizionario.
 */
export function dayPlaceholder(
  locale: string,
  parts: { day: string; month: string; year: string },
): string {
  return numericParts(locale)
    .map((part) =>
      part.type === 'day' || part.type === 'month' || part.type === 'year'
        ? parts[part.type]
        : part.value,
    )
    .join('');
}

/**
 * Una data battuta a macchina, riportata a giorno di calendario.
 *
 * Si accettano due scritture: quella della lingua — il segnaposto dice quale —
 * e la forma `AAAA-MM-GG`, che nessuno confonde e che chi copia una data da
 * altrove ha spesso gia' negli appunti. Qualunque segno separa i numeri: chi
 * scrive 10.8.2026 non ha sbagliato niente.
 *
 * Torna `null` per le date che non esistono. Il 31 febbraio non e' un errore di
 * battitura da correggere in silenzio: `new Date` lo trasformerebbe nel 3 marzo
 * e il periodo partirebbe da un giorno che nessuno ha chiesto.
 */
export function parseDay(text: string, locale: string): string | null {
  const trimmed = text.trim();
  const digits = trimmed.split(/\D+/).filter(Boolean);
  if (digits.length !== 3) return null;

  const numbers = digits.map(Number);
  if (numbers.some(Number.isNaN)) return null;

  let year: number;
  let month: number;
  let day: number;

  if (/^\d{4}\D/.test(trimmed)) {
    // Anno di quattro cifre in testa: e' `AAAA-MM-GG`, non c'e' altro da
    // interpretare.
    [year, month, day] = numbers;
  } else {
    const order = numericOrder(locale);
    year = numbers[order.indexOf('year')];
    month = numbers[order.indexOf('month')];
    day = numbers[order.indexOf('day')];
    // "26" vuol dire 2026: due cifre sono l'abbreviazione di questo secolo.
    if (year < 100) year += 2000;
  }

  if (year < 1000 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return iso(date);
}
