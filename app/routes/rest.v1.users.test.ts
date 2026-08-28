import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const resolveShopReadContext = vi.fn();
vi.mock('~/lib/read-proxy/context.server', () => ({ resolveShopReadContext }));
// Stesso ordine del vero `extractReadProxyToken`: prima Authorization, poi
// apikey. Il template li manda sempre tutti e due.
vi.mock('~/lib/read-proxy/token.server', () => ({
  extractReadProxyToken: (request: Request) => {
    const auth = request.headers.get('authorization');
    const bearer = auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
    if (bearer) return bearer;
    const apikey = request.headers.get('apikey');
    return apikey && apikey.trim() ? apikey.trim() : null;
  },
}));

const recordUserSeen = vi.fn(
  async (_supabase: unknown, _visitor: Record<string, unknown>) => 'written' as const,
);
vi.mock('~/lib/tracking/users.server', () => ({
  recordUserSeen,
  supabaseFromReadContext: () => ({}) as never,
}));
vi.mock('~/lib/supabase/ensure-users-table.server', () => ({
  provisionUsersTable: vi.fn(async () => true),
}));

const { action, loader } = await import('./rest.v1.users');

const VISITATORE = 'corew_1700000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Una POST come la manda il template Writer: corpo piatto, token in entrambi gli header. */
function write(body: unknown, headers: Record<string, string> = {}) {
  return action({
    request: new Request('https://api.coreward.app/rest/v1/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: 'buono',
        Authorization: 'Bearer buono',
        Prefer: 'resolution=merge-duplicates',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  } as never) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveShopReadContext.mockResolvedValue({
    kind: 'ok',
    ctx: { shopId: 's1', canReadData: true, projectRef: 'abcdef', serviceRoleKey: 'k' },
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/rest/v1/users — la forma che il template sa mandare', () => {
  it('accetta l oggetto piatto del Writer', async () => {
    const res = await write({
      external_id: VISITATORE,
      browser: 'Safari',
      device_type: 'mobile',
    });

    expect(res.status).toBe(200);
    expect(recordUserSeen.mock.calls[0][1]).toMatchObject({
      externalId: VISITATORE,
      browser: 'Safari',
      deviceType: 'mobile',
    });
  });

  it('il token va bene sia in apikey sia in Authorization', async () => {
    // Il template li manda sempre tutti e due, e non e' modificabile.
    const res = await write({ external_id: VISITATORE }, { apikey: '' });
    expect(res.status).toBe(200);
  });

  it('in GET non si legge: l elenco dei browser non esce da un endpoint pubblico', async () => {
    const res = (await loader()) as Response;
    expect(res.status).toBe(405);
  });
});

describe('/rest/v1/users — il corpo non viene inoltrato', () => {
  it('scarta in silenzio le colonne che non conosciamo', async () => {
    // Il proxy scrive con la chiave di servizio, che salta le RLS: inoltrare
    // l'oggetto ricevuto vorrebbe dire lasciar scrivere colonne arbitrarie con
    // i privilegi massimi.
    const res = await write({
      external_id: VISITATORE,
      browser: 'Safari',
      colonna_inventata: 'x',
      note: 'y',
    });

    expect(res.status).toBe(200);
    // In silenzio e non con un errore: un container che manda una chiave in
    // piu' non sta sbagliando niente di suo, e un errore lo fermerebbe.
    const visitor = recordUserSeen.mock.calls[0][1];
    expect(visitor).not.toHaveProperty('colonna_inventata');
    expect(visitor).not.toHaveProperty('note');
  });

  it('nessuno puo dichiarare da fuori a quale cliente appartiene un browser', async () => {
    // E' la colonna che conta: chi la scrivesse potrebbe attribuirsi gli
    // acquisti di chiunque.
    await write({ external_id: VISITATORE, shopify_customer_id: 999, merged_into: VISITATORE });

    const visitor = recordUserSeen.mock.calls[0][1];
    expect(visitor).not.toHaveProperty('shopify_customer_id');
    expect(visitor).not.toHaveProperty('merged_into');
  });

  it('i timestamp li mette il codice, non chi chiama', async () => {
    await write({ external_id: VISITATORE, last_seen_at: '1999-01-01', first_seen_at: '1999-01-01' });

    const visitor = recordUserSeen.mock.calls[0][1];
    expect(visitor).not.toHaveProperty('last_seen_at');
    expect(visitor).not.toHaveProperty('first_seen_at');
  });

  it('nelle etichette ci vanno solo stringhe', async () => {
    await write({ external_id: VISITATORE, browser: { nome: 'Safari' }, device_type: 42 });

    expect(recordUserSeen.mock.calls[0][1]).toMatchObject({ browser: null, deviceType: null });
  });
});

describe('/rest/v1/users — cosa non entra', () => {
  it('un identificativo non nostro non crea nessuna riga', async () => {
    // Una riga con dentro un valore inventato non la ritrovera' mai nessuna
    // visita successiva.
    const res = await write({ external_id: 'inventato' });
    expect(res.status).toBe(400);
    expect(recordUserSeen).not.toHaveBeenCalled();
  });

  it('senza token non si scrive nel database di nessuno', async () => {
    resolveShopReadContext.mockResolvedValue({ kind: 'unknown' });
    const res = await write({ external_id: VISITATORE });
    expect(res.status).toBe(401);
    expect(recordUserSeen).not.toHaveBeenCalled();
  });

  it('tracciamento sospeso: non si scrive', async () => {
    resolveShopReadContext.mockResolvedValue({
      kind: 'ok',
      ctx: { shopId: 's1', canReadData: false, projectRef: 'abcdef', serviceRoleKey: 'k' },
    });
    const res = await write({ external_id: VISITATORE });
    expect(res.status).toBe(403);
    expect(recordUserSeen).not.toHaveBeenCalled();
  });

  it('corpo illeggibile: 400', async () => {
    const res = await write('{non json');
    expect(res.status).toBe(400);
    expect(recordUserSeen).not.toHaveBeenCalled();
  });
});
