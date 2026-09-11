import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Il cancello delle scritture, provato per intero.
 *
 * QUESTO E' IL FILE CHE DIMOSTRA LA CHIUSURA DEL BUCO. Le rotte hanno i loro
 * test e provano quel che fanno con il permesso in mano; qui si prova il
 * permesso — cioe' la sola cosa che prima non c'era, perche' la domanda "chi
 * puo' scrivere" aveva la stessa risposta di "chi puo' leggere".
 *
 * Il database e' finto ma le regole sono vere: la policy delle capacita', la
 * credenziale, gli ambiti, la finestra e la firma sono i moduli veri. Quello che
 * si sostituisce sono le due cose che qui non si possono avere — le righe e la
 * cifratura della chiave di servizio.
 */

const ORA = new Date('2026-09-11T12:00:00.000Z');

interface RigaChiave {
  id: string;
  shopId: string;
  keyId: string;
  audience: string;
  scopes: string[];
  secretCipher: string;
  valueHash: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

const chiavi: RigaChiave[] = [];
const negozi = new Map<string, Record<string, unknown>>();
const scrittureAdozione: Array<Record<string, unknown>> = [];

const prisma = {
  shop: {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (typeof where.id === 'string') return negozi.get(where.id) ?? null;
      if (typeof where.readProxyTokenHash === 'string') {
        for (const negozio of negozi.values()) {
          if (negozio.readProxyTokenHash === where.readProxyTokenHash) return negozio;
        }
      }
      return null;
    }),
  },
  trackingIngestKey: {
    findUnique: vi.fn(async ({ where }: { where: { keyId: string } }) =>
      chiavi.find((c) => c.keyId === where.keyId) ?? null,
    ),
    findFirst: vi.fn(async ({ where }: { where: { valueHash: string } }) =>
      chiavi.find((c) => c.valueHash === where.valueHash) ?? null,
    ),
    update: vi.fn(async () => undefined),
  },
  trackingSetup: {
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      scrittureAdozione.push(data);
      return { count: 1 };
    }),
  },
};

vi.mock('~/db.server', () => ({
  prisma: {
    get shop() {
      return prisma.shop;
    },
    get trackingIngestKey() {
      return prisma.trackingIngestKey;
    },
    get trackingSetup() {
      return prisma.trackingSetup;
    },
  },
}));

// La chiave di servizio del merchant arriva cifrata dalla colonna. Qui la
// cifratura non e' l'oggetto della prova: quel che conta e' che la chiave NON
// esca mai da questo modulo — ne' in una risposta ne' in un log.
vi.mock('~/utils/crypto.server', () => ({
  decrypt: (value: string) => value.replace('cifrata:', ''),
  encrypt: (value: string) => `cifrata:${value}`,
}));

vi.mock('~/lib/billing/find-plan.server', () => ({
  findPlanByName: async () => ({
    planName: 'pro',
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  }),
}));

import { hashReadProxyToken } from '~/lib/read-proxy/token.server';
import {
  INGEST_LEGACY_SUNSET_DEFAULT,
  INGEST_BUCKET_CAPACITY,
  INGEST_SIGNATURE_WINDOW_MS,
  MAX_INGEST_BODY_BYTES,
  MAX_INGEST_JSON_DEPTH,
  canonicalIngestPayload,
  type IngestScope,
} from './ingest-model';
import { generateIngestCredential, hashIngestValue, sealIngestSecret, signIngestPayload } from './ingest-key.server';
import { clearIngestBuckets } from './ingest-rate-limit.server';
import { clearIngestReplayMemory } from './ingest-replay.server';
import {
  INGEST_IDEMPOTENCY_HEADER,
  INGEST_KEY_HEADER,
  INGEST_SIGNATURE_HEADER,
  INGEST_TIMESTAMP_HEADER,
  authorizeIngest,
} from './ingest-guard.server';

const TOKEN_LETTURA = 'spx_token-di-sola-lettura';
const VISITATORE = 'corew_1700000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMAIL = 'anna@example.com';

/** Un negozio che puo' fare tutto: e' il caso in cui un rifiuto significa qualcosa. */
function negozioSano(id = 'negozio-1') {
  negozi.set(id, {
    id,
    lifecycleStatus: 'active',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,read_customers,read_orders',
    currentPlan: 'pro',
    isInTrial: false,
    trialEndsAt: null,
    activeChargeId: null,
    readProxyTokenHash: hashReadProxyToken(TOKEN_LETTURA),
    supabaseConfig: {
      connectionVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      supabaseProjectRef: 'abcdefghijkl',
      supabaseServiceRoleKey: 'cifrata:chiave-di-servizio-segretissima',
    },
    trackingSetup: { ingestLastSignedAt: null, ingestLastLegacyAt: null },
  });
  return id;
}

/** Una credenziale di ingest viva per quel negozio. */
function credenzialeViva(
  shopId: string,
  over: Partial<RigaChiave> = {},
  scopes: IngestScope[] = ['ingest:identity', 'ingest:browsers', 'ingest:links'],
) {
  const credenziale = generateIngestCredential();
  chiavi.push({
    id: `riga-${chiavi.length + 1}`,
    shopId,
    keyId: credenziale.keyId,
    audience: 'ingest',
    scopes,
    secretCipher: sealIngestSecret(credenziale.secret),
    valueHash: hashIngestValue(credenziale.value),
    revokedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    ...over,
  });
  return credenziale;
}

let etichetta = 0;

/** Una richiesta firmata come la manderebbe un endpoint aggiornato. */
function firmata(
  credenziale: { keyId: string; secret: string },
  options: {
    scope?: IngestScope;
    route?: string;
    method?: string;
    body?: string;
    timestampMs?: number;
    idempotencyKey?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const scope = options.scope ?? 'ingest:browsers';
  const route = options.route ?? '/rest/v1/users';
  const method = options.method ?? 'POST';
  const body = options.body ?? JSON.stringify({ external_id: VISITATORE, email: EMAIL });
  const timestampMs = options.timestampMs ?? ORA.getTime();
  const idempotencyKey = options.idempotencyKey ?? `msg-${++etichetta}`;

  const firma = signIngestPayload(
    credenziale.secret,
    canonicalIngestPayload({
      scope,
      timestampMs,
      method,
      path: route,
      bodyDigest: digest(method === 'GET' ? '' : body),
      idempotencyKey,
    }),
  );

  return new Request(`https://api.kerdon.io${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [INGEST_KEY_HEADER]: credenziale.keyId,
      [INGEST_TIMESTAMP_HEADER]: String(timestampMs),
      [INGEST_SIGNATURE_HEADER]: firma,
      [INGEST_IDEMPOTENCY_HEADER]: idempotencyKey,
      ...options.headers,
    },
    ...(method === 'GET' ? {} : { body }),
  });
}

function digest(raw: string): string {
  // Stessa impronta del modulo del corpo, ricalcolata qui apposta: se le due
  // divergessero la firma non tornerebbe mai, ed e' bene che sia un test a
  // dirlo e non un merchant.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('crypto').createHash('sha256').update(raw, 'utf8').digest('base64url');
}

/** La richiesta della strada vecchia: il solo token di lettura. */
function conTokenDiLettura(body = JSON.stringify({ external_id: VISITATORE })): Request {
  return new Request('https://api.kerdon.io/rest/v1/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: TOKEN_LETTURA },
    body,
  });
}

const chiedi = (request: Request, over: Record<string, unknown> = {}) =>
  authorizeIngest(request, {
    scope: 'ingest:browsers',
    route: '/rest/v1/users',
    now: ORA,
    ...over,
  } as never);

let logged: string[];

beforeEach(() => {
  chiavi.length = 0;
  negozi.clear();
  scrittureAdozione.length = 0;
  etichetta = 0;
  clearIngestBuckets();
  clearIngestReplayMemory();
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')));
  delete process.env.INGEST_LEGACY_SUNSET;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.INGEST_LEGACY_SUNSET;
});

describe('la separazione fra chi legge e chi scrive', () => {
  it('una credenziale di ingest firmata scrive', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    const esito = await chiedi(firmata(credenziale));

    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    expect(esito.credential).toBe('ingest');
    expect(esito.ctx.shopId).toBe(shopId);
  });

  it('un token di sola lettura non scrive piu niente, passata la data', async () => {
    // E' il buco da cui si parte, chiuso: chi ha una credenziale per farsi
    // SERVIRE i dati non puo' piu' crearne.
    negozioSano();

    const esito = await chiedi(conTokenDiLettura(), {
      now: new Date(new Date(INGEST_LEGACY_SUNSET_DEFAULT).getTime() + 1_000),
    });

    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
    expect(logged.join('\n')).toContain('legacy_sunset');
  });

  it('la credenziale di ingest presentata tale e quale non vale, mai', async () => {
    // Se bastasse mandarla come si manda quella di lettura, la firma non
    // servirebbe a niente e il segreto tornerebbe a viaggiare sul filo a ogni
    // richiesta: sarebbe la stessa falla con un nome nuovo.
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    const comeSeFosseUnToken = new Request('https://api.kerdon.io/rest/v1/users', {
      method: 'POST',
      headers: { apikey: credenziale.value },
      body: '{}',
    });

    const esito = await chiedi(comeSeFosseUnToken);
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
    // Riconosciuta pero': "l'ho incollata al posto dell'altra" e' l'errore piu'
    // probabile di tutta questa configurazione, e nel log si distingue.
    expect(logged.join('\n')).toContain('ingest_key_presented_as_bearer');
  });

  it('e nemmeno un valore che somiglia a una credenziale di ingest', async () => {
    negozioSano();

    const inventata = new Request('https://api.kerdon.io/rest/v1/users', {
      method: 'POST',
      headers: { apikey: 'kin_inventato.inventatissimo' },
      body: '{}',
    });

    const esito = await chiedi(inventata);
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
    expect(logged.join('\n')).toContain('unknown_credential_shape');
  });

  it('ogni rotta chiede solo il proprio ambito', async () => {
    const shopId = negozioSano();
    const soloEtichette = credenzialeViva(shopId, {}, ['ingest:browsers']);

    const puo = await chiedi(firmata(soloEtichette, { scope: 'ingest:browsers' }));
    expect(puo.ok).toBe(true);

    const nonPuo = await chiedi(
      firmata(soloEtichette, { scope: 'ingest:links', route: '/rest/v1/identify' }),
      { scope: 'ingest:links', route: '/rest/v1/identify' },
    );
    expect(nonPuo.ok).toBe(false);
    if (nonPuo.ok) return;
    expect(nonPuo.response.status).toBe(403);
  });

  it('la capacita di ingest e distinta da quella di lettura: l app sospesa ferma le scritture', async () => {
    // Un negozio sospeso continua a leggere quello che c'e' — dati fermi, ma
    // suoi — e smette di far crescere le sue tabelle.
    const shopId = negozioSano();
    negozi.get(shopId)!.authorization = 'PENDING';
    const credenziale = credenzialeViva(shopId);

    const esito = await chiedi(firmata(credenziale));
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(403);
  });
});

describe('i tetti sul corpo, prima del parse', () => {
  it('il corpo fuori misura si rifiuta con 413', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);
    const enorme = JSON.stringify({ nota: 'x'.repeat(MAX_INGEST_BODY_BYTES) });

    const esito = await chiedi(firmata(credenziale, { body: enorme }));

    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(413);
  });

  it('il JSON troppo profondo si rifiuta senza essere parsato', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);
    const profondo = '['.repeat(MAX_INGEST_JSON_DEPTH + 2) + ']'.repeat(MAX_INGEST_JSON_DEPTH + 2);
    const spia = vi.spyOn(JSON, 'parse');

    const esito = await chiedi(firmata(credenziale, { body: profondo }));

    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(400);
    expect(spia).not.toHaveBeenCalled();
  });
});

describe('la quota', () => {
  it('una raffica sotto soglia passa, quella sopra riceve 429 con Retry-After', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    let passate = 0;
    for (let i = 0; i < INGEST_BUCKET_CAPACITY; i++) {
      const esito = await chiedi(firmata(credenziale));
      if (esito.ok) passate++;
    }
    expect(passate).toBe(INGEST_BUCKET_CAPACITY);

    const oltre = await chiedi(firmata(credenziale));
    expect(oltre.ok).toBe(false);
    if (oltre.ok) return;
    expect(oltre.response.status).toBe(429);
    expect(Number(oltre.response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });
});

describe('la firma e la sua finestra', () => {
  it('una firma valida ripetuta fuori finestra non passa', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    // La stessa identica richiesta, catturata e rigiocata piu' tardi: la firma
    // e' perfettamente valida, l'istante no.
    const catturata = firmata(credenziale);
    const primoInvio = await chiedi(catturata.clone());
    expect(primoInvio.ok).toBe(true);

    const rigiocata = await chiedi(catturata, {
      now: new Date(ORA.getTime() + INGEST_SIGNATURE_WINDOW_MS + 1_000),
    });
    expect(rigiocata.ok).toBe(false);
    if (rigiocata.ok) return;
    expect(rigiocata.response.status).toBe(401);
    expect(logged.join('\n')).toContain('stale_timestamp');
  });

  it('la stessa chiave di idempotenza, dentro la finestra, non passa due volte', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    const messaggio = firmata(credenziale, { idempotencyKey: 'msg-fisso' });
    expect((await chiedi(messaggio.clone())).ok).toBe(true);

    const ripetuto = await chiedi(messaggio);
    expect(ripetuto.ok).toBe(false);
    if (ripetuto.ok) return;
    // 409 e non 401: la credenziale va bene, il messaggio l'avevamo gia' preso.
    expect(ripetuto.response.status).toBe(409);
  });

  it('un corpo cambiato dopo la firma non passa', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    const firmataSuAltro = firmata(credenziale, { body: '{"external_id":"corew_1_a"}' });
    const manomessa = new Request(firmataSuAltro.url, {
      method: 'POST',
      headers: firmataSuAltro.headers,
      body: '{"external_id":"corew_1_b"}',
    });

    const esito = await chiedi(manomessa);
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
    expect(logged.join('\n')).toContain('bad_signature');
  });

  it('una firma per una rotta non vale su un altra', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId, {}, ['ingest:browsers', 'ingest:links']);

    // Firmata per `/rest/v1/users`, presentata su `/rest/v1/identify`.
    const esito = await chiedi(firmata(credenziale, { route: '/rest/v1/users' }), {
      scope: 'ingest:links',
      route: '/rest/v1/identify',
    });

    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
  });

  it('l identificativo di chiave senza le altre intestazioni non ricade sulla strada vecchia', async () => {
    // Ricadere sulla vecchia quando la nuova e' incompleta vorrebbe dire
    // declassare da soli la propria sicurezza: e' come si costruisce un
    // downgrade.
    negozioSano();
    const richiesta = new Request('https://api.kerdon.io/rest/v1/users', {
      method: 'POST',
      headers: { [INGEST_KEY_HEADER]: 'qualcosa', apikey: TOKEN_LETTURA },
      body: '{}',
    });

    const esito = await chiedi(richiesta);
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
    expect(logged.join('\n')).toContain('bad_presentation');
  });
});

describe('rotazione e revoca', () => {
  it('dentro la finestra di sovrapposizione valgono tutte e due', async () => {
    const shopId = negozioSano();
    const vecchia = credenzialeViva(shopId, {
      expiresAt: new Date(ORA.getTime() + 24 * 60 * 60 * 1000),
    });
    const nuova = credenzialeViva(shopId);

    expect((await chiedi(firmata(vecchia))).ok).toBe(true);
    expect((await chiedi(firmata(nuova))).ok).toBe(true);
  });

  it('finita la finestra la vecchia non scrive piu, la nuova si', async () => {
    const shopId = negozioSano();
    const vecchia = credenzialeViva(shopId, { expiresAt: new Date(ORA.getTime() - 1_000) });
    const nuova = credenzialeViva(shopId);

    const scaduta = await chiedi(firmata(vecchia));
    expect(scaduta.ok).toBe(false);
    if (!scaduta.ok) expect(scaduta.response.status).toBe(401);

    expect((await chiedi(firmata(nuova))).ok).toBe(true);
  });

  it('la revoca chiude subito, senza nessuna finestra', async () => {
    const shopId = negozioSano();
    const revocata = credenzialeViva(shopId, { revokedAt: ORA, expiresAt: ORA });

    const esito = await chiedi(firmata(revocata));
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
    // Nel log la revoca si distingue dalla scadenza: una chiave revocata che
    // continua ad arrivare e' una notizia.
    expect(logged.join('\n')).toContain('key_revoked');
  });
});

describe('la metrica di adozione', () => {
  it('segna quale delle due chiavi ha scritto', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    await chiedi(firmata(credenziale));
    await Promise.resolve();

    expect(scrittureAdozione).toContainEqual({ ingestLastSignedAt: ORA });
  });

  it('la strada vecchia si conta a parte: e la lista di chi va aggiornato', async () => {
    negozioSano();

    const esito = await chiedi(conTokenDiLettura());
    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    expect(esito.credential).toBe('legacy_read_token');

    await Promise.resolve();
    expect(scrittureAdozione).toContainEqual({ ingestLastLegacyAt: ORA });
  });
});

describe('cosa finisce nel log', () => {
  it('la rotta, il negozio, la chiave, l esito e i millisecondi', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    const esito = await chiedi(firmata(credenziale));
    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    esito.finish('written');

    const riga = logged.join('\n');
    expect(riga).toContain('[ingest]');
    expect(riga).toContain('/rest/v1/users');
    expect(riga).toContain(shopId);
    expect(riga).toContain(credenziale.keyId);
    expect(riga).toContain('written');
    expect(riga).toContain('"ms"');
  });

  it('nessun dato personale, mai: ne corpo, ne contatti, ne indirizzo, ne chiavi', async () => {
    // Un dato personale in una riga di log e' un dato uscito dal database del
    // merchant e arrivato dove nessuno lo pota e nessuno lo cerchera'.
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    const esito = await chiedi(
      firmata(credenziale, {
        body: JSON.stringify({ external_id: VISITATORE, email: EMAIL, phone: '+393331234567' }),
        headers: { 'x-forwarded-for': '203.0.113.7' },
      }),
    );
    if (esito.ok) esito.finish('linked');

    const riga = logged.join('\n');
    expect(riga).not.toContain(EMAIL);
    expect(riga).not.toContain('393331234567');
    expect(riga).not.toContain(VISITATORE);
    expect(riga).not.toContain('203.0.113.7');
    // Ne' il segreto della credenziale, ne' la chiave di servizio del merchant.
    expect(riga).not.toContain(credenziale.secret);
    expect(riga).not.toContain('chiave-di-servizio-segretissima');
  });

  it('anche i rifiuti scrivono una riga, e non dicono al chiamante quale', async () => {
    negozioSano();

    const esito = await chiedi(
      new Request('https://api.kerdon.io/rest/v1/users', { method: 'POST', body: '{}' }),
    );

    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(await esito.response.json()).toEqual({ error: 'unauthorized' });
    // Il motivo vero — quale dei modi di non avere una credenziale — resta nel
    // log: raccontarlo al chiamante direbbe a chi prova chiavi a caso quanto si
    // e' avvicinato.
    expect(logged.join('\n')).toContain('no_credential');
  });
});
