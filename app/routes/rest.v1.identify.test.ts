import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VisitorConsent } from '~/lib/tracking/consent';

const resolveShopReadContext = vi.fn();
vi.mock('~/lib/read-proxy/context.server', () => ({ resolveShopReadContext }));
vi.mock('~/lib/read-proxy/token.server', () => ({
  extractReadProxyToken: (request: Request) => request.headers.get('apikey') ?? null,
}));

const identifyVisitor = vi.fn();
const forgetVisitor = vi.fn(async () => 'forgotten' as const);
vi.mock('~/lib/tracking/users.server', () => ({
  identifyVisitor,
  forgetVisitor,
  supabaseFromReadContext: () => ({}) as never,
}));
vi.mock('~/lib/supabase/ensure-users-table.server', () => ({
  provisionUsersTable: vi.fn(async () => true),
}));

// Il consenso del visitatore.
const evaluateVisitorConsent = vi.fn();
vi.mock('~/lib/tracking/consent', async () => {
  const actual = await vi.importActual<typeof import('~/lib/tracking/consent')>(
    '~/lib/tracking/consent',
  );
  return {
    ...actual,
    evaluateVisitorConsent: (...args: unknown[]) => evaluateVisitorConsent(...args),
  };
});

const { action, loader } = await import('./rest.v1.identify');

/** Il consenso completo: analytics e marketing concessi. */
const consentGranted = (): VisitorConsent => ({
  analytics: 'granted',
  marketing: 'granted',
  preferences: 'unknown',
  saleOfData: 'unknown',
});

const VISITATORE = 'corew_1700000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function post(body: unknown, headers: Record<string, string> = { apikey: 'buono' }) {
  return action({
    request: new Request('https://api.coreward.app/rest/v1/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  } as never) as Promise<Response>;
}

let logged: string[];

beforeEach(() => {
  vi.clearAllMocks();
  resolveShopReadContext.mockResolvedValue({
    kind: 'ok',
    ctx: { shopId: 's1', canReadData: true, projectRef: 'abcdef', serviceRoleKey: 'k' },
  });
  identifyVisitor.mockResolvedValue({ outcome: 'linked', canonical: VISITATORE, merged: [] });
  // Di default: consenso completo.
  evaluateVisitorConsent.mockReturnValue({
    consent: consentGranted(),
    source: 'query',
    allowed: true,
    withdrawn: false,
  });
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/rest/v1/identify — il metodo e una misura di protezione', () => {
  // La ragione per cui questa rotta e' in POST: un'email in querystring finisce
  // nei log d'accesso di ogni intermediario, nell'header Referer che il browser
  // porta al sito successivo, e nella cronologia. Nel corpo di una POST no.
  it('in GET non fa niente e risponde 405', async () => {
    const res = (await loader()) as Response;
    expect(res.status).toBe(405);
    expect(identifyVisitor).not.toHaveBeenCalled();
  });

  it('anche un metodo diverso da POST viene rifiutato prima di guardare altro', async () => {
    const res = (await action({
      request: new Request('https://api.coreward.app/rest/v1/identify', {
        method: 'PUT',
        headers: { apikey: 'buono' },
      }),
    } as never)) as Response;

    expect(res.status).toBe(405);
    // Il metodo si controlla PRIMA del token: nessuna identificazione parte.
    expect(identifyVisitor).not.toHaveBeenCalled();
    expect(resolveShopReadContext).not.toHaveBeenCalled();
  });
});

describe('/rest/v1/identify — il pedaggio', () => {
  it('senza token non lega niente', async () => {
    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' }, {});
    expect(res.status).toBe(401);
    expect(identifyVisitor).not.toHaveBeenCalled();
  });

  it('token non valido: nessun legame', async () => {
    resolveShopReadContext.mockResolvedValue({ kind: 'unknown' });
    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });
    expect(res.status).toBe(401);
  });

  it('tracciamento sospeso: non si scrive nel database del merchant', async () => {
    resolveShopReadContext.mockResolvedValue({
      kind: 'ok',
      ctx: { shopId: 's1', canReadData: false, projectRef: 'abcdef', serviceRoleKey: 'k' },
    });
    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });
    expect(res.status).toBe(403);
    expect(identifyVisitor).not.toHaveBeenCalled();
  });
});

describe('/rest/v1/identify — cosa arriva e cosa esce', () => {
  it('passa email e telefono in chiaro, che e come sono nel database del merchant', async () => {
    const res = await post({
      external_id: VISITATORE,
      email: 'anna@example.com',
      phone: '+39 333 123 4567',
      browser: 'Safari',
      device_type: 'mobile',
    });

    expect(res.status).toBe(200);
    expect(identifyVisitor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        externalId: VISITATORE,
        email: 'anna@example.com',
        phone: '+39 333 123 4567',
        browser: 'Safari',
        deviceType: 'mobile',
      }),
      expect.any(Function),
    );
  });

  it('un identificativo non nostro non entra nella tabella', async () => {
    const res = await post({ external_id: 'inventato', email: 'anna@example.com' });
    expect(res.status).toBe(400);
    expect(identifyVisitor).not.toHaveBeenCalled();
  });

  it('corpo illeggibile: 400, e non si prova a indovinarlo', async () => {
    const res = await post('{non json');
    expect(res.status).toBe(400);
    expect(identifyVisitor).not.toHaveBeenCalled();
  });

  it('cliente non trovato e comunque 200: e un esito, non un errore', async () => {
    // Solo i clienti che hanno acconsentito al marketing stanno in quella
    // tabella, e un container che riceve un errore smette di chiamare.
    identifyVisitor.mockResolvedValue({ outcome: 'no_match', canonical: null, merged: [] });
    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ ok: true, outcome: 'no_match' });
  });
});

describe('/rest/v1/identify — il corpo non finisce nei log', () => {
  it('si registra l esito, mai il contenuto', async () => {
    // Un'email in una riga di log e' un dato personale uscito dal database del
    // merchant e finito dove nessuno lo pota e nessuno lo cerchera'.
    await post({
      external_id: VISITATORE,
      email: 'anna@example.com',
      phone: '+393331234567',
    });

    const riga = logged.join('\n');
    expect(riga).toContain('[rest/v1/identify]');
    expect(riga).toContain('linked');
    expect(riga).not.toContain('anna@example.com');
    expect(riga).not.toContain('393331234567');
  });

  it('nemmeno quando la richiesta e malformata', async () => {
    await post({ external_id: 'inventato', email: 'anna@example.com' });
    expect(logged.join('\n')).not.toContain('anna@example.com');
  });
});

describe('/rest/v1/identify — consenso del visitatore', () => {
  it('senza consenso: nessun legame, outcome no_consent', async () => {
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'unknown', marketing: 'unknown', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'none',
      allowed: false,
      withdrawn: false,
    });

    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ ok: true, outcome: 'no_consent' });
    expect(identifyVisitor).not.toHaveBeenCalled();
  });

  it('consenso parziale (solo analytics): nessun legame', async () => {
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'granted', marketing: 'unknown', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: false,
    });

    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });

    expect(identifyVisitor).not.toHaveBeenCalled();
  });

  it('consenso parziale (solo marketing): nessun legame', async () => {
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'unknown', marketing: 'granted', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: false,
    });

    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });

    expect(identifyVisitor).not.toHaveBeenCalled();
  });

  it('entrambe concesse: legame eseguito', async () => {
    evaluateVisitorConsent.mockReturnValue({
      consent: consentGranted(),
      source: 'query',
      allowed: true,
      withdrawn: false,
    });

    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });

    expect(res.status).toBe(200);
    expect(identifyVisitor).toHaveBeenCalledTimes(1);
  });

  it('revoca esplicita: riga cancellata, nessun legame', async () => {
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'denied', marketing: 'granted', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: true,
    });

    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });

    expect(res.status).toBe(200);
    expect(identifyVisitor).not.toHaveBeenCalled();
    expect(forgetVisitor).toHaveBeenCalledWith(expect.anything(), VISITATORE);
  });

  it('il consenso arriva dal corpo, non solo dalla query', async () => {
    // evaluateVisitorConsent riceve il corpo come secondo parametro.
    await post({
      external_id: VISITATORE,
      email: 'anna@example.com',
      phone: '+39 333 123 4567',
    });

    expect(evaluateVisitorConsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ external_id: VISITATORE, email: 'anna@example.com' }),
    );
  });

  it('cliente non trovato con consenso: outcome no_match, non no_consent', async () => {
    // Il test che falliva: asseriva no_match ma riceveva no_consent perché
    // mancava il consenso. Ora il consenso c'è.
    evaluateVisitorConsent.mockReturnValue({
      consent: consentGranted(),
      source: 'query',
      allowed: true,
      withdrawn: false,
    });
    identifyVisitor.mockResolvedValue({ outcome: 'no_match', canonical: null, merged: [] });

    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ ok: true, outcome: 'no_match' });
  });
});
