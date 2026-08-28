import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveShopReadContext = vi.fn();
vi.mock('~/lib/read-proxy/context.server', () => ({ resolveShopReadContext }));
vi.mock('~/lib/read-proxy/token.server', () => ({
  extractReadProxyToken: (request: Request) =>
    request.headers.get('apikey') ?? null,
}));

const { loader } = await import('./tracking.id');

const call = (headers: Record<string, string> = {}) =>
  loader({ request: new Request('https://api.coreward.app/tracking/id', { headers }) } as never);

beforeEach(() => {
  resolveShopReadContext.mockReset();
  resolveShopReadContext.mockResolvedValue({ kind: 'ok', ctx: { shopId: 's1' } });
});

describe('/tracking/id', () => {
  it('senza token non conia niente', async () => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it('token non valido: nessun identificativo', async () => {
    resolveShopReadContext.mockResolvedValue({ kind: 'unknown' });
    const res = await call({ apikey: 'sbagliato' });
    expect(res.status).toBe(401);
  });

  // Il motivo per cui questa rotta esiste: i template pronti dei container
  // leggono il corpo, non gli header.
  it('lo restituisce nel corpo, dove i template sanno leggere', async () => {
    const res = await call({ apikey: 'buono' });
    const body = JSON.parse(await res.text());
    expect(body.external_id).toMatch(/^corew_\d+_[A-Za-z0-9]{32}$/);
  });

  it('corpo, header e cookie dicono lo stesso identificativo', async () => {
    const res = await call({ apikey: 'buono' });
    const body = JSON.parse(await res.text());
    expect(res.headers.get('X-CoreW-External-Id')).toBe(body.external_id);
    expect(res.headers.get('Set-Cookie')).toContain(body.external_id);
  });

  it('se il browser ne ha gia uno si riusa quello', async () => {
    const gia = 'corew_1700000000000_abcdefghijklmnopqrstuvwxyz012345';
    const res = await call({ apikey: 'buono', Cookie: `corew_eid=${gia}` });
    const body = JSON.parse(await res.text());
    expect(body.external_id).toBe(gia);
    // Rimandarlo identico a ogni pagina sarebbe peso che non cambia niente.
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('non si mette in cache: due browser non devono ricevere lo stesso', async () => {
    const res = await call({ apikey: 'buono' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
