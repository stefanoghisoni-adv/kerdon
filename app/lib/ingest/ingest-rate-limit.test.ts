import { describe, it, expect, beforeEach } from 'vitest';
import { INGEST_BUCKET_CAPACITY, INGEST_SOURCE_CAPACITY } from './ingest-model';
import { clearIngestBuckets, requestSource, takeIngestSlot } from './ingest-rate-limit.server';

const ORA = 1_000_000;

beforeEach(() => {
  clearIngestBuckets();
});

/** Una raffica di `quante` richieste nello stesso istante. */
function raffica(quante: number, params: { shopId: string; keyId: string; source?: string | null }) {
  const esiti = [];
  for (let i = 0; i < quante; i++) {
    esiti.push(takeIngestSlot({ ...params, source: params.source ?? null, now: ORA }));
  }
  return esiti;
}

describe('la raffica che un container server-side fa davvero', () => {
  it('sotto la soglia passa tutta', () => {
    // Il traffico di una vetrina non e' costante: e' una campagna che parte, un
    // post che gira. Una soglia tarata sulla media rifiuterebbe proprio il
    // momento per cui il merchant ci paga.
    const esiti = raffica(INGEST_BUCKET_CAPACITY, { shopId: 's1', keyId: 'k1' });
    expect(esiti.every((e) => e.allowed)).toBe(true);
  });

  it('sopra la soglia riceve un rifiuto con un tempo di attesa', () => {
    raffica(INGEST_BUCKET_CAPACITY, { shopId: 's1', keyId: 'k1' });

    const oltre = takeIngestSlot({ shopId: 's1', keyId: 'k1', source: null, now: ORA });
    expect(oltre.allowed).toBe(false);
    expect(oltre.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(oltre.bucket).toBe('credential');
  });

  it('il tempo che passa riapre', () => {
    raffica(INGEST_BUCKET_CAPACITY + 5, { shopId: 's1', keyId: 'k1' });

    const dopoUnSecondo = takeIngestSlot({
      shopId: 's1',
      keyId: 'k1',
      source: null,
      now: ORA + 1_000,
    });
    expect(dopoUnSecondo.allowed).toBe(true);
  });
});

describe('i secchielli sono separati', () => {
  it('la raffica di un negozio non tocca quella di un altro', () => {
    raffica(INGEST_BUCKET_CAPACITY + 10, { shopId: 's1', keyId: 'k1' });

    expect(takeIngestSlot({ shopId: 's2', keyId: 'k2', source: null, now: ORA }).allowed).toBe(true);
  });

  it('due credenziali dello stesso negozio hanno due quote', () => {
    // Serve alla rotazione: chi ha gia' pubblicato la chiave nuova non deve
    // pagare la raffica di chi sta ancora usando la vecchia.
    raffica(INGEST_BUCKET_CAPACITY + 10, { shopId: 's1', keyId: 'vecchia' });

    expect(takeIngestSlot({ shopId: 's1', keyId: 'nuova', source: null, now: ORA }).allowed).toBe(
      true,
    );
  });
});

describe('l indirizzo IP e un segnale, non un identita', () => {
  it('chi non ha un indirizzo leggibile non viene penalizzato', () => {
    // Nessun secchiello per provenienza si applica: si passa sul solo conto del
    // negozio.
    const esiti = raffica(INGEST_SOURCE_CAPACITY + 20, { shopId: 's1', keyId: 'k1', source: null });
    expect(esiti.every((e) => e.allowed)).toBe(true);
  });

  it('una sola provenienza impazzita non consuma la quota di tutte le altre', () => {
    raffica(INGEST_SOURCE_CAPACITY + 5, { shopId: 's1', keyId: 'k1', source: '1.2.3.4' });

    const stessaProvenienza = takeIngestSlot({
      shopId: 's1',
      keyId: 'k1',
      source: '1.2.3.4',
      now: ORA,
    });
    expect(stessaProvenienza.allowed).toBe(false);
    expect(stessaProvenienza.bucket).toBe('source');

    // Un'altra provenienza dello stesso negozio continua a passare: e' una
    // ripartizione DENTRO la quota, non un cancello davanti.
    const altra = takeIngestSlot({ shopId: 's1', keyId: 'k1', source: '5.6.7.8', now: ORA });
    expect(altra.allowed).toBe(true);
  });

  it('lo stesso indirizzo su due negozi non somma il traffico dei due', () => {
    // Sarebbe l'indirizzo usato come identita': un container condiviso da
    // un'agenzia serve piu' negozi, e sono traffici diversi.
    raffica(INGEST_SOURCE_CAPACITY + 5, { shopId: 's1', keyId: 'k1', source: '1.2.3.4' });

    expect(
      takeIngestSlot({ shopId: 's2', keyId: 'k2', source: '1.2.3.4', now: ORA }).allowed,
    ).toBe(true);
  });
});

describe('da dove si legge la provenienza', () => {
  const req = (headers: Record<string, string>) =>
    new Request('https://api.kerdon.io/rest/v1/users', { headers });

  it('il primo valore di X-Forwarded-For', () => {
    expect(requestSource(req({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }))).toBe('1.2.3.4');
  });

  it('con ripiego su X-Real-IP', () => {
    expect(requestSource(req({ 'x-real-ip': '1.2.3.4' }))).toBe('1.2.3.4');
  });

  it('null quando non si sa, e non e un problema da segnalare', () => {
    expect(requestSource(req({}))).toBeNull();
  });
});
