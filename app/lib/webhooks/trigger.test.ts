import { describe, it, expect } from 'vitest';
import {
  WORK_KIND_BY_TOPIC,
  distillTrigger,
  isOperationalTopic,
  readCustomerTrigger,
  readOrderTrigger,
  readProductTrigger,
} from './trigger';
import { WEBHOOK_TOPICS } from './inbox-model';

/**
 * Cosa resta di una consegna, e soprattutto cosa NON resta.
 *
 * La riga della posta in arrivo vive una settimana nel database owner, e
 * quello e' un posto che nessuna cancellazione richiesta a Shopify
 * attraversa. Se il corpo di `customers/update` finisse li' dentro, nome,
 * email, telefono e indirizzo di una persona resterebbero per una settimana
 * dove nessuno andra' mai a cercarli. Per questo la distillazione non e' una
 * ottimizzazione: e' la regola.
 */

describe('quale lavoro fa quale topic', () => {
  it('ogni topic accettato ha una famiglia di lavoro', () => {
    // Il tipo lo garantisce gia', ma un topic aggiunto all'elenco e dimenticato
    // qui e' esattamente il difetto che questo file esiste per escludere.
    for (const topic of WEBHOOK_TOPICS) {
      expect(WORK_KIND_BY_TOPIC[topic]).toBeTruthy();
    }
  });

  it('i due amministrativi non sono operativi, gli altri si', () => {
    expect(isOperationalTopic('app/uninstalled')).toBe(false);
    expect(isOperationalTopic('app_subscriptions/update')).toBe(false);
    expect(isOperationalTopic('products/update')).toBe(true);
    expect(isOperationalTopic('refunds/create')).toBe(true);
  });

  it('i tre topic degli ordini fanno lo stesso lavoro', () => {
    expect(WORK_KIND_BY_TOPIC['orders/create']).toBe('order.upsert');
    expect(WORK_KIND_BY_TOPIC['orders/updated']).toBe('order.upsert');
    expect(WORK_KIND_BY_TOPIC['refunds/create']).toBe('order.upsert');
    // La cancellazione no: li' non c'e' niente da rileggere.
    expect(WORK_KIND_BY_TOPIC['orders/delete']).toBe('order.delete');
  });
});

describe('cosa si conserva di un cliente', () => {
  const cliente = {
    id: 77,
    email: 'anna@esempio.it',
    phone: '+39 333 1234567',
    first_name: 'Anna',
    last_name: 'Rossi',
    default_address: { address1: 'Via Roma 1', city: 'Milano', zip: '20100' },
    email_marketing_consent: { state: 'subscribed' },
  };

  it("l'identificativo, e nient'altro", () => {
    expect(distillTrigger('customers/update', cliente)).toEqual({ customerId: 77 });
  });

  it('nessun dato personale sopravvive alla ricevuta', () => {
    const conservato = JSON.stringify(distillTrigger('customers/create', cliente));

    expect(conservato).not.toContain('anna@esempio.it');
    expect(conservato).not.toContain('Anna');
    expect(conservato).not.toContain('Rossi');
    expect(conservato).not.toContain('333');
    expect(conservato).not.toContain('Via Roma');
    expect(conservato).not.toContain('Milano');
  });

  it('anche la cancellazione conserva solo l identificativo', () => {
    // E' l'eccezione alla RILETTURA, non a questa regola: il cliente cancellato
    // non e' piu' leggibile, quindi l'id va conservato adesso o non lo si
    // ritrova mai piu'. Ma di dati personali non ne porta.
    expect(distillTrigger('customers/delete', cliente)).toEqual({ customerId: 77 });
  });
});

describe('cosa si conserva di un prodotto', () => {
  it('l id, non le varianti della busta', () => {
    // L'elenco delle varianti che Shopify spedisce e' troncato, e trattarlo
    // come completo significava cancellare le varianti dei prodotti piu'
    // grandi. Conservarlo servirebbe solo a farsi tentare di riusarlo.
    const conservato = distillTrigger('products/update', {
      id: 42,
      title: 'Felpa',
      variants: [{ id: 421 }, { id: 422 }],
    });

    expect(conservato).toEqual({ productId: 42 });
  });

  it('un id dato come stringa vale come un numero', () => {
    expect(distillTrigger('products/delete', { id: '99' })).toEqual({ productId: 99 });
  });
});

describe('cosa si conserva di un ordine', () => {
  const VISITATORE = 'corew_1700000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const ricevuta = {
    id: 5001,
    total_price: '119.80',
    line_items: [{ id: 9001, quantity: 2, price: '49.90' }],
    customer: { id: 77, first_name: 'Anna', email: 'anna@esempio.it' },
    note_attributes: [{ name: '_corew_external_id', value: VISITATORE }],
  };

  it("l'ordine, il cliente e il browser: i tre pezzi che servono", () => {
    expect(distillTrigger('orders/create', ricevuta)).toEqual({
      orderId: 5001,
      customerId: 77,
      externalId: VISITATORE,
    });
  });

  it('i numeri della busta non si conservano: quelli si rileggono', () => {
    const conservato = JSON.stringify(distillTrigger('orders/updated', ricevuta));

    expect(conservato).not.toContain('119.80');
    expect(conservato).not.toContain('49.90');
    expect(conservato).not.toContain('anna@esempio.it');
  });

  it('un rimborso nomina l ordine, non se stesso', () => {
    // La busta di `refunds/create` porta l'id del RIMBORSO in cima e quello
    // dell'ordine in `order_id`: prendere il primo vorrebbe dire rileggere un
    // ordine che non esiste, o peggio un ordine altrui con quel numero.
    expect(distillTrigger('refunds/create', { id: 88001, order_id: 5001 })).toMatchObject({
      orderId: 5001,
    });
  });

  it('la cancellazione non conserva il browser: non c e piu niente a cui legarlo', () => {
    expect(distillTrigger('orders/delete', ricevuta)).toEqual({
      orderId: 5001,
      customerId: null,
      externalId: null,
    });
  });

  it('un valore inventato negli attributi del carrello non passa', () => {
    const conservato = distillTrigger('orders/create', {
      ...ricevuta,
      note_attributes: [{ name: '_corew_external_id', value: '../../etc/passwd' }],
    });

    expect(conservato).toMatchObject({ externalId: null });
  });
});

describe('le buste che non nominano niente', () => {
  it('senza id non si conserva niente, e non e un guasto passeggero', () => {
    // `null` vuol dire "questa consegna non nomina nessuna risorsa": la riga si
    // scrive lo stesso e il processore la manda in lettera morta. Prima si
    // scriveva un avviso nel log e si rispondeva "ricevuto", cioe' non lo
    // sapeva piu' nessuno.
    expect(distillTrigger('products/update', { title: 'senza id' })).toBeNull();
    expect(distillTrigger('customers/create', {})).toBeNull();
    expect(distillTrigger('orders/updated', { total_price: '10' })).toBeNull();
  });

  it('un corpo che non e un oggetto non nomina niente', () => {
    expect(distillTrigger('products/create', [1, 2, 3])).toBeNull();
    expect(distillTrigger('products/create', 'ciao')).toBeNull();
    expect(distillTrigger('products/create', null)).toBeNull();
  });

  it('gli amministrativi conservano il corpo intero, e restano com erano', () => {
    // Parlano di un negozio e di un abbonamento, non di una persona, e il
    // processore dell'abbonamento del payload legge molto piu' di un id.
    const corpo = { app_subscription: { status: 'ACTIVE', name: 'Pro' } };
    expect(distillTrigger('app_subscriptions/update', corpo)).toEqual(corpo);
  });
});

describe('rileggere il trigger dalla riga', () => {
  it('si ricontrolla invece di fidarsi', () => {
    // Fra la ricevuta e il ritentativo puo' esserci passato un deploy che ha
    // cambiato la forma: una riga vecchia non deve poter far scrivere un
    // `undefined` nel database del merchant.
    expect(readProductTrigger({ id: 42 })).toBeNull();
    expect(readCustomerTrigger(null)).toBeNull();
    expect(readOrderTrigger({ orderId: 'non-un-numero' })).toBeNull();
  });

  it('quel che la ricevuta ha scritto si rilegge identico', () => {
    expect(readProductTrigger(distillTrigger('products/create', { id: 42 }))).toEqual({
      productId: 42,
    });
    expect(readCustomerTrigger(distillTrigger('customers/create', { id: 7 }))).toEqual({
      customerId: 7,
    });
    expect(
      readOrderTrigger(distillTrigger('orders/create', { id: 5001, customer: { id: 77 } })),
    ).toEqual({ orderId: 5001, customerId: 77, externalId: null });
  });
});
