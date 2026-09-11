import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VisitorConsent } from '~/lib/tracking/consent';

// Il cancello delle scritture e' finto qui dentro, e ha i suoi test in
// `lib/ingest/ingest-guard.test`: credenziale, ambito, tetti, quota, firma e
// finestra si provano una volta sola, la' dove vivono. Qui interessa quello che
// la rotta fa DOPO aver ottenuto il permesso — e soprattutto COSA passa a
// `finish`, che e' l'unico canale da cui un dato personale potrebbe uscire da
// questa rotta verso un log.
const ingestCtx = { shopId: 's1', projectRef: 'abcdef', serviceRoleKey: 'k', customersEnabled: true };
let ingestRefusal: { status: number; error: string } | null = null;
const authorizeIngest = vi.fn();
const finish = vi.fn();
vi.mock('~/lib/ingest/ingest-guard.server', () => ({
  authorizeIngest: (request: Request, params: unknown) => authorizeIngest(request, params),
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

// La revoca durevole ha i suoi test in lib/consent/revocation-register.test:
// qui interessa solo che questa rotta la faccia partire con il negozio e il
// soggetto giusti, e che guardi l'esito invece di buttarlo via.
const revokeTrackingIdentity = vi.fn<
  (...args: never[]) => Promise<import('~/lib/consent/revoke-tracking.server').RevokeResult>
>(async () => ({ outcome: 'applied', retriable: false }));
vi.mock('~/lib/consent/revoke-tracking.server', () => ({ revokeTrackingIdentity }));


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
  ingestRefusal = null;
  authorizeIngest.mockImplementation(async (request: Request) => {
    if (ingestRefusal) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: ingestRefusal.error }), {
          status: ingestRefusal.status,
        }),
      };
    }
    // Senza credenziale il cancello rifiuta: qui lo si riproduce guardando
    // l'header che il template manda, cosi' il caso "nessun pedaggio" resta
    // provato anche da questa parte.
    if (!request.headers.get('apikey')) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
      };
    }
    try {
      return { ok: true, ctx: ingestCtx, body: await request.json(), credential: 'ingest', finish };
    } catch {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: 'malformed' }), { status: 400 }),
      };
    }
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
    expect(authorizeIngest).not.toHaveBeenCalled();
  });
});

describe('/rest/v1/identify — il pedaggio', () => {
  it('senza credenziale non lega niente', async () => {
    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' }, {});
    expect(res.status).toBe(401);
    expect(identifyVisitor).not.toHaveBeenCalled();
  });

  it('credenziale non valida: nessun legame', async () => {
    ingestRefusal = { status: 401, error: 'unauthorized' };
    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });
    expect(res.status).toBe(401);
  });

  it('negozio che non puo scrivere: niente arriva al suo database', async () => {
    ingestRefusal = { status: 403, error: 'forbidden' };
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

    // Quello che la rotta consegna al log e' solo l'esito: la riga vera la
    // compone `ingest-guard`, che non riceve niente altro da cui potrebbe
    // ricavare un contatto.
    expect(finish).toHaveBeenCalledWith('linked');

    const tutto = [...logged, ...finish.mock.calls.flat().map(String)].join('\n');
    expect(tutto).not.toContain('anna@example.com');
    expect(tutto).not.toContain('393331234567');
    expect(tutto).not.toContain(VISITATORE);
  });

  it('nemmeno quando la richiesta e malformata', async () => {
    await post({ external_id: 'inventato', email: 'anna@example.com' });
    const tutto = [...logged, ...finish.mock.calls.flat().map(String)].join('\n');
    expect(tutto).not.toContain('anna@example.com');
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
    expect(revokeTrackingIdentity).toHaveBeenCalledWith({
      shopId: 's1',
      externalId: VISITATORE,
    });
  });

  it('revoca non presa in carico: 503 con segnale di ritentativo, nessun cookie', async () => {
    revokeTrackingIdentity.mockResolvedValue({ outcome: 'not_recorded', retriable: true });
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'denied', marketing: 'granted', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: true,
    });

    const res = await post({ external_id: VISITATORE, email: 'anna@example.com' });

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    // Il registro riceve il solo identificativo del browser: l'email non e' il
    // soggetto della revoca, e conservarla sarebbe un secondo dato personale da
    // cancellare.
    expect(revokeTrackingIdentity).toHaveBeenCalledWith({
      shopId: 's1',
      externalId: VISITATORE,
    });
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
