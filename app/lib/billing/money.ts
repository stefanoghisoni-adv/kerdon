import type { Locale } from '~/lib/i18n/locales';

/**
 * Il denaro, scritto.
 *
 * Un importo non e' mai un numero e basta: senza la valuta accanto e' una cifra
 * che ognuno legge nella propria: 29 non dice se sono euro, dollari o sterline.
 * Qui i due pezzi non si separano mai — e' l'unica difesa contro il caso in cui
 * l'app mostri un prezzo in una valuta e Shopify ne addebiti un'altra.
 */

/**
 * La valuta in cui e' scritto il listino: quella dei prezzi nella tabella
 * `plans`. Tutto il resto — i prezzi riservati, gli sconti — e' scritto in
 * questa, e un negozio con la valuta diversa la usa solo se il listino esiste
 * per intero anche nella sua.
 *
 * Dollari e non euro, e non e' una preferenza: la scheda dell'App Store accetta
 * i prezzi in USD e basta. Il merchant legge quella scheda prima di installare,
 * quindi qualunque altra valuta qui dentro produrrebbe due prezzi diversi per
 * la stessa cosa — quello dell'annuncio e quello dell'app. Con il listino in
 * dollari annuncio, card e addebito dicono la stessa cifra.
 */
export const BASE_CURRENCY = 'USD';

/**
 * Da lingua dell'app a convenzioni di scrittura.
 *
 * Non e' la stessa cosa: la lingua decide le parole, questa decide dove va il
 * simbolo e quale segno separa i decimali. In italiano si scrive "29 USD" e in
 * inglese "$29" — la stessa cifra, e in nessuna delle due l'altra forma
 * sembrerebbe scritta da chi quella lingua la parla.
 */
const NUMBER_LOCALE: Record<Locale, string> = {
  it: 'it-IT',
  en: 'en-US',
};

function formatter(currency: string, locale: Locale, fractionDigits: number): Intl.NumberFormat {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale] ?? NUMBER_LOCALE.en, {
    style: 'currency',
    currency,
    // Il simbolo, non la sigla: in italiano Intl scriverebbe "29 USD" per le
    // valute straniere, e un prezzo si legge meglio con "$" o "€" davanti alla
    // cifra che con tre lettere.
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * Il simbolo davanti, sempre.
 *
 * In italiano Intl scrive "30,95 $", che e' la convenzione tipografica giusta e
 * la cosa sbagliata da mettere in una card: l'occhio scorre una colonna di
 * numeri e arriva alla valuta per ultima, dopo aver gia' letto la cifra come se
 * fosse nella propria. Con il simbolo davanti si sa cosa si sta leggendo prima
 * di leggerlo.
 *
 * Si ricompone dai pezzi invece di concatenare a mano: separatori delle
 * migliaia, decimali e segno meno restano quelli della lingua, e cambia solo
 * dove sta il simbolo.
 */
function symbolFirst(parts: Intl.NumberFormatPart[]): string {
  const symbol = parts.find((part) => part.type === 'currency');
  if (!symbol) return parts.map((part) => part.value).join('');

  const index = parts.indexOf(symbol);
  // Lo spazio che divideva simbolo e cifra se ne va con il simbolo: senza,
  // spostando solo quello resterebbe uno spazio in fondo.
  const rest = parts.filter((part, i) => {
    if (i === index) return false;
    const adjacent = i === index - 1 || i === index + 1;
    return !(adjacent && part.type === 'literal' && part.value.trim() === '');
  });

  const spaced = parts.some(
    (part, i) =>
      (i === index - 1 || i === index + 1) &&
      part.type === 'literal' &&
      part.value.trim() === '',
  );

  // Il segno meno resta attaccato alla cifra e non al simbolo: "-$5" e' un
  // prezzo negativo, "$-5" e' un errore di stampa.
  const body = rest.map((part) => part.value).join('');
  return spaced ? `${symbol.value}\u00A0${body}` : `${symbol.value}${body}`;
}

/**
 * Un prezzo di listino.
 *
 * I centesimi compaiono solo se ci sono: "$29" e non "$29.00", perche' i
 * prezzi dei piani sono cifre tonde e i due zeri in fondo aggiungono rumore a
 * una card che deve farsi leggere in un colpo d'occhio.
 */
export function formatMoney(amount: number, currency: string, locale: Locale): string {
  return symbolFirst(
    formatter(currency, locale, Number.isInteger(amount) ? 0 : 2).formatToParts(amount),
  );
}

/**
 * Un importo esatto: sconti e risparmi, dove i centesimi si scrivono sempre.
 *
 * "$5" accanto a "$4.10" farebbe sembrare il primo un'approssimazione invece
 * di una cifra precisa, e qui si sta parlando di quanto si risparmia.
 */
export function formatMoneyExact(amount: number, currency: string, locale: Locale): string {
  return symbolFirst(formatter(currency, locale, 2).formatToParts(amount));
}
