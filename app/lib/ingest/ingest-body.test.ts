import { describe, it, expect, vi, afterEach } from 'vitest';
import { MAX_INGEST_BODY_BYTES, MAX_INGEST_JSON_DEPTH } from './ingest-model';
import { bodyDigest, readBoundedJsonBody } from './ingest-body.server';

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://api.kerdon.io/rest/v1/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('il corpo dentro i tetti', () => {
  it('passa il corpo piatto che il template manda', async () => {
    const esito = await readBoundedJsonBody(post('{"external_id":"corew_1_x","browser":"Safari"}'));

    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    expect(esito.json).toEqual({ external_id: 'corew_1_x', browser: 'Safari' });
  });

  it('l impronta e quella del testo arrivato, non di una riserializzazione', async () => {
    // Ricalcolarla da un oggetto gia' parsato darebbe una stringa diversa —
    // chiavi in altro ordine, spazi persi — cioe' una firma che non torna mai.
    const raw = '{ "b" : 1,  "a" : 2 }';
    const esito = await readBoundedJsonBody(post(raw));

    expect(esito.ok).toBe(true);
    if (!esito.ok) return;
    expect(esito.digest).toBe(bodyDigest(raw));
    expect(esito.digest).not.toBe(bodyDigest(JSON.stringify(esito.json)));
  });
});

describe('il tetto sui byte', () => {
  it('rifiuta chi dichiara gia una taglia fuori misura, senza leggere niente', async () => {
    const richiesta = post('{}', { 'content-length': String(MAX_INGEST_BODY_BYTES + 1) });
    // Il risparmio: si chiude prima di toccare il flusso.
    const spia = vi.spyOn(richiesta, 'text');

    const esito = await readBoundedJsonBody(richiesta);

    expect(esito).toEqual({ ok: false, refusal: 'too_large' });
    expect(spia).not.toHaveBeenCalled();
  });

  it('rifiuta anche chi la taglia non la dichiara', async () => {
    // Fidarsi di `Content-Length` e basta vorrebbe dire un tetto che si
    // scavalca dicendo un numero.
    const enorme = `{"nota":"${'x'.repeat(MAX_INGEST_BODY_BYTES + 100)}"}`;
    const richiesta = post(enorme);
    richiesta.headers.delete('content-length');

    expect(await readBoundedJsonBody(richiesta)).toEqual({ ok: false, refusal: 'too_large' });
  });

  it('conta i byte e non i caratteri', async () => {
    // Un tetto contato sui caratteri lascerebbe passare il doppio della roba a
    // chi scrive accentato, e il quadruplo in emoji.
    const accentato = `{"nota":"${'è'.repeat(MAX_INGEST_BODY_BYTES)}"}`;
    expect(accentato.length).toBeGreaterThan(MAX_INGEST_BODY_BYTES);

    expect(await readBoundedJsonBody(post(accentato))).toEqual({ ok: false, refusal: 'too_large' });
  });
});

describe('il tetto sulla profondita, prima del parse', () => {
  it('rifiuta il documento annidato senza mai parsarlo', async () => {
    const profondo = '['.repeat(MAX_INGEST_JSON_DEPTH + 2) + ']'.repeat(MAX_INGEST_JSON_DEPTH + 2);
    const spia = vi.spyOn(JSON, 'parse');

    const esito = await readBoundedJsonBody(post(profondo));

    expect(esito).toEqual({ ok: false, refusal: 'too_deep' });
    // E' tutto il punto: contarla dopo vorrebbe dire contarla quando il parse
    // e' gia' avvenuto, cioe' non contarla.
    expect(spia).not.toHaveBeenCalled();
  });

  it('la bomba di parentesi sta nei byte e non nella profondita', async () => {
    const bomba = '['.repeat(5000) + ']'.repeat(5000);
    expect(Buffer.byteLength(bomba)).toBeLessThan(MAX_INGEST_BODY_BYTES);

    expect(await readBoundedJsonBody(post(bomba))).toEqual({ ok: false, refusal: 'too_deep' });
  });
});

describe('quel che non e un oggetto', () => {
  it('il JSON illeggibile si rifiuta', async () => {
    expect(await readBoundedJsonBody(post('{non json'))).toEqual({
      ok: false,
      refusal: 'malformed',
    });
  });

  it('un array o un numero non sono "quasi giusti"', async () => {
    // Le rotte leggono chiavi per nome: su un valore senza chiavi leggerebbero
    // `undefined` ovunque, cioe' andrebbero avanti con un corpo vuoto.
    expect(await readBoundedJsonBody(post('[1,2,3]'))).toEqual({ ok: false, refusal: 'malformed' });
    expect(await readBoundedJsonBody(post('42'))).toEqual({ ok: false, refusal: 'malformed' });
    expect(await readBoundedJsonBody(post('null'))).toEqual({ ok: false, refusal: 'malformed' });
  });
});
