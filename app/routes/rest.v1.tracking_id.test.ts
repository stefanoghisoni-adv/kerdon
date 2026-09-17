import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VisitorConsent } from '~/lib/tracking/consent';

// Il cancello delle scritture e' finto qui dentro, e ha i suoi test in
// `lib/ingest/ingest-guard.test`. Questa rotta ci passa come le altre due, e non
// e' un dettaglio: quello che restituisce sembra una lettura, ma quello che FA
// e' coniare un identificativo e scriverne la riga nel database del merchant.
const ingestCtx = { shopId: 's1', projectRef: 'abcdef', serviceRoleKey: 'k', customersEnabled: true };
let ingestRefusal: { status: number; error: string } | null = null;
const finish = vi.fn();
const authorizeIngest = vi.fn();
vi.mock('~/lib/ingest/ingest-guard.server', () => ({
  authorizeIngest: (request: Request, params: unknown) => authorizeIngest(request, params),
}));

// La scrittura della riga del browser ha i suoi test in
// lib/tracking/users.server.test: qui interessa solo che questa rotta la faccia
// partire, e che non possa impedire la risposta.
const recordUserSeen = vi.fn(
  async (_supabase: unknown, _visitor: Record<string, unknown>) => 'written' as const,
);
const forgetVisitor = vi.fn(async () => 'forgotten' as const);
vi.mock('~/lib/tracking/users.server', () => ({
  recordUserSeen,
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


// Il permesso del visitatore: default = concesso, i test lo modificano.
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

const { loader } = await import('./rest.v1.tracking_id');

/** Il consenso completo: analytics e marketing concessi. */
const consentGranted = (): VisitorConsent => ({
  analytics: 'granted',
  marketing: 'granted',
  preferences: 'unknown',
  saleOfData: 'unknown',
});

const call = (headers: Record<string, string> = {}, search = '') =>
  loader({
    request: new Request(`https://api.kerdon.io/rest/v1/tracking_id${search}`, { headers }),
  } as never);

beforeEach(() => {
  ingestRefusal = null;
  finish.mockClear();
  authorizeIngest.mockReset();
  authorizeIngest.mockImplementation(async (request: Request) => {
    // Senza credenziale il cancello rifiuta, e qui lo si riproduce guardando
    // l'header che il container manda: il caso "nessun pedaggio" resta provato
    // anche da questa parte.
    const rifiuto = ingestRefusal ?? (request.headers.get('apikey') ? null : { status: 401, error: 'unauthorized' });
    if (rifiuto) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: rifiuto.error }), { status: rifiuto.status }),
      };
    }
    return { ok: true, ctx: ingestCtx, body: {}, finish };
  });
  recordUserSeen.mockClear();
  forgetVisitor.mockClear();
  revokeTrackingIdentity.mockClear();
  revokeTrackingIdentity.mockResolvedValue({ outcome: 'applied', retriable: false });
  evaluateVisitorConsent.mockReset();
  // Di default: consenso completo, i test lo cambiano dove serve.
  evaluateVisitorConsent.mockReturnValue({
    consent: consentGranted(),
    source: 'query',
    allowed: true,
    withdrawn: false,
  });
});

describe('/rest/v1/tracking_id', () => {
  it('senza credenziale non conia niente', async () => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  // Il buco che c'era: il token di lettura bastava. Un negozio con il
  // tracciamento sospeso, o che aveva disinstallato l'app, continuava a farsi
  // coniare identificativi — e siccome questa rotta SCRIVE, la sua tabella dei
  // visitatori cresceva mentre tutto il resto era fermo.
  it('scrittura non concessa: niente identificativo e niente riga', async () => {
    ingestRefusal = { status: 403, error: 'forbidden' };

    const res = await call({ apikey: 'buono' });

    expect(res.status).toBe(403);
    expect(recordUserSeen).not.toHaveBeenCalled();
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('credenziale non valida: nessun identificativo', async () => {
    ingestRefusal = { status: 401, error: 'unauthorized' };
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
    expect(body[0].external_id).toMatch(/^kerdon_[A-Za-z0-9]{32}$/);
  });

  it('corpo, header e cookie dicono lo stesso identificativo', async () => {
    const res = await call({ apikey: 'buono' });
    const [row] = JSON.parse(await res.text());
    expect(res.headers.get('X-CoreW-External-Id')).toBe(row.external_id);
    expect(res.headers.get('Set-Cookie')).toContain(row.external_id);
  });

  it('se il browser ne ha gia uno si riusa quello', async () => {
    const gia = 'corew_1700000000000_abcdefghijklmnopqrstuvwxyz012345';
    const res = await call({ apikey: 'buono', Cookie: `kerdon_eid=${gia}` });
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

  it('senza credenziale non si scrive niente nel database di nessuno', async () => {
    ingestRefusal = { status: 401, error: 'unauthorized' };
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
    expect(JSON.parse(await res.text())[0].external_id).toMatch(/^kerdon_[A-Za-z0-9]{32}$/);
  });
});

/**
 * Il permesso del visitatore prima dell'identificativo.
 *
 * Criticità P0-05 dell'audit: l'identificativo è un trattamento (dura un anno,
 * serve all'attribuzione) e si conia solo se il visitatore ha acconsentito alle
 * finalità necessarie: analytics E marketing insieme.
 */
describe('/rest/v1/tracking_id — consenso del visitatore', () => {
  it('senza consenso: array vuoto, nessun header, nessun cookie, nessuna riga', async () => {
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'unknown', marketing: 'unknown', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'none',
      allowed: false,
      withdrawn: false,
    });

    const res = await call({ apikey: 'buono' });

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual([]);
    expect(res.headers.get('X-CoreW-External-Id')).toBeNull();
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(recordUserSeen).not.toHaveBeenCalled();
  });

  it('solo analytics concesso: non basta, serve anche marketing', async () => {
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'granted', marketing: 'unknown', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: false,
    });

    const res = await call({ apikey: 'buono' });

    expect(JSON.parse(await res.text())).toEqual([]);
    expect(recordUserSeen).not.toHaveBeenCalled();
  });

  it('solo marketing concesso: non basta, serve anche analytics', async () => {
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'unknown', marketing: 'granted', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: false,
    });

    const res = await call({ apikey: 'buono' });

    expect(JSON.parse(await res.text())).toEqual([]);
    expect(recordUserSeen).not.toHaveBeenCalled();
  });

  it('entrambe concesse: identificativo emesso e riga scritta', async () => {
    evaluateVisitorConsent.mockReturnValue({
      consent: consentGranted(),
      source: 'query',
      allowed: true,
      withdrawn: false,
    });

    const res = await call({ apikey: 'buono' });

    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body).toHaveLength(1);
    expect(body[0].external_id).toMatch(/^kerdon_[A-Za-z0-9]{32}$/);
    expect(recordUserSeen).toHaveBeenCalledTimes(1);
  });

  it('revoca esplicita su analytics: cookie scaduto e riga cancellata', async () => {
    const existing = 'corew_1700000000000_abcdefghijklmnopqrstuvwxyz012345';
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'denied', marketing: 'granted', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: true,
    });

    const res = await call({ apikey: 'buono', Cookie: `kerdon_eid=${existing}` });

    expect(JSON.parse(await res.text())).toEqual([]);
    expect(res.headers.get('Set-Cookie')).toContain('kerdon_eid=');
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(revokeTrackingIdentity).toHaveBeenCalledWith({ shopId: 's1', externalId: existing });
  });

  it('revoca esplicita su marketing: cookie scaduto e riga cancellata', async () => {
    const existing = 'corew_1700000000000_abcdefghijklmnopqrstuvwxyz012345';
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'granted', marketing: 'denied', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: true,
    });

    const res = await call({ apikey: 'buono', Cookie: `kerdon_eid=${existing}` });

    expect(revokeTrackingIdentity).toHaveBeenCalledWith({ shopId: 's1', externalId: existing });
  });

  // Il caso dell'audit: la riga durevole non si e' potuta scrivere. Il cookie
  // scade lo stesso — il tracciamento locale deve cessare subito — ma la
  // risposta smette di essere un ok, perche' non se ne sta occupando nessuno.
  it('revoca non presa in carico: 503, cookie comunque scaduto, nessun identificativo', async () => {
    const existing = 'corew_1700000000000_abcdefghijklmnopqrstuvwxyz012345';
    revokeTrackingIdentity.mockResolvedValue({ outcome: 'not_recorded', retriable: true });
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'denied', marketing: 'granted', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: true,
    });

    const res = await call({ apikey: 'buono', Cookie: `kerdon_eid=${existing}` });

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    // E soprattutto: non si rimette il cookie. Il riferimento sta nel registro,
    // cifrato, non nel browser di chi ha appena revocato.
    expect(res.headers.get('Set-Cookie')).not.toContain(existing);
    expect(res.headers.get('X-CoreW-External-Id')).toBeNull();
  });

  // La revoca scritta ma non ancora applicata NON e' un errore per chi chiama:
  // la riga c'e', e il drenaggio la riprende.
  it('revoca presa in carico ma non applicata: resta 200', async () => {
    revokeTrackingIdentity.mockResolvedValue({ outcome: 'recorded', retriable: false });
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'denied', marketing: 'granted', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: true,
    });

    const res = await call({
      apikey: 'buono',
      Cookie: 'kerdon_eid=corew_1700000000000_abcdefghijklmnopqrstuvwxyz012345',
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual([]);
  });

  it('segnale assente (unknown) vale come no, non come si', async () => {
    // Il permesso non si presume mai: assenza di segnale = nessun consenso.
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'unknown', marketing: 'unknown', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'none',
      allowed: false,
      withdrawn: false,
    });

    const res = await call({ apikey: 'buono' });

    expect(JSON.parse(await res.text())).toEqual([]);
    expect(recordUserSeen).not.toHaveBeenCalled();
  });

  it('revoca senza cookie esistente: nessun Set-Cookie, nessuna revoca registrata', async () => {
    // La revoca si applica solo se c'era qualcosa da revocare.
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'denied', marketing: 'granted', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: true,
    });

    const res = await call({ apikey: 'buono' });

    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(revokeTrackingIdentity).not.toHaveBeenCalled();
  });

  it('saleOfData viene sempre dichiarato nell header, consenso o no', async () => {
    evaluateVisitorConsent.mockReturnValue({
      consent: { analytics: 'unknown', marketing: 'unknown', preferences: 'unknown', saleOfData: 'denied' },
      source: 'query',
      allowed: false,
      withdrawn: false,
    });

    const res = await call({ apikey: 'buono' });

    expect(res.headers.get('X-CoreW-Sale-Of-Data')).toBe('denied');
  });

  // Prima qui si dichiarava `Access-Control-Expose-Headers`, che serve a far
  // leggere un header a una pagina di un'altra origine. Non ha mai funzionato:
  // senza `Access-Control-Allow-Origin` il browser blocca la risposta intera, e
  // quell'header non c'e' — non qui, non da nessuna parte nell'app. Chi legge
  // questo endpoint e' un server, non un browser: promettere il contrario
  // faceva credere che una lettura dalla pagina del negozio potesse funzionare.
  it('non promette letture da browser: nessuna intestazione CORS', async () => {
    const res = await call({ apikey: 'buono' });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Expose-Headers')).toBeNull();
    // Gli header con l'identificativo restano: li legge il server che chiama.
    expect(res.headers.get('X-CoreW-External-Id')).toBeTruthy();
  });
});
