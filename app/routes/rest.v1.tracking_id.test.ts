import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveShopReadContext = vi.fn();
vi.mock('~/lib/read-proxy/context.server', () => ({ resolveShopReadContext }));
vi.mock('~/lib/read-proxy/token.server', () => ({
  extractReadProxyToken: (request: Request) =>
    request.headers.get('apikey') ?? null,
}));

// La scrittura della riga del browser ha i suoi test in
// lib/tracking/users.server.test: qui interessa solo che questa rotta la faccia
// partire, e che non possa impedire la risposta.
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

const { loader } = await import('./rest.v1.tracking_id');

const call = (headers: Record<string, string> = {}, search = '') =>
  loader({
    request: new Request(`https://api.coreward.app/rest/v1/tracking_id${search}`, { headers }),
  } as never);

beforeEach(() => {
  resolveShopReadContext.mockReset();
  recordUserSeen.mockClear();
  resolveShopReadContext.mockResolvedValue({
    kind: 'ok',
    // `canReadData` e' la risposta della policy, e adesso questa rotta la
    // guarda come le altre tre di /rest/v1/: prima era l'unica a non farlo.
    ctx: { shopId: 's1', canReadData: true, projectRef: 'abcdef', serviceRoleKey: 'k' },
  });
});

describe('/rest/v1/tracking_id', () => {
  it('senza token non conia niente', async () => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  // Il buco che c'era: il token bastava. Un negozio con il tracciamento
  // sospeso, o che aveva disinstallato l'app, continuava a farsi coniare
  // identificativi — e siccome questa e' anche l'unica rotta di lettura che
  // SCRIVE, la sua tabella dei visitatori cresceva mentre tutto il resto era
  // fermo.
  it('lettura non concessa: niente identificativo e niente riga', async () => {
    resolveShopReadContext.mockResolvedValue({
      kind: 'ok',
      ctx: { shopId: 's1', canReadData: false, projectRef: 'abcdef', serviceRoleKey: 'k' },
    });

    const res = await call({ apikey: 'buono' });

    expect(res.status).toBe(403);
    expect(recordUserSeen).not.toHaveBeenCalled();
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('token non valido: nessun identificativo', async () => {
    resolveShopReadContext.mockResolvedValue({ kind: 'unknown' });
    const res = await call({ apikey: 'sbagliato' });
    expect(res.status).toBe(401);
  });

  // Il motivo per cui questa rotta esiste: il template Lookup legge il corpo,
  // non gli header, e ci scende dentro con un percorso a punti.
  it('risponde con un array di oggetti, come farebbe PostgREST', async () => {
    // Con `0.external_id` il merchant arriva al valore solo se il primo livello
    // e' un array: un oggetto solo lo costringerebbe a un percorso diverso,
    // cioe' a sapere che questa non e' una tabella vera.
    const res = await call({ apikey: 'buono' });
    const body = JSON.parse(await res.text());
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].external_id).toMatch(/^corew_\d+_[A-Za-z0-9]{32}$/);
  });

  it('corpo, header e cookie dicono lo stesso identificativo', async () => {
    const res = await call({ apikey: 'buono' });
    const [row] = JSON.parse(await res.text());
    expect(res.headers.get('X-CoreW-External-Id')).toBe(row.external_id);
    expect(res.headers.get('Set-Cookie')).toContain(row.external_id);
  });

  it('se il browser ne ha gia uno si riusa quello', async () => {
    const gia = 'corew_1700000000000_abcdefghijklmnopqrstuvwxyz012345';
    const res = await call({ apikey: 'buono', Cookie: `corew_eid=${gia}` });
    const [row] = JSON.parse(await res.text());
    expect(row.external_id).toBe(gia);
    // Rimandarlo identico a ogni pagina sarebbe peso che non cambia niente.
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('non si mette in cache: due browser non devono ricevere lo stesso', async () => {
    const res = await call({ apikey: 'buono' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

/**
 * Qui il browser diventa una riga.
 *
 * E' l'unico posto dove puo' succedere: gli altri momenti legano un browser a
 * una persona, ma per legarlo bisogna che qualcuno lo abbia visto passare
 * almeno una volta.
 */
describe('/rest/v1/tracking_id — la riga del browser', () => {
  it('registra la comparsa del browser', async () => {
    const res = await call({ apikey: 'buono' });
    const [row] = JSON.parse(await res.text());

    expect(recordUserSeen).toHaveBeenCalledTimes(1);
    expect(recordUserSeen.mock.calls[0][1]).toMatchObject({ externalId: row.external_id });
  });

  it('browser e dispositivo si scrivono solo se il container li manda', async () => {
    // Non si ricavano dallo user agent apposta: il dispositivo li' e' una
    // supposizione (iPadOS si dichiara Macintosh), e una supposizione scritta
    // da noi sembrerebbe un dato accertato.
    await call({ apikey: 'buono' }, '?browser=Safari&device_type=mobile');
    expect(recordUserSeen.mock.calls[0][1]).toMatchObject({
      browser: 'Safari',
      deviceType: 'mobile',
    });

    recordUserSeen.mockClear();
    await call({ apikey: 'buono' });
    expect(recordUserSeen.mock.calls[0][1]).toMatchObject({ browser: null, deviceType: null });
  });

  it('la condizione del Lookup arriva nella sintassi di PostgREST', async () => {
    // Il merchant scrive la condizione come la scriverebbe su Supabase, perche'
    // crede di parlare con Supabase: quello che arriva e' `eq.Safari`. Preso
    // alla lettera finirebbe in colonna cosi' com e', e salterebbe fuori mesi
    // dopo dentro un segmento.
    await call({ apikey: 'buono' }, '?browser=eq.Safari&device_type=eq.mobile');
    expect(recordUserSeen.mock.calls[0][1]).toMatchObject({
      browser: 'Safari',
      deviceType: 'mobile',
    });
  });

  it('senza token non si scrive niente nel database di nessuno', async () => {
    resolveShopReadContext.mockResolvedValue({ kind: 'unknown' });
    await call({ apikey: 'sbagliato' });
    expect(recordUserSeen).not.toHaveBeenCalled();
  });

  it('se la scrittura fallisce l identificativo si restituisce lo stesso', async () => {
    // La vetrina sta aspettando: un browser registrato un attimo dopo e' un
    // danno che si ripara alla visita successiva, una pagina senza
    // identificativo no.
    recordUserSeen.mockRejectedValueOnce(new Error('supabase giu'));
    const res = await call({ apikey: 'buono' });

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())[0].external_id).toMatch(/^corew_\d+_[A-Za-z0-9]{32}$/);
  });
});
