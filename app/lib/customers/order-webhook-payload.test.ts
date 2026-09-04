import { describe, it, expect } from 'vitest';
import {
  customerIdFromReceipt,
  orderIdFromReceipt,
  type WebhookOrderPayload,
} from './order-webhook-payload';

/**
 * Cosa si chiede ancora al corpo di un webhook sugli ordini.
 *
 * Quasi niente, e questo file e' molto piu' corto di quello che sostituisce.
 * Prima il payload veniva tradotto riga per riga — quantita', prezzi, sconti
 * spalmati — e scritto nel database del merchant come se fosse la fotografia
 * dell'ordine. Non lo era: il corpo REST non porta ne' la quantita' corrente ne'
 * il netto di riga, e i due valori che si scrivevano al loro posto erano
 * un'approssimazione che dopo un rimborso diventava una bugia.
 *
 * Adesso la ricevuta dice una cosa sola: quale ordine rileggere.
 */
describe('orderIdFromReceipt', () => {
  it('legge l id dell ordine', () => {
    expect(orderIdFromReceipt({ id: 5001 })).toBe(5001);
  });

  it('accetta l id come stringa: la REST lo manda in tutti e due i modi', () => {
    expect(orderIdFromReceipt({ id: '5001' })).toBe(5001);
  });

  it('su un rimborso vince order_id, non l id in cima', () => {
    // La busta di `refunds/create` e' il RIMBORSO: l'id in cima e' il suo, e
    // rileggendo quello si andrebbe a prendere un ordine che non esiste — o,
    // peggio, l'ordine di qualcun altro che per caso ha quel numero.
    const refund: WebhookOrderPayload = { id: 88001, order_id: 5001 };
    expect(orderIdFromReceipt(refund)).toBe(5001);
  });

  it('senza niente di riconoscibile non si indovina', () => {
    expect(orderIdFromReceipt({})).toBeNull();
    expect(orderIdFromReceipt(null)).toBeNull();
    expect(orderIdFromReceipt(undefined)).toBeNull();
    expect(orderIdFromReceipt({ id: null })).toBeNull();
    expect(orderIdFromReceipt({ id: '' })).toBeNull();
  });

  it('un id che non e un numero intero positivo non e un id', () => {
    // Finisce interpolato in un identificativo GraphQL: cio' che non e' un
    // numero non ci entra affatto, invece di essere ripulito dopo.
    expect(orderIdFromReceipt({ id: 'gid://shopify/Order/1' })).toBeNull();
    expect(orderIdFromReceipt({ id: -5 })).toBeNull();
    expect(orderIdFromReceipt({ id: 0 })).toBeNull();
    expect(orderIdFromReceipt({ id: 1.5 })).toBeNull();
  });
});

describe('customerIdFromReceipt', () => {
  it('legge il cliente, che serve solo a legare il browser', () => {
    expect(customerIdFromReceipt({ id: 5001, customer: { id: 77 } })).toBe(77);
  });

  it('acquisto come ospite: non c e nessun cliente', () => {
    expect(customerIdFromReceipt({ id: 5001, customer: null })).toBeNull();
    expect(customerIdFromReceipt({ id: 5001 })).toBeNull();
  });
});
