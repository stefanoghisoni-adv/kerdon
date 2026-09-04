import { netContribution } from './net-contribution';

/**
 * Profitto per cliente: quanto resta dopo il costo della merce.
 *
 * Il profitto non si salva da nessuna parte. Si tengono le righe d'ordine —
 * quanto e' stato pagato, quanti pezzi — e il costo si legge dai prodotti nel
 * momento in cui si guarda. E' questa la ragione per cui compilare un costo
 * mancante oggi riscrive la storia di ieri: il merchant che installa l'app con
 * meta' catalogo senza costi vede numeri parziali, e appena li completa vede
 * quelli veri, senza che nessuno ricalcoli niente.
 *
 * Il rovescio, che va detto: il costo di oggi vale anche per un ordine di sei
 * mesi fa. Il margine storico esatto — il costo di allora — richiederebbe di
 * congelarlo nella riga, e allora l'aggiornamento retroattivo non ci sarebbe
 * piu'. Le due cose non stanno insieme, e qui si e' scelta la seconda.
 */

export interface OrderLine {
  /** Le unita' ancora in mano al cliente: rimborsi e rimozioni gia' tolti. */
  currentQuantity: number;
  /** Il netto della riga come lo dichiara Shopify. null = non ancora letto. */
  lineNetTotal: number | null;
  /** Costo unitario del prodotto, oggi. null = non ancora compilato. */
  unitCost: number | null;
}

export interface Order {
  /** Quando l'ordine e' stato fatto. */
  placedAt: Date;
  lines: OrderLine[];
}

export interface ProfitTotals {
  /** Somma dei contributi netti sulle sole righe misurabili. */
  profit: number;
  /** Quante righe hanno concorso al totale. */
  coveredLines: number;
  /** Quante righe esistono in tutto: la differenza e' cio' che manca. */
  totalLines: number;
}

/**
 * Il profitto di un elenco di righe.
 *
 * Le righe senza costo — e quelle senza netto, che sono le righe non ancora
 * rilette da Shopify — restano fuori dal totale invece di entrarci come zero: un prodotto senza costo compilato non ha profitto "pari al prezzo", ha
 * profitto ignoto. Contarlo intero gonfierebbe il numero proprio nel caso in cui
 * il merchant si fida di meno — appena installata l'app, con i costi ancora da
 * riempire.
 */
export function linesProfit(lines: OrderLine[]): ProfitTotals {
  let profit = 0;
  let coveredLines = 0;

  for (const line of lines) {
    // La stessa formula dell'SQL, presa dallo stesso posto: due definizioni
    // dello stesso margine sono due margini, e il giorno in cui divergono lo
    // scoprira' il merchant guardando due schermate.
    const contribution = netContribution(line);
    if (contribution === null) continue;
    profit += contribution;
    coveredLines += 1;
  }

  return {
    // Ai centesimi: la somma di molti prodotti in virgola mobile lascia code
    // che poi si vedono in tabella.
    profit: Math.round(profit * 100) / 100,
    coveredLines,
    totalLines: lines.length,
  };
}

export interface CustomerMetrics extends ProfitTotals {
  orders: number;
  /** Profitto medio per ordine. null senza ordini: non e' zero, non esiste. */
  averageOrderProfit: number | null;
}

/**
 * I numeri di un cliente su un insieme di ordini.
 *
 * "Lifetime" o "ultimi tre mesi" e' solo questione di quali ordini si passano:
 * la funzione non sa e non deve sapere di che periodo si tratti.
 */
export function customerMetrics(orders: Order[]): CustomerMetrics {
  const totals = linesProfit(orders.flatMap((order) => order.lines));

  return {
    ...totals,
    orders: orders.length,
    averageOrderProfit:
      orders.length === 0 ? null : Math.round((totals.profit / orders.length) * 100) / 100,
  };
}

/** Il mese di una data, come chiave ordinabile: "2026-08". */
export function monthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Gli ordini divisi per mese di calendario.
 *
 * Mesi veri e non finestre di trenta giorni: il merchant ragiona per mesi, e un
 * confronto fra "gli ultimi 30 giorni" e "i 30 prima" cade a meta' di entrambi.
 */
export function ordersByMonth(orders: Order[]): Map<string, Order[]> {
  const months = new Map<string, Order[]>();

  for (const order of orders) {
    const key = monthKey(order.placedAt);
    const bucket = months.get(key);
    if (bucket) bucket.push(order);
    else months.set(key, [order]);
  }

  return new Map([...months.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Di quanto e' cambiato un valore rispetto a prima, in percentuale.
 *
 * `null` quando il confronto non si puo' fare: senza un mese precedente, e
 * quando prima era zero — da zero qualunque aumento sarebbe "infinito per
 * cento", che non dice niente. In quei casi la tabella mostra il numero e
 * basta, senza colore.
 */
export function variation(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/**
 * Il mese in corso non si confronta.
 *
 * A meta' mese il totale e' meta' di quello che sara': messo accanto al mese
 * chiuso di prima direbbe sempre "in calo", e sarebbe una bugia che si corregge
 * da sola l'ultimo giorno. Si confronta solo cio' che e' finito.
 */
export function isMonthClosed(month: string, now: Date): boolean {
  return month < monthKey(now);
}
