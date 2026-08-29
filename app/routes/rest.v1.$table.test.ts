import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VisitorConsent } from '~/lib/tracking/consent';

const resolveShopReadContext = vi.fn();
const forwardRead = vi.fn();

vi.mock('~/lib/read-proxy/context.server', () => ({
  resolveShopReadContext: (...a: unknown[]) => resolveShopReadContext(...a),
}));
vi.mock('~/lib/read-proxy/forward.server', async () => {
  const actual = await vi.importActual<typeof import('~/lib/read-proxy/forward.server')>(
    '~/lib/read-proxy/forward.server',
  );
  return {
    allowedReadTables: (c: boolean) => (c ? ['products', 'customers'] : ['products']),
    allowedEmbedTables: actual.allowedEmbedTables,
    inspectReadQuery: actual.inspectReadQuery,
    forwardRead: (...a: unknown[]) => forwardRead(...a),
  };
});

// Il registro accessi si sostituisce: senza, il loader aprirebbe una
// connessione al database vero per ogni test sui clienti.
interface LoggedAccess {
  shopId: string | null;
  outcome: string;
  status: number;
}
const logCustomerDataAccess = vi.fn(async (_entry: LoggedAccess) => {});
vi.mock('~/lib/read-proxy/access-log.server', () => ({
  logCustomerDataAccess: (entry: LoggedAccess) => logCustomerDataAccess(entry),
}));

import { loader } from './rest.v1.$table';
import * as consentModule from '~/lib/tracking/consent';
import * as usersModule from '~/lib/tracking/users.server';

// Spy sulle funzioni che vogliamo mockare.
const evaluateVisitorConsentMock = vi.spyOn(consentModule, 'evaluateVisitorConsent');
const forgetVisitorMock = vi.spyOn(usersModule, 'forgetVisitor');

/** Il consenso completo: analytics e marketing concessi. */
const consentGranted = (): VisitorConsent => ({
  analytics: 'granted',
  marketing: 'granted',
  preferences: 'unknown',
  saleOfData: 'unknown',
});

const call = (headers: Record<string, string>, table = 'products', url = 'https://app/rest/v1/products?sku=eq.X') =>
  loader({ request: new Request(url, { headers }), params: { table }, context: {} } as any);

const okCtx = (over: Record<string, unknown> = {}) => ({
  kind: 'ok',
  ctx: {
    shopId: 's1',
    authorization: 'ENABLED',
    canReadData: true,
    projectRef: 'r',
    serviceRoleKey: 'svc',
    customersEnabled: false,
    ...over,
  },
});

describe('proxy loader', () => {
  beforeEach(() => {
    resolveShopReadContext.mockReset();
    forwardRead.mockReset();
    logCustomerDataAccess.mockClear();
    evaluateVisitorConsentMock.mockReset();
    forgetVisitorMock.mockClear();
    // Di default: consenso completo.
    evaluateVisitorConsentMock.mockReturnValue({
      consent: consentGranted(),
      source: 'query',
      allowed: true,
      withdrawn: false,
    });
  });

  it('token mancante → 401', async () => {
    const res = await call({});
    expect(res.status).toBe(401);
  });

  it('token sconosciuto → 401', async () => {
    resolveShopReadContext.mockResolvedValueOnce({ kind: 'unknown' });
    const res = await call({ authorization: 'Bearer spx_x' });
    expect(res.status).toBe(401);
  });

  it('non collegato → 409', async () => {
    resolveShopReadContext.mockResolvedValueOnce({ kind: 'not_configured' });
    const res = await call({ authorization: 'Bearer spx_x' });
    expect(res.status).toBe(409);
  });

  it('PENDING → 403, nessun inoltro', async () => {
    resolveShopReadContext.mockResolvedValueOnce(
      okCtx({ authorization: 'PENDING', canReadData: false }),
    );
    const res = await call({ authorization: 'Bearer spx_x' });
    expect(res.status).toBe(403);
    expect(forwardRead).not.toHaveBeenCalled();
  });

  it('DISABLED → 403, nessun inoltro', async () => {
    resolveShopReadContext.mockResolvedValueOnce(
      okCtx({ authorization: 'DISABLED', canReadData: false }),
    );
    const res = await call({ authorization: 'Bearer spx_x' });
    expect(res.status).toBe(403);
    expect(forwardRead).not.toHaveBeenCalled();
  });

  // Il gate è canReadData (fail-closed), non un confronto sulla stringa grezza:
  // uno stato non riconosciuto non deve mai concedere accesso.
  it('stato non riconosciuto → 403, nessun inoltro', async () => {
    resolveShopReadContext.mockResolvedValueOnce(
      okCtx({ authorization: 'DISABLD', canReadData: false }),
    );
    const res = await call({ authorization: 'Bearer spx_x' });
    expect(res.status).toBe(403);
    expect(forwardRead).not.toHaveBeenCalled();
  });

  // PostgREST sa fare embedding di risorse collegate: senza guardia, un select
  // su una tabella ammessa esfiltrerebbe una tabella esclusa dal piano.
  it('select che embedda customers senza piano clienti → 403', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: false }));
    const res = await call(
      { authorization: 'Bearer spx_x' },
      'products',
      'https://app/rest/v1/products?select=*,customers(*)',
    );
    expect(res.status).toBe(403);
    expect(forwardRead).not.toHaveBeenCalled();
  });

  it('select che embedda customers CON piano clienti → blocca comunque (gate consenso top-level)', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: true }));
    const res = await call(
      { authorization: 'Bearer spx_x' },
      'products',
      'https://app/rest/v1/products?select=*,customers(*)',
    );
    expect(res.status).toBe(403);
    expect(forwardRead).not.toHaveBeenCalled();
  });

  // La falla vera: l'elenco dei divieti copriva solo products e customers, e
  // qualunque ALTRA tabella raggiungibile per chiave esterna usciva inoltrata
  // con la service_role, che le RLS non le vede.
  it.each([
    ['orders', 'https://app/rest/v1/products?select=*,orders(*)'],
    ['order_lines', 'https://app/rest/v1/products?select=*,order_lines(id)'],
    ['tabella arbitraria del merchant', 'https://app/rest/v1/products?select=*,fatture(*)'],
    ['embedding annidato', 'https://app/rest/v1/products?select=*,orders(id,customers(email_address))'],
    ['alias', 'https://app/rest/v1/products?select=*,o:orders(*)'],
    ['hint di join', 'https://app/rest/v1/products?select=*,orders!inner(*)'],
    ['select ripetuto', 'https://app/rest/v1/products?select=*&select=*,orders(*)'],
    ['filtro su risorsa collegata', 'https://app/rest/v1/products?select=*&orders.limit=1'],
    ['select non interpretabile', 'https://app/rest/v1/products?select=*,%22orders%22(*)'],
  ])('%s → 403 e nessun inoltro', async (_nome, url) => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: true }));
    const res = await call({ authorization: 'Bearer spx_x' }, 'products', url);
    expect(res.status).toBe(403);
    expect(forwardRead).not.toHaveBeenCalled();
  });

  // Il tracciamento in produzione legge cosi': niente embedding, filtri e
  // proiezioni sulla sola tabella richiesta. Deve continuare a passare.
  it('lettura legittima con select, filtro, order e limit → inoltrata', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[{"sku":"A"}]', contentType: 'application/json' });
    const res = await call(
      { authorization: 'Bearer spx_x' },
      'products',
      'https://app/rest/v1/products?select=sku,price&sku=eq.A&order=updated_at.desc&limit=10',
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[{"sku":"A"}]');
    expect(forwardRead).toHaveBeenCalledTimes(1);
  });

  it('tabella non ammessa dal piano → 403', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: false }));
    const res = await call({ authorization: 'Bearer spx_x' }, 'customers', 'https://app/rest/v1/customers');
    expect(res.status).toBe(403);
    expect(forwardRead).not.toHaveBeenCalled();
  });

  it('ENABLED + tabella ok → inoltra e propaga status/body', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[{"id":1}]', contentType: 'application/json' });
    const res = await call({ authorization: 'Bearer spx_x' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[{"id":1}]');
    const [, table, search] = forwardRead.mock.calls[0];
    expect(table).toBe('products');
    expect(search).toBe('?sku=eq.X');
  });

  it('customers lookup mirato, cliente non consenziente → 403 e nessun inoltro dell\'originale', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: true }));
    // 1a chiamata forwardRead = query di controllo consenso
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[{"accepts_marketing":false}]', contentType: 'application/json' });
    const res = await call(
      { authorization: 'Bearer spx_x' },
      'customers',
      'https://app/rest/v1/customers?email_address=eq.foo@bar.com&select=*',
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("L'utente non ha acconsentito al marketing su Shopify");
    // solo la query di controllo, NON l'inoltro dell'originale
    expect(forwardRead).toHaveBeenCalledTimes(1);
  });

  it('customers lookup mirato, cliente consenziente → inoltra e restituisce i dati', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: true }));
    forwardRead
      .mockResolvedValueOnce({ status: 200, body: '[{"accepts_marketing":true}]', contentType: 'application/json' })
      .mockResolvedValueOnce({ status: 200, body: '[{"email_address":"foo@bar.com"}]', contentType: 'application/json' });
    const res = await call(
      { authorization: 'Bearer spx_x' },
      'customers',
      'https://app/rest/v1/customers?email_address=eq.foo@bar.com',
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('foo@bar.com');
    expect(forwardRead).toHaveBeenCalledTimes(2);
  });

  it('customers lookup mirato senza corrispondenze → inoltra (torna [])', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: true }));
    forwardRead
      .mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' })
      .mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });
    const res = await call(
      { authorization: 'Bearer spx_x' },
      'customers',
      'https://app/rest/v1/customers?shopify_customer_id=eq.999',
    );
    expect(res.status).toBe(200);
    expect(forwardRead).toHaveBeenCalledTimes(2);
  });

  it('customers lettura non mirata → inoltra con accepts_marketing=eq.true', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: true }));
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });
    await call(
      { authorization: 'Bearer spx_x' },
      'customers',
      'https://app/rest/v1/customers?select=*&limit=10',
    );
    expect(forwardRead).toHaveBeenCalledTimes(1);
    const forwardedSearch = forwardRead.mock.calls[0][2] as string;
    expect(forwardedSearch).toContain('accepts_marketing=eq.true');
  });

  it('products non è toccato dal consenso', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: true }));
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });
    await call(
      { authorization: 'Bearer spx_x' },
      'products',
      'https://app/rest/v1/products?email_address=eq.foo@bar.com',
    );
    expect(forwardRead).toHaveBeenCalledTimes(1);
    const forwardedSearch = forwardRead.mock.calls[0][2] as string;
    expect(forwardedSearch).not.toContain('accepts_marketing');
  });
});

describe('registro degli accessi ai dati personali', () => {
  beforeEach(() => {
    resolveShopReadContext.mockReset();
    forwardRead.mockReset();
    logCustomerDataAccess.mockClear();
  });

  const entry = (): LoggedAccess => logCustomerDataAccess.mock.calls[0][0];

  it('una lettura clienti riuscita viene registrata come consentita', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: true }));
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });

    await call({ authorization: 'Bearer spx_x' }, 'customers', 'https://app/rest/v1/customers');

    expect(logCustomerDataAccess).toHaveBeenCalledTimes(1);
    expect(entry()).toEqual({ shopId: 's1', outcome: 'allowed', status: 200 });
  });

  it('i prodotti non si registrano: non sono dati personali', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });

    await call({ authorization: 'Bearer spx_x' }, 'products');

    expect(logCustomerDataAccess).not.toHaveBeenCalled();
  });

  it('token assente su clienti → registrato, senza negozio', async () => {
    await call({}, 'customers', 'https://app/rest/v1/customers');

    expect(entry()).toEqual({ shopId: null, outcome: 'denied_no_token', status: 401 });
  });

  it('negozio sospeso → registrato con il negozio che ha provato', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ canReadData: false, customersEnabled: true }));

    await call({ authorization: 'Bearer spx_x' }, 'customers', 'https://app/rest/v1/customers');

    expect(entry()).toEqual({ shopId: 's1', outcome: 'denied_suspended', status: 403 });
  });

  it('clienti non inclusi nel piano → registrato come tabella negata', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: false }));

    await call({ authorization: 'Bearer spx_x' }, 'customers', 'https://app/rest/v1/customers');

    expect(entry()).toEqual({ shopId: 's1', outcome: 'denied_table', status: 403 });
  });

  it('cliente senza consenso → registrato come consenso negato', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: true }));
    forwardRead.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify([{ accepts_marketing: false }]),
      contentType: 'application/json',
    });

    await call(
      { authorization: 'Bearer spx_x' },
      'customers',
      'https://app/rest/v1/customers?email_address=eq.foo@bar.com',
    );

    expect(entry()).toEqual({ shopId: 's1', outcome: 'denied_consent', status: 403 });
  });

  it('errore del database del merchant → registrato come errore a monte', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx({ customersEnabled: true }));
    forwardRead.mockResolvedValueOnce({ status: 500, body: '{}', contentType: 'application/json' });

    await call({ authorization: 'Bearer spx_x' }, 'customers', 'https://app/rest/v1/customers');

    expect(entry()).toEqual({ shopId: 's1', outcome: 'upstream_error', status: 500 });
  });
});

describe('identificativo esterno (external ID) — con consenso', () => {
  beforeEach(() => {
    resolveShopReadContext.mockReset();
    forwardRead.mockReset();
    logCustomerDataAccess.mockClear();
    evaluateVisitorConsentMock.mockReset();
    // Consenso concesso per questi test.
    evaluateVisitorConsentMock.mockReturnValue({
      consent: consentGranted(),
      source: 'query',
      allowed: true,
      withdrawn: false,
    });
  });

  it('senza cookie esistente → header presente con identificativo nuovo', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });

    const res = await call({ authorization: 'Bearer spx_x' });

    const headerValue = res.headers.get('X-CoreW-External-Id');
    expect(headerValue).toBeTruthy();
    expect(headerValue).toMatch(/^corew_\d+_[A-Za-z0-9]{32}$/);
  });

  it('con cookie esistente → header presente con stesso valore del cookie', async () => {
    const existingId = 'corew_1234567890_abcdefghijklmnopqrstuvwxyz123456';
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });

    const res = await call(
      { authorization: 'Bearer spx_x', cookie: `corew_eid=${existingId}` },
    );

    const headerValue = res.headers.get('X-CoreW-External-Id');
    expect(headerValue).toBe(existingId);
  });

  it('header e cookie coerenti quando il cookie viene creato', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });

    const res = await call({ authorization: 'Bearer spx_x' });

    const headerValue = res.headers.get('X-CoreW-External-Id');
    const setCookieHeader = res.headers.get('Set-Cookie');

    expect(headerValue).toBeTruthy();
    expect(setCookieHeader).toBeTruthy();
    expect(setCookieHeader).toContain(`corew_eid=${headerValue}`);
  });

  it('header esposto via Access-Control-Expose-Headers per letture cross-origin', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });

    const res = await call({ authorization: 'Bearer spx_x' });

    const exposeHeaders = res.headers.get('Access-Control-Expose-Headers');
    expect(exposeHeaders).toContain('X-CoreW-External-Id');
    expect(exposeHeaders).toContain('X-CoreW-Sale-Of-Data');
  });
});

describe('identificativo esterno — consenso del visitatore', () => {
  beforeEach(() => {
    resolveShopReadContext.mockReset();
    forwardRead.mockReset();
    logCustomerDataAccess.mockClear();
    evaluateVisitorConsentMock.mockReset();
    forgetVisitorMock.mockClear();
    // Default: segnale assente (i test lo cambiano dove serve).
    evaluateVisitorConsentMock.mockReturnValue({
      consent: { analytics: 'unknown', marketing: 'unknown', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'none',
      allowed: false,
      withdrawn: false,
    });
  });

  it('senza consenso: nessun header identificativo, nessun cookie', async () => {
    // Il difetto che c'era: l'identificativo si emetteva comunque. Ora no.
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });
    evaluateVisitorConsentMock.mockReturnValue({
      consent: { analytics: 'unknown', marketing: 'unknown', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'none',
      allowed: false,
      withdrawn: false,
    });

    const res = await call({ authorization: 'Bearer spx_x' });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-CoreW-External-Id')).toBeNull();
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('richiesta rifiutata per token mancante: nessun identificativo', async () => {
    // Prima c'era: "richiesta rifiutata → identificativo emesso comunque".
    // Era il contratto vecchio, e descriveva esattamente il difetto.
    const res = await call({});

    expect(res.status).toBe(401);
    // L'identificativo non viene emesso se la richiesta non passa i controlli
    // di token e autorizzazione: il consenso è l'ultimo cancello, non l'unico.
    expect(res.headers.get('X-CoreW-External-Id')).toBeNull();
    // evaluateVisitorConsent viene chiamato comunque per impostare l'header
    // X-CoreW-Sale-Of-Data, ma l'identificativo non viene emesso.
  });

  it('consenso parziale (solo analytics): nessun identificativo', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });
    evaluateVisitorConsentMock.mockReturnValue({
      consent: { analytics: 'granted', marketing: 'unknown', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: false,
    });

    const res = await call({ authorization: 'Bearer spx_x' });

    expect(res.headers.get('X-CoreW-External-Id')).toBeNull();
  });

  it('consenso parziale (solo marketing): nessun identificativo', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });
    evaluateVisitorConsentMock.mockReturnValue({
      consent: { analytics: 'unknown', marketing: 'granted', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: false,
    });

    const res = await call({ authorization: 'Bearer spx_x' });

    expect(res.headers.get('X-CoreW-External-Id')).toBeNull();
  });

  it('revoca esplicita: cookie scaduto e riga cancellata', async () => {
    const existingId = 'corew_1234567890_abcdefghijklmnopqrstuvwxyz123456';
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });
    evaluateVisitorConsentMock.mockReturnValue({
      consent: { analytics: 'denied', marketing: 'granted', preferences: 'unknown', saleOfData: 'unknown' },
      source: 'query',
      allowed: false,
      withdrawn: true,
    });

    const res = await call({ authorization: 'Bearer spx_x', cookie: `corew_eid=${existingId}` });

    expect(res.headers.get('X-CoreW-External-Id')).toBeNull();
    expect(res.headers.get('Set-Cookie')).toContain('corew_eid=');
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(forgetVisitorMock).toHaveBeenCalledWith(expect.anything(), existingId);
  });

  it('saleOfData viene sempre dichiarato, consenso o no', async () => {
    resolveShopReadContext.mockResolvedValueOnce(okCtx());
    forwardRead.mockResolvedValueOnce({ status: 200, body: '[]', contentType: 'application/json' });
    evaluateVisitorConsentMock.mockReturnValue({
      consent: { analytics: 'unknown', marketing: 'unknown', preferences: 'unknown', saleOfData: 'denied' },
      source: 'query',
      allowed: false,
      withdrawn: false,
    });

    const res = await call({ authorization: 'Bearer spx_x' });

    expect(res.headers.get('X-CoreW-Sale-Of-Data')).toBe('denied');
  });
});
