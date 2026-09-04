/**
 * Il corpo di un webhook sugli ordini, letto per quello che e': una RICEVUTA.
 *
 * Dice "questo ordine e' cambiato". Non dice "questo ordine adesso e' cosi'", e
 * per un po' l'abbiamo trattato come se lo dicesse — il payload veniva tradotto
 * riga per riga e scritto nel database del merchant.
 *
 * PERCHE' NON PUO' ESSERE LA FONTE. Del corpo REST mancano esattamente i due
 * campi su cui si fa il margine. `line_items[].quantity` e' la quantita'
 * ORDINATA e dopo un reso resta quella di allora: la quantita' corrente non c'e'
 * affatto. E il netto della riga non c'e': si ricostruiva sottraendo le
 * `discount_allocations` dal listino e spalmando sulle unita', che e' una
 * moltiplicazione approssimata su una quantita' sbagliata — con dentro, per
 * giunta, allocazioni riferite a unita' rimborsate. L'ordine intanto portava
 * `current_total_price`, che i rimborsi li riflette: il totale e le sue righe
 * dicevano due cose diverse, e a sbagliare erano le righe.
 *
 * Cosi' il payload serve a UNA cosa: sapere quale ordine rileggere. Poi si fa
 * la fetch GraphQL canonica, che quei due campi ce li ha.
 *
 * E LA CHIAMATA IN PIU'? La si e' evitata a lungo perche' il webhook degli
 * ordini scatta a ogni vendita. Ma il risparmio era finto: si risparmiava una
 * lettura per scrivere numeri sbagliati, che la corsa periodica poi correggeva
 * di soppiatto — nel frattempo il merchant guardava margini gonfiati. E' la
 * stessa conclusione a cui erano arrivati i prodotti, per la stessa strada.
 *
 * COSA RESTA DEL PAYLOAD. L'identificativo dell'ordine, che e' il punto, e gli
 * attributi del carrello: da li' il riconoscimento dei visitatori tira fuori
 * l'identificativo del browser che ha riempito il carrello, e quel dato in
 * GraphQL non c'e' — la ricevuta e' l'unico posto dove passa.
 */

/** Il pezzo di payload che si guarda ancora. Del resto non si legge niente. */
export interface WebhookOrderPayload {
  id?: number | string | null;
  /**
   * L'ordine a cui si riferisce, quando la busta non e' un ordine.
   *
   * `refunds/create` manda il rimborso, non l'ordine: l'id in cima e' quello
   * del rimborso, e l'ordine da rileggere e' `order_id`. Cercare solo `id`
   * significherebbe rileggere un ordine che non esiste — o peggio, un ordine
   * altrui che per caso ha quel numero.
   */
  order_id?: number | string | null;
  /**
   * Gli attributi del carrello, che nella REST si chiamano cosi'.
   *
   * Non finiscono in nessuna colonna degli ordini: li legge il solo
   * riconoscimento dei visitatori (vedi lib/tracking/users). Sono dichiarati qui
   * perche' e' qui che il corpo del webhook e' descritto.
   */
  note_attributes?: { name?: string | null; value?: string | null }[] | null;
  /**
   * Il cliente, e serve a una cosa sola: sapere A CHI legare il browser che ha
   * comprato. Nessun campo di qui dentro finisce nel database del merchant —
   * quelli li porta la rilettura canonica.
   */
  customer?: {
    id?: number | string | null;
  } | null;
}

/** Gli id REST sono numeri, ma un payload puo' darli come stringa: si accetta. */
function toId(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * L'ordine da rileggere, secondo la ricevuta.
 *
 * `order_id` PRIMA di `id` e non il contrario: la busta di `refunds/create`
 * contiene tutti e due, e quello buono e' il primo. Un ordine ha solo `id`, e
 * per lui la precedenza non cambia niente.
 *
 * `null` quando non c'e' niente di riconoscibile: senza id non si sa cosa
 * rileggere, e non c'e' nessun ripiego che non sia indovinare.
 */
export function orderIdFromReceipt(
  payload: WebhookOrderPayload | null | undefined,
): number | null {
  if (payload == null) return null;
  return toId(payload.order_id) ?? toId(payload.id);
}

/** L'id del cliente sulla ricevuta, o null per un acquisto come ospite. */
export function customerIdFromReceipt(
  payload: WebhookOrderPayload | null | undefined,
): number | null {
  return toId(payload?.customer?.id);
}
