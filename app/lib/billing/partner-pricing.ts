/**
 * Prezzo riservato ai negozi in rapporto con un partner.
 *
 * Il listino riservato registra il prezzo FINALE (19 → 14), perche' e' cosi'
 * che lo si decide e perche' una percentuale produrrebbe cifre con i decimali
 * invece di prezzi tondi. Shopify pero' vuole il prezzo di listino piu' uno
 * sconto: si sottoscrive a 19 con 5 di sconto per N cicli, e allo scadere il
 * prezzo pieno riparte da solo.
 *
 * Non e' un dettaglio implementativo indifferente: sottoscrivendo direttamente
 * a 14 il merchant resterebbe a 14 per sempre, e la durata concordata non
 * varrebbe niente.
 */

export interface PartnerPrice {
  planName: string;
  priceMonthly: number;
  priceYearly: number;
}

export type BillingInterval = 'monthly' | 'yearly';

export interface EffectivePrice {
  /** Prezzo di listino, quello che Shopify registra come ricorrente. */
  listPrice: number;
  /** Prezzo che il merchant paga finche' lo sconto e' in corso. */
  payablePrice: number;
  /** Differenza da comunicare a Shopify come sconto. 0 = nessuno sconto. */
  discountAmount: number;
  /** Per quanti cicli vale. null = per sempre. */
  discountIntervals: number | null;
}

/**
 * Prezzo effettivo di un piano per un negozio.
 *
 * Senza listino riservato, o con un prezzo riservato che non e' un risparmio,
 * si torna al listino pubblico: un "sconto" che alza il prezzo sarebbe un
 * errore di configurazione, e applicarlo alla lettera lo farebbe pagare al
 * merchant.
 */
export function effectivePrice(
  listPrice: number,
  partnerPrice: number | null | undefined,
  discountIntervals: number | null | undefined,
): EffectivePrice {
  const noDiscount: EffectivePrice = {
    listPrice,
    payablePrice: listPrice,
    discountAmount: 0,
    discountIntervals: null,
  };

  if (partnerPrice == null) return noDiscount;
  if (!Number.isFinite(partnerPrice) || partnerPrice < 0) return noDiscount;
  if (partnerPrice >= listPrice) return noDiscount;

  // Zero cicli non significa "per sempre": significa uno sconto che non vale
  // mai, ed e' quasi certamente un campo lasciato a zero per sbaglio. Meglio
  // ignorarlo che addebitare uno sconto di durata nulla.
  const intervals =
    discountIntervals == null || discountIntervals <= 0 ? null : Math.floor(discountIntervals);

  return {
    listPrice,
    payablePrice: partnerPrice,
    // Arrotondato ai centesimi: la sottrazione fra due prezzi in virgola mobile
    // produce code (19 - 14.9 = 4.100000000000001) che Shopify rifiuterebbe o,
    // peggio, accetterebbe addebitando un centesimo di troppo.
    discountAmount: Math.round((listPrice - partnerPrice) * 100) / 100,
    discountIntervals: intervals,
  };
}

/**
 * Quanti cicli scontati restano, tenuto conto di quelli gia' fatti.
 *
 * Il conteggio dei cicli sta su `shops.discount_intervals` ed e' un totale, non
 * un residuo. Passandolo tale e quale a ogni nuovo abbonamento, chi cambiava
 * piano dopo tre mesi di sconto si ritrovava altri tre mesi di sconto sul piano
 * nuovo: lo stesso accordo, concesso due volte. Bastava cambiare piano ogni tre
 * mesi per non pagare mai il prezzo pieno.
 *
 * Da quando lo sconto e' partito lo dice il primo addebito attivato del
 * negozio: e' un'approssimazione — il prezzo riservato si assegna a mano, e in
 * teoria potrebbe arrivare dopo il primo pagamento — ma sbaglia dalla parte
 * giusta, contando qualche ciclo in piu' invece che in meno.
 *
 * I cicli si contano nell'unita' dell'abbonamento che si sta creando: mesi per
 * il mensile, anni per l'annuale. Non e' una conversione fra i due, ed e'
 * voluto: "tre cicli scontati" su un annuale sono tre anni, non tre mesi.
 *
 * Restituisce null quando non c'e' un limite (sconto per sempre, o nessuno
 * sconto configurato) e 0 quando i cicli concordati sono finiti.
 */
export function remainingDiscountIntervals(
  total: number | null | undefined,
  firstActivatedAt: Date | null | undefined,
  interval: BillingInterval,
  now: Date = new Date(),
): number | null {
  if (total == null || !(total > 0)) return null;
  const limit = Math.floor(total);

  // Nessun addebito attivato: lo sconto non e' ancora cominciato, e i cicli
  // sono tutti da fare.
  if (!firstActivatedAt) return limit;

  const start = new Date(firstActivatedAt);
  if (Number.isNaN(start.getTime()) || start.getTime() > now.getTime()) return limit;

  const months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - start.getUTCMonth()) -
    // Il mese non e' compiuto finche' non si arriva allo stesso giorno.
    (now.getUTCDate() < start.getUTCDate() ? 1 : 0);

  const consumed = interval === 'yearly' ? Math.floor(months / 12) : months;

  return Math.max(0, limit - Math.max(0, consumed));
}

/** Sceglie il prezzo del ciclo di fatturazione richiesto. */
export function priceForInterval(
  price: { priceMonthly: number; priceYearly: number },
  interval: BillingInterval,
): number {
  return interval === 'yearly' ? price.priceYearly : price.priceMonthly;
}

/**
 * Etichetta del risparmio, da mostrare accanto al piano.
 *
 * In valuta e non in percentuale: i prezzi riservati sono decisi come cifre
 * tonde, e una percentuale ricavata all'indietro darebbe numeri come "26,3%"
 * che non corrispondono a niente di concordato.
 *
 * L'importo arriva gia' scritto (`formatMoneyExact`): quale valuta e quali
 * convenzioni usare lo sa chi ha in mano il negozio, non questa funzione.
 */
export function savingBadge(price: EffectivePrice, amount: string): string | null {
  if (price.discountAmount <= 0) return null;
  return `− ${amount}`;
}
