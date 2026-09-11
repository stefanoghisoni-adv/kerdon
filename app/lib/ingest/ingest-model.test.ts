import { describe, it, expect } from 'vitest';
import {
  INGEST_AUDIENCE,
  INGEST_BUCKET_CAPACITY,
  INGEST_LEGACY_SUNSET_DEFAULT,
  INGEST_SCOPES,
  MAX_INGEST_JSON_DEPTH,
  adoptionNeedsWrite,
  canonicalIngestPayload,
  ingestKeyRefusal,
  isIngestScope,
  jsonDepthWithin,
  legacySunsetAt,
  legacyWriteStillAllowed,
  takeToken,
  timestampWithinWindow,
} from './ingest-model';

const ORA = new Date('2026-09-11T12:00:00.000Z');

const chiave = (over: Record<string, unknown> = {}) => ({
  audience: INGEST_AUDIENCE,
  scopes: [...INGEST_SCOPES],
  revokedAt: null,
  expiresAt: null,
  ...over,
});

describe('gli ambiti', () => {
  it('sono tre e separati: identificativo, browser, legami', () => {
    // Uno solo avrebbe dato a chi installa il ponte in vetrina — che ha bisogno
    // del primo — anche il terzo, cioe' il permesso di legare un browser a una
    // persona. E' lo stesso errore da cui si parte, in piccolo.
    expect([...INGEST_SCOPES]).toEqual(['ingest:identity', 'ingest:browsers', 'ingest:links']);
  });

  it('non riconosce quel che non e nell elenco', () => {
    expect(isIngestScope('ingest:tutto')).toBe(false);
    expect(isIngestScope('use_read_proxy')).toBe(false);
  });
});

describe('quando una credenziale vale', () => {
  it('passa quando e viva, per il destinatario giusto e con l ambito chiesto', () => {
    expect(ingestKeyRefusal(chiave(), 'ingest:links', ORA)).toBeNull();
  });

  it('la revoca batte tutto, anche una scadenza gia passata', () => {
    // L'ordine conta: una chiave revocata che continua ad arrivare e' una
    // notizia, e nel log dev'essere quella a comparire.
    const revocata = chiave({
      revokedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(ingestKeyRefusal(revocata, 'ingest:links', ORA)).toBe('revoked');
  });

  it('la finestra di sovrapposizione vale fino all istante, non oltre', () => {
    const unMinutoPrima = chiave({ expiresAt: new Date(ORA.getTime() + 60_000) });
    expect(ingestKeyRefusal(unMinutoPrima, 'ingest:links', ORA)).toBeNull();

    const scadutaOra = chiave({ expiresAt: ORA });
    expect(ingestKeyRefusal(scadutaOra, 'ingest:links', ORA)).toBe('expired');
  });

  it('una credenziale rivolta a un altro destinatario non vale qui', () => {
    expect(ingestKeyRefusal(chiave({ audience: 'read' }), 'ingest:links', ORA)).toBe(
      'wrong_audience',
    );
  });

  it('chi puo scrivere le etichette non puo legare un browser a una persona', () => {
    const soloEtichette = chiave({ scopes: ['ingest:browsers'] });
    expect(ingestKeyRefusal(soloEtichette, 'ingest:browsers', ORA)).toBeNull();
    expect(ingestKeyRefusal(soloEtichette, 'ingest:links', ORA)).toBe('out_of_scope');
  });
});

describe('la profondita del JSON, contata sul testo', () => {
  it('lascia passare il corpo piatto che le rotte accettano', () => {
    expect(jsonDepthWithin('{"external_id":"corew_1_x","email":"a@b.it"}')).toBe(true);
  });

  it('rifiuta l annidamento oltre il tetto', () => {
    const profondo = '['.repeat(MAX_INGEST_JSON_DEPTH + 1) + ']'.repeat(MAX_INGEST_JSON_DEPTH + 1);
    expect(jsonDepthWithin(profondo)).toBe(false);
  });

  it('un documento di sole parentesi sta comodo nei byte e non nella profondita', () => {
    // E' il caso che il solo tetto sui byte non copre: poche migliaia di
    // caratteri, decine di migliaia di frame di stack su un parser ricorsivo.
    const bomba = '['.repeat(5000) + ']'.repeat(5000);
    expect(bomba.length).toBeLessThan(16 * 1024);
    expect(jsonDepthWithin(bomba)).toBe(false);
  });

  it('le parentesi dentro una stringa sono testo, non annidamento', () => {
    // Contarle vorrebbe dire rifiutare un valore con una graffa dentro: una
    // difesa trasformata in guasto per chi non c'entra niente.
    expect(jsonDepthWithin('{"nota":"{{{{{{{{{{{{{{{{"}')).toBe(true);
  });

  it('la virgoletta protetta non fa credere di essere usciti dalla stringa', () => {
    expect(jsonDepthWithin('{"nota":"dice \\"[[[[[[[[[\\" e basta"}')).toBe(true);
  });
});

describe('la finestra della firma', () => {
  it('accetta l istante esatto e i minuti attorno', () => {
    expect(timestampWithinWindow(ORA.getTime(), ORA)).toBe(true);
    expect(timestampWithinWindow(ORA.getTime() - 4 * 60_000, ORA)).toBe(true);
  });

  it('rifiuta quel che e troppo vecchio', () => {
    expect(timestampWithinWindow(ORA.getTime() - 6 * 60_000, ORA)).toBe(false);
  });

  it('rifiuta anche quel che e datato nel futuro', () => {
    // Simmetrica di proposito: un chiamante onesto non ha motivo di datare
    // avanti, e una finestra "solo all'indietro" si allunga quanto si vuole.
    expect(timestampWithinWindow(ORA.getTime() + 6 * 60_000, ORA)).toBe(false);
  });

  it('un istante che non e un numero non e dentro nessuna finestra', () => {
    expect(timestampWithinWindow(Number.NaN, ORA)).toBe(false);
  });
});

describe('la stringa firmata', () => {
  const base = {
    scope: 'ingest:links' as const,
    timestampMs: ORA.getTime(),
    method: 'post',
    path: '/rest/v1/identify',
    bodyDigest: 'abc',
    idempotencyKey: 'k1',
  };

  it('dichiara versione e destinatario', () => {
    const righe = canonicalIngestPayload(base).split('\n');
    expect(righe[0]).toBe('v1');
    expect(righe[1]).toBe('ingest');
  });

  it('il metodo entra sempre in maiuscolo', () => {
    expect(canonicalIngestPayload(base)).toBe(
      canonicalIngestPayload({ ...base, method: 'POST' }),
    );
  });

  it('cambiare ambito, percorso, corpo o idempotenza cambia la stringa', () => {
    const originale = canonicalIngestPayload(base);
    expect(canonicalIngestPayload({ ...base, scope: 'ingest:browsers' })).not.toBe(originale);
    expect(canonicalIngestPayload({ ...base, path: '/rest/v1/users' })).not.toBe(originale);
    expect(canonicalIngestPayload({ ...base, bodyDigest: 'abd' })).not.toBe(originale);
    expect(canonicalIngestPayload({ ...base, idempotencyKey: 'k2' })).not.toBe(originale);
    expect(canonicalIngestPayload({ ...base, timestampMs: base.timestampMs + 1 })).not.toBe(
      originale,
    );
  });

  it('due composizioni diverse non producono la stessa stringa', () => {
    // Il separatore a capo serve a questo: senza, `ab`+`c` e `a`+`bc` sarebbero
    // la stessa firma.
    const a = canonicalIngestPayload({ ...base, path: '/rest/v1/user', bodyDigest: 's-abc' });
    const b = canonicalIngestPayload({ ...base, path: '/rest/v1/users', bodyDigest: 'abc' });
    expect(a).not.toBe(b);
  });
});

describe('il secchiello', () => {
  it('una raffica sotto la capienza passa tutta', () => {
    let bucket = undefined as Parameters<typeof takeToken>[0];
    let passate = 0;
    for (let i = 0; i < INGEST_BUCKET_CAPACITY; i++) {
      const esito = takeToken(bucket, 1_000, INGEST_BUCKET_CAPACITY, 40);
      bucket = esito.next;
      if (esito.allowed) passate++;
    }
    expect(passate).toBe(INGEST_BUCKET_CAPACITY);
  });

  it('il gettone dopo l ultimo riceve un tempo di attesa, mai zero', () => {
    let bucket = undefined as Parameters<typeof takeToken>[0];
    for (let i = 0; i < INGEST_BUCKET_CAPACITY; i++) {
      bucket = takeToken(bucket, 1_000, INGEST_BUCKET_CAPACITY, 40).next;
    }
    const oltre = takeToken(bucket, 1_000, INGEST_BUCKET_CAPACITY, 40);
    expect(oltre.allowed).toBe(false);
    expect(oltre.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('il tempo che passa ricarica, fino alla capienza e non oltre', () => {
    const vuoto = { tokens: 0, updatedAt: 0 };
    // Dieci secondi a quaranta al secondo sarebbero quattrocento gettoni: il
    // tetto resta la capienza.
    const dopo = takeToken(vuoto, 10_000, INGEST_BUCKET_CAPACITY, 40);
    expect(dopo.allowed).toBe(true);
    expect(dopo.next.tokens).toBe(INGEST_BUCKET_CAPACITY - 1);
  });

  it('un orologio che va indietro non toglie gettoni', () => {
    const pieno = { tokens: 10, updatedAt: 5_000 };
    const esito = takeToken(pieno, 1_000, INGEST_BUCKET_CAPACITY, 40);
    expect(esito.allowed).toBe(true);
    expect(esito.next.tokens).toBe(9);
  });

  it('un rifiuto riscrive comunque lo stato, cosi il secchiello si ricarica', () => {
    // Senza, una raffica di rifiuti congelerebbe l'istante e il secchiello non
    // tornerebbe mai pieno.
    const vuoto = { tokens: 0, updatedAt: 0 };
    const rifiutato = takeToken(vuoto, 10, INGEST_BUCKET_CAPACITY, 40);
    expect(rifiutato.allowed).toBe(false);
    expect(rifiutato.next.updatedAt).toBe(10);
  });
});

describe('la data di spegnimento della strada vecchia', () => {
  it('senza configurazione vale quella scritta nel codice', () => {
    expect(legacySunsetAt(undefined).toISOString()).toBe(INGEST_LEGACY_SUNSET_DEFAULT);
    expect(legacySunsetAt('non e una data').toISOString()).toBe(INGEST_LEGACY_SUNSET_DEFAULT);
  });

  it('l ambiente puo solo anticiparla', () => {
    // Poterla spostare in avanti vorrebbe dire rimandare la fine della fase di
    // convivenza con una riga di configurazione: e' cosi' che una fase breve
    // diventa permanente.
    expect(legacySunsetAt('2026-10-01T00:00:00.000Z').toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    expect(legacySunsetAt('2030-01-01T00:00:00.000Z').toISOString()).toBe(
      INGEST_LEGACY_SUNSET_DEFAULT,
    );
  });

  it('prima della data il token di lettura scrive ancora, dopo no', () => {
    const spegnimento = new Date('2026-12-01T00:00:00.000Z');
    expect(legacyWriteStillAllowed(new Date('2026-11-30T23:59:59.000Z'), spegnimento)).toBe(true);
    expect(legacyWriteStillAllowed(spegnimento, spegnimento)).toBe(false);
  });
});

describe('la metrica di adozione', () => {
  it('la prima volta si scrive sempre', () => {
    expect(adoptionNeedsWrite(null, ORA)).toBe(true);
  });

  it('poi non piu di una volta ogni dieci minuti', () => {
    const unMinutoFa = new Date(ORA.getTime() - 60_000);
    expect(adoptionNeedsWrite(unMinutoFa, ORA)).toBe(false);

    const unOraFa = new Date(ORA.getTime() - 60 * 60_000);
    expect(adoptionNeedsWrite(unOraFa, ORA)).toBe(true);
  });
});
