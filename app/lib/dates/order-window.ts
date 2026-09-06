/**
 * Il periodo scelto, tradotto nei due confini che le query confrontano.
 *
 * `todayIn` ha sistemato meta' del problema: QUALE giorno il negozio stia
 * guardando. Questa e' l'altra meta': DOVE comincia e dove finisce quel giorno.
 * Le due meta' vivevano separate, e separate non tornavano — la dashboard
 * sceglieva "oggi" nel fuso del negozio e poi lo chiedeva al database con dei
 * confini che quel fuso non lo conoscevano.
 *
 * UNA VOLTA SOLA, come per `net-contribution`. Il filtro sul periodo era
 * riscritto a mano in cinque query: due nella tab Clienti, la card del
 * profitto, le medie, i prodotti che rendono. Cinque copie sono cinque
 * occasioni perche' una resti indietro, e quando restano indietro il merchant
 * vede due totali diversi nella stessa schermata senza un modo per capire quale
 * dei due sia quello vero.
 *
 * SEMIAPERTO, `[from, toExclusive)`, e non "fino alla fine del giorno". Un
 * `<= 23:59:59` perde gli ordini dell'ultimo secondo e, appena la colonna
 * guadagna i millisecondi, ne perde mille volte tanti; un `<=` sulla mezzanotte
 * del giorno dopo conterebbe due volte l'ordine fatto esattamente allo scoccare
 * — una volta in questo periodo e una nel prossimo, e la somma di due mesi non
 * farebbe piu' l'anno. L'istante finale appartiene al giorno dopo, e basta.
 *
 * MAI VENTIQUATTRO ORE IN MILLISECONDI per arrivare al giorno dopo. Il giorno
 * del passaggio all'ora legale dura ventitre' ore, quello del ritorno
 * venticinque: sommare 86.400.000 ms fa finire il confine un'ora dentro il
 * giorno sbagliato, e proprio in una delle due domeniche dell'anno in cui il
 * merchant guarda i numeri con piu' attenzione. Il giorno dopo si ottiene sul
 * calendario — 29 marzo + 1 = 30 marzo — e solo dopo si chiede al fuso a che
 * istante cominci.
 *
 * IL FUSO NON ENTRA MAI NELL'SQL. La Management API che esegue queste query non
 * accetta parametri: l'istruzione si compone come testo, e ogni valore che
 * arriva da fuori sarebbe una porta aperta. Qui la porta non c'e' proprio — il
 * nome del fuso serve a fare i conti in TypeScript e si ferma li'; nella query
 * finiscono solo due date e due orari, cifre generate da noi. Un fuso che l'ICU
 * non riconosce non arriva nemmeno a quei conti: si ripiega su UTC e lo si
 * scrive nel log.
 *
 * PERCHE' IL CONFINE SI SCRIVE COME `TIMESTAMP` E NON COME ISTANTE. Nel
 * database del merchant `orders.placed_at` e' un `TIMESTAMP` senza fuso, e ci
 * arriva la `createdAt` di Shopify — che porta con se' lo scostamento del
 * negozio (`2026-08-27T09:12:00+02:00`). Postgres, scrivendo in una colonna
 * senza fuso, quello scostamento lo butta via: dentro resta l'ora di parete del
 * negozio. I confini quindi si scrivono nella stessa forma, cioe' gli istanti
 * riletti nel fuso del negozio. Il giro puo' sembrare inutile — la mezzanotte
 * locale riscritta in locale e' la mezzanotte locale — ma e' cio' che rende
 * l'intervallo una cosa sola: definito una volta come coppia di istanti (ed e'
 * li' che l'ora legale viene gestita), reso poi nella forma che la colonna
 * parla. Il giorno in cui quella colonna diventasse un `TIMESTAMPTZ`, a cambiare
 * sarebbe soltanto la resa qui sotto.
 */

import { isCalendarDate, type DateRange } from './ranges';

export interface OrderWindow {
  /** Primo istante compreso nel periodo. */
  fromUtc: Date;
  /** Primo istante ESCLUSO: la mezzanotte che apre il giorno dopo l'ultimo. */
  toExclusiveUtc: Date;
  /** Il fuso con cui i confini sono stati calcolati. 'UTC' quando si e' ripiegato. */
  timeZone: string;
  /** Perche' si e' ripiegato su UTC, quando e' successo. null = fuso del negozio. */
  fallback: 'missing' | 'invalid' | null;
}

/**
 * La forma che un nome di fuso puo' avere.
 *
 * Non e' la verifica vera — quella la fa l'ICU un attimo dopo — ma toglie di
 * mezzo prima tutto cio' che di un fuso non ha nemmeno l'aspetto: apici, punti
 * e virgola, spazi. Sono anche i caratteri con cui si scrive SQL dentro l'SQL
 * altrui, e per quanto qui il nome non arrivi mai a una query, una difesa che
 * dipende da dove finisce il valore e' una difesa che smette di valere il
 * giorno in cui il valore finisce altrove.
 */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/**
 * Il fuso esiste davvero?
 *
 * L'elenco contro cui si controlla e' quello dell'ICU, non uno nostro scritto a
 * mano: un elenco nostro andrebbe aggiornato a ogni fuso che cambia nome
 * (Europe/Kiev diventato Europe/Kyiv, e prima ancora Asia/Calcutta) e i negozi
 * che si chiamano ancora nel modo vecchio finirebbero su UTC pur avendo un fuso
 * validissimo — cioe' con i giorni spostati di ore. `Intl.supportedValuesOf`
 * NON va bene per questo: elenca i soli nomi canonici della versione di ICU
 * installata, e su un runtime un po' indietro rifiuterebbe proprio i nomi
 * nuovi. Chi accetta un fuso e' chi poi ci deve lavorare.
 */
export function isSupportedTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !ZONE_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Un formattatore per fuso, tenuto da parte.
 *
 * Costruirne uno costa: e' l'apertura del database dei fusi. Le query di una
 * dashboard ne chiedono quattro o cinque a colpo, sempre per lo stesso negozio.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // `h23` e non `hour12: false`: senza, certi runtime scrivono "24" per la
      // mezzanotte, e 24 non e' un'ora che esista in nessun conto.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Che ora segna quell'istante su un orologio appeso al muro, in quel fuso. */
function wallClockAt(instant: Date, timeZone: string): WallClock {
  const read: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') read[part.type] = Number(part.value);
  }
  return {
    year: read.year,
    month: read.month,
    day: read.day,
    // Cintura oltre alle bretelle di `hourCycle`: una mezzanotte scritta 24
    // farebbe scivolare il confine di un giorno intero.
    hour: read.hour === 24 ? 0 : read.hour,
    minute: read.minute,
    second: read.second,
  };
}

/** L'ora di parete presa alla lettera, come se fosse gia' un istante UTC. */
function asUtcMillis(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
}

/** Di quanto quel fuso e' avanti su UTC, in quel preciso istante. */
function offsetAt(millis: number, timeZone: string): number {
  return asUtcMillis(wallClockAt(new Date(millis), timeZone)) - millis;
}

/**
 * L'istante in cui comincia un giorno di calendario, in un fuso.
 *
 * Non basta togliere "lo scostamento del fuso", perche' lo scostamento dipende
 * dall'istante che si sta cercando: e' il cane che si morde la coda, e i due
 * giorni all'anno in cui si morde davvero sono quelli dell'ora legale. Si
 * prova, si ricontrolla, e si tiene il tentativo che rimette in piedi la
 * mezzanotte chiesta.
 *
 * Quando nessuno dei due la rimette in piedi, quella mezzanotte NON ESISTE: ci
 * sono fusi che spostano l'orologio proprio a mezzanotte (Santiago, Beirut, e
 * L'Avana all'incontrario), e il 6 settembre a Santiago va dalle 00:00 alle
 * 01:00 senza passare per la mezzanotte. Il giorno comincia allora nell'istante
 * del salto — il primo che quel giorno abbia davvero — invece che un'ora prima,
 * cioe' dentro il giorno precedente. All'incontrario, quando la mezzanotte
 * esiste due volte, si prende la prima: e' quella che apre il giorno.
 */
function startOfDayUtc(day: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, date);

  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  const firstFits = first + offsetAt(first, timeZone) === wall;
  const secondFits = second + offsetAt(second, timeZone) === wall;

  if (firstFits && secondFits) return new Date(Math.min(first, second));
  if (firstFits) return new Date(first);
  if (secondFits) return new Date(second);
  return new Date(Math.max(first, second));
}

/**
 * Il giorno dopo, sul calendario.
 *
 * Il 31 agosto + 1 e' il primo settembre, e il 28 febbraio di un bisestile e' il
 * 29: e' aritmetica di calendario su un'etichetta, non su un istante, quindi
 * l'ora legale non c'entra e non puo' entrarci. E' l'unico modo giusto di
 * arrivare al confine di destra.
 */
function nextDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

/**
 * Il fuso da usare davvero, e la nota per il log quando non e' quello del
 * negozio.
 *
 * Il ripiego e' UTC, esplicito: e' quello che l'app faceva prima di sapere i
 * fusi, quindi non sposta i numeri di nessuno da un giorno all'altro. Ma non e'
 * silenzioso — un negozio che conta i giorni in UTC mostra numeri che non
 * tornano con il suo pannello Shopify, e senza una riga di log nessuno saprebbe
 * mai perche'.
 */
function resolveTimeZone(timeZone: string | null | undefined): {
  timeZone: string;
  fallback: OrderWindow['fallback'];
} {
  if (timeZone == null || timeZone === '') {
    console.warn(
      '[order-window] negozio senza fuso orario: i giorni si contano in UTC, ' +
        'e i totali possono non coincidere con quelli del pannello Shopify',
    );
    return { timeZone: 'UTC', fallback: 'missing' };
  }

  if (!isSupportedTimeZone(timeZone)) {
    console.warn(
      `[order-window] fuso orario non riconosciuto (${String(timeZone).slice(0, 64)}): ` +
        'i giorni si contano in UTC',
    );
    return { timeZone: 'UTC', fallback: 'invalid' };
  }

  return { timeZone, fallback: null };
}

/**
 * I confini del periodo, per il negozio che li sta guardando.
 *
 * Le due date sono giorni di calendario, estremi compresi, come li sceglie chi
 * usa il selettore: `to` e' l'ultimo giorno DENTRO il periodo, e diventa qui il
 * primo istante FUORI.
 *
 * Una data che non e' una data non arriva ai conti: si rifiuta prima, invece di
 * ripulirla dopo. E' la stessa regola di sempre sulle query del merchant, con
 * in piu' che qui vale anche per chi non fa query.
 */
export function orderWindow(
  range: DateRange,
  timeZone: string | null | undefined,
): OrderWindow {
  if (!isCalendarDate(range.from)) throw new Error(`Data non valida: ${range.from}`);
  if (!isCalendarDate(range.to)) throw new Error(`Data non valida: ${range.to}`);

  const zone = resolveTimeZone(timeZone);

  return {
    fromUtc: startOfDayUtc(range.from, zone.timeZone),
    toExclusiveUtc: startOfDayUtc(nextDay(range.to), zone.timeZone),
    timeZone: zone.timeZone,
    fallback: zone.fallback,
  };
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

/** L'istante nella forma in cui la colonna lo tiene: l'ora di parete del negozio. */
function columnLiteral(instant: Date, timeZone: string): string {
  const clock = wallClockAt(instant, timeZone);
  return (
    `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)} ` +
    `${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}`
  );
}

/**
 * La condizione sul periodo, pronta da innestare in una query.
 *
 * Le cinque query che filtrano per periodo prendono la loro riga da qui e non
 * la scrivono piu': e' l'unico modo perche' profitto, medie, clienti e prodotti
 * che rendono parlino dello stesso arco di tempo. Chi la usa passa il fuso del
 * negozio — quello che sta gia' sulla riga `shops` — e non deve sapere altro.
 */
export function placedAtWindowSQL(
  range: DateRange,
  timeZone: string | null | undefined,
  column = 'o.placed_at',
): string {
  const window = orderWindow(range, timeZone);
  const from = columnLiteral(window.fromUtc, window.timeZone);
  const toExclusive = columnLiteral(window.toExclusiveUtc, window.timeZone);

  return `${column} >= TIMESTAMP '${from}'\n  AND ${column} < TIMESTAMP '${toExclusive}'`;
}
