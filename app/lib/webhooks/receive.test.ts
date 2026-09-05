import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creaFakeWebhookStore } from './inbox-fake-store';

/**
 * Qui si prova la sola cosa che la rotta deve garantire: l'ordine.
 *
 * Firma, ricevuta, risposta — e l'elaborazione dopo la ricevuta, con il suo
 * esito che NON entra nel codice di risposta. Prima era il contrario: si faceva
 * il lavoro, si catturava l'errore e si rispondeva 200 comunque, e quel 200
 * diceva a Shopify "consegnato" per un evento che nessuno aveva applicato.
 *
 * Il negozio e la sessione sono finti, ma la posta in arrivo e i processori
 * sono quelli veri: e' l'unico modo di contare gli effetti davvero prodotti da
 * due consegne dello stesso evento.
 */

const store = creaFakeWebhookStore();
const verifyWebhook = vi.fn(() => true);
const shopFindUnique = vi.fn();
const shopUpdateMany = vi.fn();
const sessionDeleteMany = vi.fn();
const transaction = vi.fn(async (operazioni: unknown[]) => Promise.all(operazioni as never[]));

vi.mock('~/lib/webhooks/verify.server', () => ({
  verifyWebhook: (...a: unknown[]) => verifyWebhook(...(a as [])),
}));
vi.mock('~/db.server', () => ({
  prisma: {
    get webhookEvent() {
      return store;
    },
    shop: {
      findUnique: (...a: unknown[]) => shopFindUnique(...a),
      updateMany: (...a: unknown[]) => shopUpdateMany(...a),
    },
    session: { deleteMany: (...a: unknown[]) => sessionDeleteMany(...a) },
    $transaction: (...a: unknown[]) => transaction(...(a as [unknown[]])),
  },
}));

import { receiveAdminWebhook } from './receive.server';

const DOMINIO = 'negozio.myshopify.com';

function richiesta(over: { webhookId?: string | null; body?: string } = {}) {
  const headers: Record<string, string> = {
    'X-Shopify-Hmac-Sha256': 'firma-valida',
    'X-Shopify-Shop-Domain': DOMINIO,
  };
  if (over.webhookId !== null) headers['X-Shopify-Webhook-Id'] = over.webhookId ?? 'consegna-1';

  return new Request('https://app/webhooks/app/uninstalled', {
    method: 'POST',
    headers,
    body: over.body ?? JSON.stringify({ id: 1 }),
  });
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  verifyWebhook.mockReturnValue(true);
  shopFindUnique.mockResolvedValue({ id: 'shop-1' });
  shopUpdateMany.mockResolvedValue({ count: 1 });
  sessionDeleteMany.mockResolvedValue({ count: 1 });
});

describe('prima della ricevuta', () => {
  it('firma non valida → 401, e nessuna riga scritta', async () => {
    verifyWebhook.mockReturnValue(false);

    const res = await receiveAdminWebhook(richiesta(), 'app/uninstalled');

    expect(res.status).toBe(401);
    expect(store.righe).toHaveLength(0);
  });

  it('senza il dominio del negozio → 400', async () => {
    const req = new Request('https://app/webhooks/app/uninstalled', {
      method: 'POST',
      headers: { 'X-Shopify-Hmac-Sha256': 'firma-valida' },
      body: '{}',
    });

    expect((await receiveAdminWebhook(req, 'app/uninstalled')).status).toBe(400);
    expect(store.righe).toHaveLength(0);
  });

  it('corpo illeggibile → 400 e non 5xx: ritentarlo darebbe lo stesso esito', async () => {
    const res = await receiveAdminWebhook(
      richiesta({ body: 'non-e-json' }),
      'app/uninstalled',
    );

    expect(res.status).toBe(400);
    expect(store.righe).toHaveLength(0);
  });
});

describe('la ricevuta non riesce', () => {
  it('database owner non disponibile → 5xx, e nessun successo falso', async () => {
    // E' il difetto di partenza: qui si rispondeva 200, Shopify segnava l'evento
    // come consegnato e non lo ritentava mai piu'. Senza riga e senza
    // ritentativo, quell'evento non lo applicava piu' nessuno.
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'create').mockRejectedValueOnce(new Error('database irraggiungibile'));

    const res = await receiveAdminWebhook(richiesta(), 'app/uninstalled');

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.json()).not.toHaveProperty('ok');
    // Nessun effetto: il negozio non e' stato toccato.
    expect(shopUpdateMany).not.toHaveBeenCalled();
    allarme.mockRestore();
  });

  it('non lascia trapelare il corpo del webhook nel log', async () => {
    // Nel log finiscono il topic, il negozio e il motivo: non il corpo, non gli
    // header, non la firma.
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'create').mockRejectedValueOnce(new Error('database irraggiungibile'));

    await receiveAdminWebhook(
      richiesta({ body: JSON.stringify({ id: 1, segreto: 'shpat_xyz' }) }),
      'app/uninstalled',
    );

    const scritto = allarme.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(scritto).toContain(DOMINIO);
    expect(scritto).not.toContain('shpat_xyz');
    allarme.mockRestore();
  });
});

describe('dopo la ricevuta', () => {
  it('elaborazione fallita → 200 lo stesso, e il lavoro resta ritentabile', async () => {
    // La ricevuta e' scritta: il 200 e' dovuto, perche' far ritentare Shopify
    // vorrebbe dire rifiutare un evento gia' accettato. Ma l'evento NON e'
    // concluso: torna in attesa, e il drenaggio del cron ci ripassa.
    transaction.mockRejectedValueOnce(new Error('database irraggiungibile'));

    const res = await receiveAdminWebhook(richiesta(), 'app/uninstalled');

    expect(res.status).toBe(200);
    expect(store.righe).toHaveLength(1);
    expect(store.righe[0].status).toBe('queued');
    expect(store.righe[0].attempts).toBe(1);
    expect(store.righe[0].completedAt).toBeNull();
  });

  it('elaborazione riuscita → 200 con l evento concluso', async () => {
    const res = await receiveAdminWebhook(richiesta(), 'app/uninstalled');

    expect(res.status).toBe(200);
    expect(store.righe[0].status).toBe('completed');
    expect(shopUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('lo stesso webhook id due volte → una riga sola e un solo effetto', async () => {
    await receiveAdminWebhook(richiesta({ webhookId: 'consegna-1' }), 'app/uninstalled');
    const seconda = await receiveAdminWebhook(
      richiesta({ webhookId: 'consegna-1' }),
      'app/uninstalled',
    );

    expect(seconda.status).toBe(200);
    expect(await seconda.json()).toMatchObject({ duplicate: true });
    expect(store.righe).toHaveLength(1);
    // L'effetto e' uno: la presa condizionata sullo stato ferma la seconda
    // lavorazione prima che tocchi il negozio.
    expect(shopUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('una consegna ripetuta riprende il lavoro rimasto in sospeso', async () => {
    // La prima consegna ha scritto la ricevuta e poi e' morta: la seconda non
    // deve limitarsi a dire "gia' vista", deve finire quel che era rimasto.
    transaction.mockRejectedValueOnce(new Error('database irraggiungibile'));
    await receiveAdminWebhook(richiesta({ webhookId: 'consegna-1' }), 'app/uninstalled');
    expect(store.righe[0].status).toBe('queued');

    await receiveAdminWebhook(richiesta({ webhookId: 'consegna-1' }), 'app/uninstalled');

    expect(store.righe[0].status).toBe('completed');
    // Due tentativi sulla stessa riga, non due righe: il primo non ha lasciato
    // nessun effetto (la transazione e' caduta tutta), il secondo l'ha portato
    // a termine. Contare le chiamate a `updateMany` direbbe due, ma qui non
    // misurerebbe gli effetti: dentro una transazione Prisma quelle chiamate
    // non eseguono niente finche' la transazione non passa.
    expect(store.righe).toHaveLength(1);
    expect(store.righe[0].attempts).toBe(2);
  });

  it('senza l header dell id, due consegne identiche restano la stessa', async () => {
    // Un ritentativo che perde l'header non deve diventare un secondo evento:
    // l'impronta del corpo lo riconosce lo stesso.
    await receiveAdminWebhook(richiesta({ webhookId: null }), 'app/uninstalled');
    await receiveAdminWebhook(richiesta({ webhookId: null }), 'app/uninstalled');

    expect(store.righe).toHaveLength(1);
    expect(shopUpdateMany).toHaveBeenCalledTimes(1);
  });
});
