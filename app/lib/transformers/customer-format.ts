/**
 * I due campi del cliente che vanno scritti come li vogliono le piattaforme
 * pubblicitarie, non come li restituisce Shopify.
 *
 * Meta e Google confrontano i clienti del negozio con i propri utenti passando
 * per un hash: se il testo di partenza non e' identico al loro, l'hash e'
 * diverso e la corrispondenza non avviene. Non c'e' un errore da nessuna parte
 * — semplicemente il pubblico risulta piu' piccolo di quello che e', e nessuno
 * capisce perche'. Per questo la normalizzazione sta qui e non "poi, a valle":
 * a valle ognuno la farebbe a modo suo.
 */

/**
 * Il numero di telefono in sole cifre: prefisso internazionale e numero, senza
 * `+`, spazi, trattini o parentesi.
 *
 * Shopify lo restituisce in forma leggibile ("+39 333 123 4567"). Quella forma
 * e' giusta da mostrare e sbagliata da confrontare.
 *
 * Il prefisso non si inventa: un numero salvato senza resta senza. Aggiungerne
 * uno per somiglianza — "sembra italiano" — produrrebbe corrispondenze con
 * persone che non sono quelle.
 */
export function normalizePhone(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/**
 * La data di nascita come `YYYYMMDD`, senza separatori.
 *
 * Accetta le forme in cui puo' arrivare da un metafield — `1985-04-23`,
 * `23/04/1985`, o gia' compatta — e ne restituisce una sola. Quello che non e'
 * una data riconoscibile torna null: una data sbagliata nel pubblico e' peggio
 * di una data assente, perche' la seconda si vede e la prima no.
 */
export function normalizeBirthdate(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;

  // Gia' compatta.
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return valid(compact[1], compact[2], compact[3]);

  // ISO, con qualunque separatore: 1985-04-23, 1985/04/23.
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (iso) return valid(iso[1], iso[2], iso[3]);

  // Giorno per primo: 23/04/1985. L'anno a quattro cifre in coda e' quello che
  // distingue questa forma dalla precedente, quindi non c'e' da indovinare.
  const dayFirst = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (dayFirst) return valid(dayFirst[3], dayFirst[2], dayFirst[1]);

  return null;
}

/**
 * Una data esiste davvero, o null.
 *
 * Il 31 febbraio passa qualunque controllo fatto sui soli intervalli: si
 * ricostruisce la data e si guarda se il giorno e' rimasto quello chiesto.
 */
function valid(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }

  return `${year}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}
