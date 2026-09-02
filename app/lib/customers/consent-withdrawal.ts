/**
 * Cosa resta di un cliente quando ritira il consenso al marketing.
 *
 * I dati di una persona finiscono nel database del merchant perche' quella
 * persona ha acconsentito: e' la sola ragione per cui ce li abbiamo messi.
 * Quando il consenso viene ritirato, quella ragione non c'e' piu' — e non e'
 * abbastanza spegnere un interruttore lasciando la riga com'era.
 *
 * Prima si scriveva solo `accepts_marketing: false`. Bastava a far rispondere
 * 403 al proxy in lettura, e sembrava sufficiente: da fuori quel cliente non si
 * poteva piu' leggere. Ma il database e' del merchant, e il merchant ci entra
 * con le sue credenziali: nome, email, telefono e indirizzo di chi si era
 * cancellato restavano li' per sempre, leggibili, esportabili, sincronizzabili
 * altrove. Un consenso ritirato che lascia intatto tutto cio' che aveva
 * autorizzato non e' un consenso ritirato.
 *
 * Ora si svuotano le colonne che identificano la persona. La riga resta, e deve
 * restare, per due motivi diversi e altrettanto pratici:
 *
 *  - il proxy decide il rifiuto leggendo `accepts_marketing` su questa riga:
 *    senza riga non c'e' niente su cui leggerlo, e una lettura che non trova
 *    nulla non e' la stessa cosa di una rifiutata;
 *  - i numeri del negozio — quanti clienti, quanto hanno speso — sono fatti del
 *    negozio, non della persona, e restano veri anche senza sapere chi fosse.
 *
 * Se la persona torna a dare il consenso, la sincronizzazione successiva
 * riscrive tutto da Shopify, che e' sempre stata la fonte: qui non si perde
 * niente che non si possa ritrovare.
 */

/**
 * Le colonne che dicono CHI e', azzerate.
 *
 * Non ci sono `total_spent`, `orders_count`, le date e lo stato: quelli
 * raccontano il negozio, non la persona. Non c'e' `shopify_customer_id`, che e'
 * la chiave con cui la riga si ritrova — e senza, ritirare il consenso due
 * volte creerebbe due righe orfane invece di aggiornare la stessa.
 */
export const WITHDRAWN_CUSTOMER_FIELDS = {
  accepts_marketing: false,
  email_address: null,
  phone_number: null,
  first_name: null,
  last_name: null,
  country: null,
  address: null,
  zipcode: null,
  region: null,
  date_of_birth: null,
  /**
   * Anche il legame col browser se ne va.
   *
   * E' l'identificativo con cui si riconosce chi torna: lasciarlo vorrebbe dire
   * poter continuare a ricollegare la persona alle sue visite dopo che ha detto
   * di no. E' esattamente cio' che ha smesso di autorizzare.
   */
  external_id: null,
  /** Note scritte dal negozio sulla persona: parlano di lei, quindi vanno via. */
  note: null,
} as const;

/**
 * Il ripiego, quando la tabella non ha tutte quelle colonne.
 *
 * Le tabelle del merchant nascono al collegamento e non cambiano da sole: una
 * creata da una versione precedente puo' non avere `date_of_birth` o
 * `external_id`, e PostgREST rifiuta l'intera update per una colonna che non
 * conosce. In quel caso la marcatura del consenso deve passare comunque —
 * altrimenti si perderebbe anche il 403, cioe' la protezione che gia'
 * funzionava — e lo svuotamento arrivera' quando la tabella sara' allineata.
 */
export const WITHDRAWN_CUSTOMER_MINIMUM = { accepts_marketing: false } as const;

/**
 * Vero quando l'errore dice "questa colonna non esiste".
 *
 * PGRST204 e' il modo di PostgREST di dirlo; il 42703 di Postgres arriva quando
 * il messaggio passa dal database senza essere tradotto.
 */
export function isUnknownColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const message = error.message ?? '';
  return (
    code === 'PGRST204' ||
    code === '42703' ||
    /could not find the .* column|column .* does not exist/i.test(message)
  );
}
