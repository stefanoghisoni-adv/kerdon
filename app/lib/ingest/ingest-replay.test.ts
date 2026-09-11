import { describe, it, expect, beforeEach } from 'vitest';
import { INGEST_SIGNATURE_WINDOW_MS } from './ingest-model';
import { claimIdempotencyKey, clearIngestReplayMemory } from './ingest-replay.server';

const ORA = 1_000_000;

beforeEach(() => {
  clearIngestReplayMemory();
});

describe('la stessa chiave di idempotenza, dentro la finestra', () => {
  it('la prima volta passa', () => {
    expect(claimIdempotencyKey('k1', 'msg-1', ORA)).toBe(true);
  });

  it('la seconda no', () => {
    claimIdempotencyKey('k1', 'msg-1', ORA);
    expect(claimIdempotencyKey('k1', 'msg-1', ORA + 1_000)).toBe(false);
  });

  it('passata la finestra la si dimentica: a rifiutare basta la finestra stessa', () => {
    claimIdempotencyKey('k1', 'msg-1', ORA);
    expect(claimIdempotencyKey('k1', 'msg-1', ORA + INGEST_SIGNATURE_WINDOW_MS + 1)).toBe(true);
  });
});

describe('la memoria e per credenziale', () => {
  it('due negozi che scelgono per caso la stessa etichetta non si bloccano', () => {
    // Senza la credenziale nella chiave, chiunque potrebbe far rifiutare le
    // scritture altrui indovinando una stringa.
    claimIdempotencyKey('chiave-a', 'msg-1', ORA);
    expect(claimIdempotencyKey('chiave-b', 'msg-1', ORA)).toBe(true);
  });

  it('etichette diverse della stessa credenziale passano entrambe', () => {
    expect(claimIdempotencyKey('k1', 'msg-1', ORA)).toBe(true);
    expect(claimIdempotencyKey('k1', 'msg-2', ORA)).toBe(true);
  });
});
