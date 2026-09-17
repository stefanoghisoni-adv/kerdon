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
    // SOLO PER IDENTIFICATIVO. Il negozio si trovava anche dal codice di
    // controllo del token di LETTURA, ed era la strada vecchia. Il database
    // finto non sa piu' rispondere a quella domanda apposta: se qualcuno la
    // rifacesse, questi test direbbero "negozio sconosciuto" invece di passare
    // in silenzio.
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      typeof where.id === 'string' ? (negozi.get(where.id) ?? null) : null,
    ),
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashReadProxyToken } from '~/lib/read-proxy/token.server';
import {
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
    trackingSetup: { ingestLastSignedAt: null },
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

/**
 * La richiesta come la manda un container rimasto sulla chiave di LETTURA.
 *
 * Non e' il ricordo di una strada che c'era: e' il campo compilato con la chiave
 * sbagliata, che resta l'errore piu' probabile di tutta la configurazione — le
 * due chiavi si copiano dalla stessa card, a pochi centimetri l'una dall'altra.
 * Quel che questi test provano e' che da qui non si scrive, e che il log lo dice
 * in un modo che chi guarda riconosce.
 */
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('la separazione fra chi legge e chi scrive', () => {
  it('una credenziale di ingest firmata scrive', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    const esito = await chiedi(firmata(credenziale));

    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    expect(esito.presentation).toBe('signed');
    expect(esito.ctx.shopId).toBe(shopId);
  });

  it('un token di sola lettura non scrive, e non c e nessuna data che lo permetta', async () => {
    // E' il buco da cui si parte, chiuso: chi ha una credenziale per farsi
    // SERVIRE i dati non puo' crearne. C'e' stata una fase in cui qui passava
    // fino a una data; questo test e' quel che resta di quella fase, ed e'
    // girato — vale OGGI, non "dopo il primo dicembre".
    negozioSano();

    const esito = await chiedi(conTokenDiLettura());

    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
  });

  it('il rifiuto si riconosce nel log: e la chiave sbagliata, non l assenza di chiave', async () => {
    // Fra "il container non manda niente" e "il container manda la chiave di
    // lettura" ci sono due rimedi diversi, e chi legge il log deve poterli
    // distinguere senza indovinare: e' il guasto di configurazione piu'
    // probabile che ci sia.
    negozioSano();

    await chiedi(conTokenDiLettura());
    const conChiave = logged.join('\n');

    await chiedi(
      new Request('https://api.kerdon.io/rest/v1/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    const senzaChiave = logged.join('\n').slice(conChiave.length);

    expect(conChiave).toContain('read_key_on_write_route');
    expect(conChiave).toContain('"via":"read_key"');
    expect(senzaChiave).toContain('no_credential');
    expect(senzaChiave).not.toContain('read_key_on_write_route');
  });

  it('nessuna variabile d ambiente riapre la strada vecchia', async () => {
    // La fase di convivenza si spegneva a una data, e la data si poteva
    // anticipare da `INGEST_LEGACY_SUNSET`. Il rischio di aver solo spostato la
    // data e' che quella leva resti: questo test dice che non c'e' piu' niente
    // da spostare, e fallisce il giorno in cui qualcuno rimette il ramo.
    negozioSano();
    process.env.INGEST_LEGACY_SUNSET = '2099-01-01T00:00:00.000Z';

    try {
      const esito = await chiedi(conTokenDiLettura());
      expect(esito.ok).toBe(false);
      if (esito.ok) return;
      expect(esito.response.status).toBe(401);
    } finally {
      delete process.env.INGEST_LEGACY_SUNSET;
    }
  });

  it('il database non viene nemmeno interrogato per una chiave che non e di invio', async () => {
    // Un valore a caso su una rotta pubblica non deve costare una lettura: il
    // prefisso si guarda sulle stringhe, e chi non ce l'ha esce prima di
    // toccare il negozio. Senza questo, chi mitraglia valori qualsiasi si
    // comprerebbe una interrogazione per ognuno.
    negozioSano();

    await chiedi(conTokenDiLettura());

    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
  });

  it('la credenziale di ingest vale anche presentata tale e quale', async () => {
    // La firma resta la forma piu' forte, ma non e' l'unica ammessa: il
    // container server-side del merchant non puo' firmare — la chiave dovrebbe
    // stare in un file sul server, e su un provider gestito non si puo' mettere.
    // Pretenderla avrebbe lasciato tutti sulla chiave di LETTURA, che e' la
    // falla vera: chi legge non deve poter scrivere. Cosi' il privilegio e'
    // separato; il replay resta aperto, e sta scritto dov'e' il codice.
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    const comeUnToken = new Request('https://api.kerdon.io/rest/v1/users', {
      method: 'POST',
      headers: { apikey: credenziale.value },
      body: '{}',
    });

    const esito = await chiedi(comeUnToken);
    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    expect(esito.presentation).toBe('ingest_bearer');
  });

  it('una credenziale revocata non passa nemmeno presentata tale e quale', async () => {
    const shopId = negozioSano();
    const revocata = credenzialeViva(shopId, { revokedAt: new Date() });

    const esito = await chiedi(
      new Request('https://api.kerdon.io/rest/v1/users', {
        method: 'POST',
        headers: { apikey: revocata.value },
        body: '{}',
      }),
    );
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
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
    // "kin_" ben formato ma sconosciuto: si distingue da una forma che non e'
    // nemmeno una credenziale, perche' il rimedio e' diverso — qui il merchant
    // ha incollato una chiave revocata o di un altro negozio.
    expect(logged.join('\n')).toContain('bearer_key_unknown');
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

describe('la nota di adozione', () => {
  it('segna che da questo negozio e arrivato qualcosa', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);

    await chiedi(firmata(credenziale));
    await Promise.resolve();

    expect(scrittureAdozione).toContainEqual({ ingestLastSignedAt: ORA });
  });

  it('la strada vecchia non lascia piu niente da contare', async () => {
    // `ingestLastLegacyAt` misurava chi era ancora indietro. Adesso indietro non
    // ci si puo' stare — si e' fermi — e la colonna non deve piu' ricevere
    // niente: una data che continuasse ad aggiornarsi direbbe che quella strada
    // esiste ancora.
    negozioSano();

    await chiedi(conTokenDiLettura());
    await Promise.resolve();

    expect(scrittureAdozione).toEqual([]);
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


/* -------------------------------------------------------------------------- */
/* Le due meta': il template del container e questo cancello                   */
/* -------------------------------------------------------------------------- */

/**
 * La credenziale, provata da tutte e due le parti nello stesso test.
 *
 * IL TEMPLATE CHE IL MERCHANT IMPORTA NEL PROPRIO CONTAINER COMPONE DA SOLO LE
 * INTESTAZIONI CON CUI SI PRESENTA, in un linguaggio che non e' TypeScript,
 * dentro un file che nessun import tiene legato a questo. Sono due meta' della
 * stessa cosa: da una parte si decide in che campo la chiave di invio viaggia,
 * dall'altra da quale campo si raccoglie e da quale prefisso si capisce quale
 * delle due credenziali sia arrivata. Basta che una delle due si sposti perche'
 * il negozio smetta di essere riconosciuto.
 *
 * E il modo in cui si romperebbe e' il peggiore possibile. Non un errore di
 * compilazione, non un test rosso: il tracciamento fermo in un negozio solo —
 * quello che ha appena aggiornato il container — senza niente che lo spieghi, e
 * un merchant che se ne accorge dai dati che non arrivano piu'. E' gia'
 * successo con i cookie, e la lezione e' che il container va provato da qui.
 *
 * Quindi il template non si LEGGE, si ESEGUE. Si estrae dal `.tpl` la parte fra
 * i due marcatori, le si danno le poche cose del sandbox che usa — i campi
 * compilati e la riga di diagnostica — e le intestazioni che produce si
 * consegnano ad `authorizeIngest`, quello vero.
 *
 * COSA QUESTO TEST NON PUO' DIRE, e va detto qui perche' nessuno lo scopra
 * dopo: non dice che il sandbox di Google esegua quel codice, ne' che il
 * container inoltri l'intestazione senza toccarla. Quello resta da verificare
 * sul container di anteprima. Quel che dice e' l'altra meta', cioe' la sola che
 * si possa sbagliare in silenzio: che il campo, il valore e il prefisso siano
 * gli stessi da una parte e dall'altra, e che il cancello ci veda una chiave di
 * invio e non la vecchia.
 */

const TEMPLATE = readFileSync(
  resolve(__dirname, '../../../integrations/sgtm/kerdon-id-client.tpl'),
  'utf8',
);

/** Una sezione del `.tpl`, per nome. */
function sezione(nome: string): string {
  const apertura = `___${nome}___`;
  const inizio = TEMPLATE.indexOf(apertura);
  if (inizio < 0) throw new Error(`il template non ha piu' la sezione ${nome}`);
  const resto = TEMPLATE.slice(inizio + apertura.length);
  const fine = resto.search(/\n___[A-Z_]+___/);
  return (fine < 0 ? resto : resto.slice(0, fine)).trim();
}

/**
 * Una costante del template, presa dal template.
 *
 * Ricopiarne il valore qui dentro sarebbe comodo e direbbe un'altra cosa: che
 * il test e' d'accordo con se stesso. Il nome dell'intestazione con cui si
 * rimanda l'identificativo gia' noto e' del `.tpl`, e di li' deve arrivare.
 */
function costanteDelTemplate(nome: string): string {
  const trovata = new RegExp(`const ${nome} = '([^']*)';`).exec(TEMPLATE);
  if (!trovata) throw new Error(`il template non dichiara piu' ${nome}`);
  return trovata[1];
}

/**
 * La parte del template che compone le intestazioni, eseguita davvero.
 *
 * I marcatori sono nel `.tpl` apposta: senza, questo test dovrebbe indovinare
 * dove comincia e dove finisce, e il giorno in cui qualcuno sposta una riga
 * proverebbe altro senza accorgersene. Se spariscono, si ferma qui con un
 * messaggio che dice cosa e' successo — non con un confronto che passa a vuoto.
 */
function templateInviante(opzioni: { ingestKey: string }) {
  const APRE = '// INVIO:INIZIO';
  const CHIUDE = '// INVIO:FINE';
  const inizio = TEMPLATE.indexOf(APRE);
  const fine = TEMPLATE.indexOf(CHIUDE);
  if (inizio < 0 || fine < inizio) {
    throw new Error(
      "i marcatori INVIO:INIZIO/INVIO:FINE non sono piu' nel template: senza, il modo in cui il container si presenta non e' piu' provato da nessuna parte",
    );
  }
  const sorgente = TEMPLATE.slice(inizio + APRE.length, fine);

  const detto: string[] = [];

  const fabbrica = new Function(
    'data',
    'ID_HEADER',
    'logToConsole',
    `${sorgente}
     return { KEY_HEADER, INGEST_PREFIX, upstreamHeaders };`,
  ) as (...api: unknown[]) => {
    KEY_HEADER: string;
    INGEST_PREFIX: string;
    upstreamHeaders: (existing?: string) => Record<string, string>;
  };

  const api = fabbrica(
    { ingestKey: opzioni.ingestKey },
    costanteDelTemplate('ID_HEADER'),
    (riga: string) => void detto.push(riga),
  );

  return { ...api, detto };
}

describe('come il container server-side si presenta, e cosa il cancello ne fa', () => {
  it("il template non porta piu' la credenziale con cui si leggono i dati", () => {
    // Il rilievo da cui nasce tutto questo: `apikey: data.readToken` su una
    // rotta che CONIA un identificativo e ne scrive la riga. Una credenziale di
    // sola lettura che scriveva con i privilegi massimi. Il campo resta uno
    // solo, ma adesso vuole l'altra chiave.
    expect(TEMPLATE).not.toContain('readToken');
    expect(TEMPLATE).not.toMatch(/chiave di lettura/i);

    const campi = JSON.parse(sezione('TEMPLATE_PARAMETERS')) as Array<{
      name: string;
      displayName: string;
      help?: string;
    }>;
    expect(campi.map((c) => c.name)).toEqual([
      'requestPath',
      'kerdonUrl',
      'ingestKey',
      'storefrontDomain',
      'cookieMaxAge',
    ]);

    // Il campo dev'essere leggibile da chi ha due chiavi davanti e deve
    // sceglierne una: e' l'errore piu' probabile di tutta la configurazione, e
    // il prefisso e' l'unica cosa che lo rende impossibile da sbagliare in
    // silenzio.
    const campo = campi.find((c) => c.name === 'ingestKey')!;
    expect(campo.displayName.toLowerCase()).toContain('chiave di invio');
    expect(`${campo.displayName} ${campo.help ?? ''}`).toContain('kin_');
  });

  it("manda la chiave di invio intera, nel campo dove il cancello la cerca", () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);
    const template = templateInviante({ ingestKey: credenziale.value });

    const intestazioni = template.upstreamHeaders();
    // Una sola intestazione quando non c'e' niente da rimandare: quel che parte
    // e' esattamente la credenziale, e non un contorno che il cancello
    // ignorerebbe.
    expect(Object.keys(intestazioni)).toEqual([template.KEY_HEADER]);
    expect(intestazioni[template.KEY_HEADER]).toBe(credenziale.value);
    expect(template.detto).toEqual([]);

    // E l'identificativo gia' noto viaggia con il nome che il template dichiara
    // in cima a se stesso, non con uno scritto qui.
    const conEsistente = template.upstreamHeaders(VISITATORE);
    expect(conEsistente[costanteDelTemplate('ID_HEADER')]).toBe(VISITATORE);
  });

  it('le intestazioni che produce passano il cancello vero', async () => {
    const shopId = negozioSano();
    const credenziale = credenzialeViva(shopId);
    const template = templateInviante({ ingestKey: credenziale.value });

    const esito = await authorizeIngest(
      new Request('https://api.kerdon.io/rest/v1/tracking_id?consent=v1.a1.m1', {
        method: 'GET',
        headers: template.upstreamHeaders(),
      }),
      { scope: 'ingest:identity', route: '/rest/v1/tracking_id', body: 'none', now: ORA },
    );

    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    // Nella forma che non chiude il replay: il log deve poterlo dire, perche' e'
    // la sola domanda a cui serve rispondere guardando il traffico vero.
    expect(esito.presentation).toBe('ingest_bearer');
  });

  it('una chiave revocata non passa, per quanto il container sia convinto', async () => {
    const shopId = negozioSano();
    const revocata = credenzialeViva(shopId, { revokedAt: new Date('2026-09-01T00:00:00.000Z') });
    const template = templateInviante({ ingestKey: revocata.value });

    const esito = await authorizeIngest(
      new Request('https://api.kerdon.io/rest/v1/tracking_id', {
        method: 'GET',
        headers: template.upstreamHeaders(),
      }),
      { scope: 'ingest:identity', route: '/rest/v1/tracking_id', body: 'none', now: ORA },
    );

    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
    // Una chiave revocata che continua ad arrivare e' una notizia, e nel log si
    // distingue da un valore inventato: e' il container di qualcuno che non ha
    // ancora ripubblicato.
    expect(logged.join('\n')).toContain('key_revoked');
  });

  it("gli ambiti valgono anche qui: senza `ingest:identity` non si conia niente", async () => {
    const shopId = negozioSano();
    // Una credenziale vera dello stesso negozio, emessa per altro. Presentata
    // intera non diventa piu' potente di com'e' stata emessa: e' la meta' della
    // separazione che la strada senza firma deve mantenere intatta.
    const credenziale = credenzialeViva(shopId, {}, ['ingest:browsers']);
    const template = templateInviante({ ingestKey: credenziale.value });

    const esito = await authorizeIngest(
      new Request('https://api.kerdon.io/rest/v1/tracking_id', {
        method: 'GET',
        headers: template.upstreamHeaders(),
      }),
      { scope: 'ingest:identity', route: '/rest/v1/tracking_id', body: 'none', now: ORA },
    );

    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    // 403 e non 401: la credenziale c'e' ed e' valida, non e' stata emessa per
    // questo. A chi sta configurando la differenza dice dove guardare.
    expect(esito.response.status).toBe(403);
    expect(logged.join('\n')).toContain('key_out_of_scope');
  });

  it('un campo compilato con la chiave sbagliata parte lo stesso, e viene rifiutato', async () => {
    // Il negozio c'e' ed e' sano, e quel token di lettura e' davvero il suo:
    // il rifiuto non arriva da un negozio che non esiste.
    negozioSano();
    const template = templateInviante({ ingestKey: TOKEN_LETTURA });

    // La chiamata parte: fermarla nel container non salverebbe niente — il
    // tracciamento e' fermo comunque — e toglierebbe a chi installa la sola
    // prova che puo' guardare, cioe' la risposta del server accanto alla riga
    // in anteprima.
    expect(template.upstreamHeaders()[template.KEY_HEADER]).toBe(TOKEN_LETTURA);
    // L'avviso in anteprima nomina il prefisso, che e' quel che distingue le due
    // chiavi nella card da cui si copiano.
    expect(template.detto.join(' ')).toContain(template.INGEST_PREFIX);

    const esito = await authorizeIngest(
      new Request('https://api.kerdon.io/rest/v1/tracking_id?consent=v1.a1.m1', {
        method: 'GET',
        headers: template.upstreamHeaders(),
      }),
      { scope: 'ingest:identity', route: '/rest/v1/tracking_id', body: 'none', now: ORA },
    );

    // E il cancello la rifiuta, con l'esito che dice quale dei due guasti e':
    // la chiave sbagliata, non la chiave mancante.
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.response.status).toBe(401);
    expect(logged.join('\n')).toContain('read_key_on_write_route');
  });

  it('i permessi dichiarati sono quelli che il codice usa davvero', () => {
    const permessi = JSON.parse(sezione('SERVER_PERMISSIONS')) as Array<{
      instance: {
        key: { publicId: string };
        param?: Array<{ key: string; value: { listItem?: Array<{ string?: string }> } }>;
      };
    }>;
    const dichiarati = permessi.map((p) => p.instance.key.publicId);

    // Il permesso della firma se n'e' andato con la firma. Un permesso in piu'
    // non e' innocuo: chi importa il modello lo vede e crede che serva, e cerca
    // di soddisfarlo.
    expect(dichiarati).not.toContain('use_custom_private_keys');
    expect(TEMPLATE).not.toContain("require('hmacSha256')");
    expect(TEMPLATE).not.toContain('SGTM_CREDENTIALS');

    // I cookie invece restano tutti e due, per tutte e due le epoche dei nomi:
    // in un browser che aveva gia' risposto il permesso sta sotto il nome
    // vecchio, e non leggerlo vorrebbe dire trattare come silenzio un si' gia'
    // dato.
    const cookieLetti = (
      permessi.find((p) => p.instance.key.publicId === 'get_cookies')!.instance.param ?? []
    )
      .filter((par) => par.key === 'cookieNames')
      .flatMap((par) => (par.value.listItem ?? []).map((voce) => voce.string));
    expect(cookieLetti).toEqual(
      expect.arrayContaining(['kerdon_consent', 'corew_consent', '_tracking_consent', 'kerdon_eid', 'corew_eid']),
    );

    // E la riga di diagnostica ha bisogno del suo, altrimenti chi compila il
    // campo con la chiave sbagliata non vede niente nemmeno in anteprima.
    expect(dichiarati).toContain('logging');
  });
});
