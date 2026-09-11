import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Il magazzino finto delle credenziali.
 *
 * Con dei mock che dicono sempre di si' la rotazione non si proverebbe: quel
 * che va provato e' proprio che emettere una chiave DATI le altre invece di
 * revocarle, e che la revoca invece non lasci nessuna finestra. Sono due
 * comportamenti sulle righe, non sulle chiamate.
 */
interface Riga {
  id: string;
  shopId: string;
  keyId: string;
  secretCipher: string;
  valueHash: string;
  audience: string;
  version: number;
  scopes: string[];
  issuedAt: Date;
  supersededAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

const righe: Riga[] = [];
let contatore = 0;

function corrisponde(riga: Riga, where: Record<string, unknown>): boolean {
  for (const [campo, atteso] of Object.entries(where)) {
    const valore = (riga as unknown as Record<string, unknown>)[campo];
    if (atteso === null) {
      if (valore !== null) return false;
    } else if (valore !== atteso) {
      return false;
    }
  }
  return true;
}

const trackingIngestKey = {
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    // Le colonne facoltative nascono vuote, come sul database; l'id lo mette
    // lui e non chi scrive, quindi si aggiunge dopo.
    const riga: Riga = {
      supersededAt: null,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      ...(data as Partial<Riga>),
      id: `riga-${++contatore}`,
    } as Riga;
    righe.push(riga);
    return riga;
  }),
  findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    return righe.find((r) => corrisponde(r, where)) ?? null;
  }),
  findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    righe.filter((r) => corrisponde(r, where)),
  ),
  updateMany: vi.fn(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const colpite = righe.filter((r) => corrisponde(r, where));
      for (const riga of colpite) Object.assign(riga, data);
      return { count: colpite.length };
    },
  ),
  update: vi.fn(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const riga = righe.find((r) => corrisponde(r, where));
      if (!riga) throw new Error('non trovata');
      Object.assign(riga, data);
      return riga;
    },
  ),
};

vi.mock('~/db.server', () => ({
  prisma: {
    get trackingIngestKey() {
      return trackingIngestKey;
    },
    // La rotazione e' una transazione: emettere senza datare le vecchie
    // lascerebbe due credenziali piene in giro per sempre.
    $transaction: (operazioni: Promise<unknown>[]) => Promise.all(operazioni),
  },
}));

import { INGEST_ROTATION_OVERLAP_MS, ingestKeyRefusal } from './ingest-model';
import {
  generateIngestCredential,
  hashIngestValue,
  issueIngestKey,
  openIngestSecret,
  parseIngestCredential,
  revokeAllIngestKeys,
  revokeIngestKey,
  sealIngestSecret,
  signIngestPayload,
  signaturesMatch,
} from './ingest-key.server';

const ORA = new Date('2026-09-11T12:00:00.000Z');

beforeEach(() => {
  righe.length = 0;
  contatore = 0;
  vi.clearAllMocks();
});

describe('il valore della credenziale', () => {
  it('ha due meta con due mestieri diversi', () => {
    const credenziale = generateIngestCredential();

    expect(credenziale.value).toBe(`kin_${credenziale.keyId}.${credenziale.secret}`);
    // L'identificativo non e' segreto e viaggia in chiaro; il segreto non
    // viaggia mai.
    expect(credenziale.keyId.length).toBeGreaterThan(10);
    expect(credenziale.secret.length).toBeGreaterThan(30);
  });

  it('non si ripete', () => {
    expect(generateIngestCredential().value).not.toBe(generateIngestCredential().value);
  });

  it('non si confonde con il token di lettura', () => {
    // Nella card di Impostazioni le due chiavi stanno a due righe di distanza:
    // chi le scambia deve ottenere un rifiuto, non una scrittura che sembra
    // funzionare.
    expect(parseIngestCredential('spx_qualcosa')).toBeNull();
    expect(generateIngestCredential().value.startsWith('spx_')).toBe(false);
  });

  it('si rilegge nelle sue due meta, e rifiuta le forme storte', () => {
    const credenziale = generateIngestCredential();
    expect(parseIngestCredential(credenziale.value)).toMatchObject({
      keyId: credenziale.keyId,
      secret: credenziale.secret,
    });

    expect(parseIngestCredential('kin_soloidentificativo')).toBeNull();
    expect(parseIngestCredential('kin_a.b.c')).toBeNull();
    expect(parseIngestCredential(null)).toBeNull();
  });

  it('l impronta e stabile e distingue', () => {
    expect(hashIngestValue('kin_a.b')).toBe(hashIngestValue('kin_a.b'));
    expect(hashIngestValue('kin_a.b')).not.toBe(hashIngestValue('kin_a.c'));
  });
});

describe('il segreto sigillato', () => {
  it('si richiude e si riapre', () => {
    const chiuso = sealIngestSecret('segreto-1');
    expect(chiuso).not.toContain('segreto-1');
    expect(openIngestSecret(chiuso)).toBe('segreto-1');
  });

  it('due sigilli dello stesso segreto sono diversi', () => {
    expect(sealIngestSecret('s')).not.toBe(sealIngestSecret('s'));
  });

  it('un testo cifrato illeggibile non solleva: da null', () => {
    // Non e' un guasto da 500: e' una credenziale che non si puo' verificare,
    // cioe' una richiesta non autorizzata.
    expect(openIngestSecret('rotto')).toBeNull();
    expect(openIngestSecret('a:b:c')).toBeNull();
    expect(openIngestSecret(null)).toBeNull();
  });
});

describe('la firma', () => {
  it('porta il prefisso di versione', () => {
    expect(signIngestPayload('s', 'payload').startsWith('v1=')).toBe(true);
  });

  it('cambia se cambia il segreto o il contenuto', () => {
    expect(signIngestPayload('s1', 'p')).not.toBe(signIngestPayload('s2', 'p'));
    expect(signIngestPayload('s', 'p1')).not.toBe(signIngestPayload('s', 'p2'));
  });

  it('il confronto non solleva su lunghezze diverse', () => {
    // `timingSafeEqual` pretende due buffer uguali: una firma di lunghezza
    // diversa e' semplicemente una firma diversa, non un errore da propagare.
    expect(signaturesMatch('corta', 'molto piu lunga')).toBe(false);
    expect(signaturesMatch('uguale', 'uguale')).toBe(true);
  });
});

describe('emettere e ruotare', () => {
  it('la prima emissione lascia una sola credenziale viva', async () => {
    const credenziale = await issueIngestKey('s1', { now: ORA });

    expect(righe).toHaveLength(1);
    expect(righe[0].keyId).toBe(credenziale.keyId);
    expect(righe[0].expiresAt).toBeNull();
    expect(righe[0].revokedAt).toBeNull();
    // Il segreto sta sigillato, non in chiaro.
    expect(righe[0].secretCipher).not.toContain(credenziale.secret);
    expect(openIngestSecret(righe[0].secretCipher)).toBe(credenziale.secret);
  });

  it('la rotazione non revoca la vecchia: le da una finestra', async () => {
    // Fra il "ruota" e la pubblicazione del valore nuovo dentro un container
    // passano ore. Senza finestra, ruotare sarebbe un'interruzione del
    // tracciamento — e una misura che si paga cosi' non la usa nessuno.
    const vecchia = await issueIngestKey('s1', { now: ORA });
    const nuova = await issueIngestKey('s1', { now: ORA });

    const rigaVecchia = righe.find((r) => r.keyId === vecchia.keyId)!;
    const rigaNuova = righe.find((r) => r.keyId === nuova.keyId)!;

    expect(rigaVecchia.revokedAt).toBeNull();
    expect(rigaVecchia.supersededAt).toEqual(ORA);
    expect(rigaVecchia.expiresAt).toEqual(new Date(ORA.getTime() + INGEST_ROTATION_OVERLAP_MS));
    expect(rigaNuova.expiresAt).toBeNull();

    // Dentro la finestra valgono tutte e due.
    const dentro = new Date(ORA.getTime() + INGEST_ROTATION_OVERLAP_MS - 1_000);
    expect(ingestKeyRefusal(rigaVecchia, 'ingest:links', dentro)).toBeNull();
    expect(ingestKeyRefusal(rigaNuova, 'ingest:links', dentro)).toBeNull();

    // Finita la finestra, la vecchia non vale piu' e la nuova si'.
    const dopo = new Date(ORA.getTime() + INGEST_ROTATION_OVERLAP_MS + 1_000);
    expect(ingestKeyRefusal(rigaVecchia, 'ingest:links', dopo)).toBe('expired');
    expect(ingestKeyRefusal(rigaNuova, 'ingest:links', dopo)).toBeNull();
  });

  it('una rotazione non riapre la finestra di una credenziale gia revocata', async () => {
    const prima = await issueIngestKey('s1', { now: ORA });
    await revokeIngestKey('s1', prima.keyId, ORA);

    await issueIngestKey('s1', { now: ORA });

    const rigaRevocata = righe.find((r) => r.keyId === prima.keyId)!;
    expect(rigaRevocata.revokedAt).toEqual(ORA);
  });

  it('gli ambiti si possono restringere sulla singola credenziale', async () => {
    await issueIngestKey('s1', { scopes: ['ingest:identity'], now: ORA });
    expect(righe[0].scopes).toEqual(['ingest:identity']);
  });
});

describe('revocare', () => {
  it('chiude subito, senza nessuna finestra', async () => {
    // E' il contrario della rotazione per costruzione: si revoca quando si sa
    // che una chiave e' in mano a qualcun altro.
    const credenziale = await issueIngestKey('s1', { now: ORA });

    expect(await revokeIngestKey('s1', credenziale.keyId, ORA)).toBe(true);

    const riga = righe[0];
    expect(riga.revokedAt).toEqual(ORA);
    expect(riga.expiresAt).toEqual(ORA);
    expect(ingestKeyRefusal(riga, 'ingest:links', ORA)).toBe('revoked');
    // Nemmeno un millisecondo dopo.
    expect(ingestKeyRefusal(riga, 'ingest:links', new Date(ORA.getTime() + 1))).toBe('revoked');
  });

  it('non si revoca la credenziale di un altro negozio', async () => {
    // Senza il negozio nella condizione, chi indovinasse un identificativo
    // pubblico altrui potrebbe spegnergli il tracciamento.
    const altrui = await issueIngestKey('s2', { now: ORA });

    expect(await revokeIngestKey('s1', altrui.keyId, ORA)).toBe(false);
    expect(righe[0].revokedAt).toBeNull();
  });

  it('si possono chiudere tutte insieme: il gesto del "l ho persa"', async () => {
    await issueIngestKey('s1', { now: ORA });
    await issueIngestKey('s1', { now: ORA });

    expect(await revokeAllIngestKeys('s1', ORA)).toBe(2);
    expect(righe.every((r) => r.revokedAt !== null)).toBe(true);
  });
});
