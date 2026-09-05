import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { creaFakeRevocationStore } from './revocation-fake-store';

// Il registro finto, con l'indice unico e la presa condizionata su stato e
// lease: sono quelle regole a rendere due revoche identiche un lavoro solo, e
// dei mock che dicono sempre di si' non le proverebbero.
const store = creaFakeRevocationStore();
const righe = store.righe;
const consentRevocation = {
  create: vi.fn(store.create),
  findUnique: vi.fn(store.findUnique),
  findMany: vi.fn(store.findMany),
  updateMany: vi.fn(store.updateMany),
  deleteMany: vi.fn(store.deleteMany),
};

// Il getter e' necessario, non una civetteria: `vi.mock` viene issato in cima
// al file, quindi la fabbrica gira prima che `consentRevocation` esista.
vi.mock('~/db.server', () => ({
  prisma: {
    get consentRevocation() {
      return consentRevocation;
    },
    shop: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: () => ({}) }));
vi.mock('~/lib/tracking/users.server', () => ({ forgetVisitor: vi.fn() }));

import {
  MAX_REVOCATION_ATTEMPTS,
  drainRevocations,
  listDeadRevocations,
  processRevocation,
  pruneRevocations,
  recordRevocation,
  replayDeadRevocations,
  type RevocationRunner,
} from './revocation-register.server';
import {
  REVOCATION_CIPHERTEXT_TTL_MS,
  REVOCATION_COMPLETED_TTL_MS,
  type ForgetResult,
} from './revocation-model';
import { openSubject } from './revocation-subject.server';

const ORA = new Date('2026-09-05T12:00:00.000Z');
const VISITATORE = 'corew_1700000000000_abcdefghijklmnopqrstuvwxyz012345';

const richiesta = (over: Record<string, unknown> = {}) => ({
  shopId: 'negozio-1',
  scope: 'tracking_identity' as const,
  externalId: VISITATORE,
  ...over,
});

/** Un processore che riesce su tutti e tre i passi. */
const riesce: RevocationRunner = async () => ({
  outcome: 'forgotten',
  steps: [
    { step: 'customer_unlink', outcome: 'done' },
    { step: 'merge_pointers', outcome: 'done' },
    { step: 'user_delete', outcome: 'done' },
  ],
});

/** Un processore che fallisce su un passo solo. */
const fallisce = (
  step: 'customer_unlink' | 'merge_pointers' | 'user_delete',
  detail = 'connessione rifiutata',
): RevocationRunner => {
  const esito: ForgetResult = {
    outcome: 'failed',
    steps: [
      { step: 'customer_unlink', outcome: step === 'customer_unlink' ? 'failed' : 'done', ...(step === 'customer_unlink' ? { detail } : {}) },
      { step: 'merge_pointers', outcome: step === 'merge_pointers' ? 'failed' : 'done', ...(step === 'merge_pointers' ? { detail } : {}) },
      { step: 'user_delete', outcome: step === 'user_delete' ? 'failed' : 'done', ...(step === 'user_delete' ? { detail } : {}) },
    ],
  };
  return async () => esito;
};

beforeEach(() => {
  store.reset();
  // Le righe nascono adesso, non all'epoca zero: la ritenzione breve del
  // soggetto si misura da `updatedAt`, e una riga nata nel 1970 sarebbe gia'
  // scaduta prima di esistere.
  store.orologio = ORA;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('la presa in carico', () => {
  it('scrive la riga, e la riga E la presa in carico', async () => {
    const esito = await recordRevocation(richiesta());

    expect(esito.duplicate).toBe(false);
    expect(righe).toHaveLength(1);
    expect(righe[0].status).toBe('queued');
  });

  // Il punto di tutto il lavoro: il cookie sparisce dal browser, quindi il
  // riferimento da cui riprovare deve stare qui — e starci cifrato.
  it('conserva il soggetto cifrato, mai in chiaro', async () => {
    await recordRevocation(richiesta());

    expect(righe[0].subjectCipher).not.toBeNull();
    expect(righe[0].subjectCipher).not.toContain(VISITATORE);
    expect(righe[0].idempotencyKey).not.toContain(VISITATORE);
    // E dev'essere davvero sufficiente al ritentativo, non solo illeggibile.
    expect(openSubject(righe[0].subjectCipher)).toBe(VISITATORE);
  });

  it('cifra anche il cliente, quando la revoca ne nomina uno', async () => {
    await recordRevocation(richiesta({ shopifyCustomerId: 4021 }));

    expect(righe[0].customerCipher).not.toBeNull();
    expect(righe[0].customerCipher).not.toContain('4021');
    expect(openSubject(righe[0].customerCipher)).toBe('4021');
  });

  // Due revoche identiche: un lavoro attivo solo. E' l'indice unico
  // sull'impronta a garantirlo, non un controllo prima della scrittura.
  it('due revoche identiche producono un solo lavoro attivo', async () => {
    const prima = await recordRevocation(richiesta());
    const seconda = await recordRevocation(richiesta());

    expect(seconda.duplicate).toBe(true);
    expect(seconda.id).toBe(prima.id);
    expect(righe).toHaveLength(1);
    expect(righe.filter((r) => r.status === 'queued')).toHaveLength(1);
  });

  it('la stessa persona in due negozi sono due lavori', async () => {
    await recordRevocation(richiesta());
    await recordRevocation(richiesta({ shopId: 'negozio-2' }));

    expect(righe).toHaveLength(2);
  });

  // Una revoca gia' conclusa non si riapre: quello che c'era da cancellare e'
  // stato cancellato, e il soggetto e' stato tolto di mezzo apposta.
  it('una revoca gia conclusa non torna in lavorazione', async () => {
    const prima = await recordRevocation(richiesta());
    await processRevocation(prima.id, riesce, ORA);

    const seconda = await recordRevocation(richiesta());

    expect(seconda.alreadyDone).toBe(true);
    expect(righe[0].status).toBe('completed');
  });

  it('uno scopo che nessuno sa lavorare non diventa mai una riga', async () => {
    await expect(
      recordRevocation(richiesta({ scope: 'inventato' }) as never),
    ).rejects.toThrow(/scopo di revoca non gestito/);
    expect(righe).toHaveLength(0);
  });

  // Chi chiama traduce questo lancio in un segnale di ritentativo: e' l'unico
  // caso in cui il ritentativo cambia qualcosa.
  it('se la scrittura non riesce, solleva', async () => {
    consentRevocation.create.mockRejectedValueOnce(new Error('database owner giu'));

    await expect(recordRevocation(richiesta())).rejects.toThrow('database owner giu');
  });
});

describe('il tentativo', () => {
  it('riuscito conclude e porta via il testo cifrato', async () => {
    const { id } = await recordRevocation(richiesta());

    expect(await processRevocation(id, riesce, ORA)).toBe('done');

    expect(righe[0].status).toBe('completed');
    // La ritenzione piu' breve possibile: tenere l'identificativo appena
    // cancellato sarebbe conservare il dato che la revoca doveva togliere.
    expect(righe[0].subjectCipher).toBeNull();
    expect(righe[0].customerCipher).toBeNull();
    expect(righe[0].subjectPurgedAt).toEqual(ORA);
    // Resta la prova, che non e' un identificativo.
    expect(righe[0].idempotencyKey).not.toBeNull();
    // E il lease si rilascia: chi ha finito non tiene in mano niente.
    expect(righe[0].leaseOwner).toBeNull();
  });

  it.each([
    ['customer_unlink', 'errore su unlink dei clienti'],
    ['merge_pointers', 'errore sul reset di merged_into'],
    ['user_delete', 'errore sul delete di users'],
  ] as const)('%s fallito: resta ritentabile con il dettaglio redatto', async (step, _nome) => {
    const { id } = await recordRevocation(richiesta());

    expect(await processRevocation(id, fallisce(step), ORA)).toBe('retried');

    const riga = righe[0];
    expect(riga.status).toBe('queued');
    expect(riga.attempts).toBe(1);
    expect(riga.nextAttemptAt.getTime()).toBeGreaterThan(ORA.getTime());
    expect(riga.lastError).toContain(step);
    // Il soggetto RESTA: e' l'unica cosa da cui il ritentativo puo' ripartire,
    // e il cookie non ce l'ha piu'.
    expect(openSubject(riga.subjectCipher)).toBe(VISITATORE);
    expect(riga.lastError).not.toContain(VISITATORE);
  });

  // Il ritentativo dopo il ripristino: e' la prova che il registro serve
  // davvero a qualcosa, e non solo a registrare un fallimento.
  it('il ritentativo dopo il ripristino completa tutti i passi e purga il cifrato', async () => {
    const { id } = await recordRevocation(richiesta());
    await processRevocation(id, fallisce('user_delete'), ORA);

    const dopo = new Date(ORA.getTime() + 60 * 60_000);
    expect(await processRevocation(id, riesce, dopo)).toBe('done');

    expect(righe[0].status).toBe('completed');
    expect(righe[0].subjectCipher).toBeNull();
    expect(righe[0].lastError).toBeNull();
  });

  // Una tabella che non c'e' e' lavoro che non c'era da fare, non un guasto.
  it('tabella users/customers assente: completata, non lettera morta', async () => {
    const { id } = await recordRevocation(richiesta());

    const assente: RevocationRunner = async () => ({
      outcome: 'forgotten',
      steps: [
        { step: 'customer_unlink', outcome: 'skipped', detail: 'tabella assente' },
        { step: 'merge_pointers', outcome: 'skipped', detail: 'tabella assente' },
        { step: 'user_delete', outcome: 'skipped', detail: 'tabella assente' },
      ],
    });

    expect(await processRevocation(id, assente, ORA)).toBe('done');
    expect(righe[0].status).toBe('completed');
  });

  it('un lancio del processore e sempre un riprova', async () => {
    const { id } = await recordRevocation(richiesta());
    const esplode: RevocationRunner = async () => {
      throw new Error('Supabase non risponde');
    };

    expect(await processRevocation(id, esplode, ORA)).toBe('retried');
    expect(righe[0].status).toBe('queued');
  });

  it('una revoca non ancora dovuta non si prende', async () => {
    const { id } = await recordRevocation(richiesta());
    righe[0].nextAttemptAt = new Date(ORA.getTime() + 60_000);

    expect(await processRevocation(id, riesce, ORA)).toBe('skipped');
    expect(righe[0].attempts).toBe(0);
  });

  // La presa e' condizionata: chi arriva secondo non trova niente da prendere.
  it('due lavorazioni simultanee diventano una sola', async () => {
    const { id } = await recordRevocation(richiesta());

    const lenta: RevocationRunner = async () => {
      // Mentre il primo lavora, il secondo prova a prendere la stessa riga.
      expect(await processRevocation(id, riesce, ORA)).toBe('skipped');
      return riesce({ shopId: 'negozio-1', scope: 'tracking_identity', externalId: VISITATORE });
    };

    expect(await processRevocation(id, lenta, ORA)).toBe('done');
    expect(righe[0].attempts).toBe(1);
  });

  // Il lease scaduto e' l'unica strada per riprendere un'invocazione morta a
  // meta': senza, la revoca resterebbe 'processing' per sempre.
  it('una lavorazione ferma oltre il lease si riprende', async () => {
    const { id } = await recordRevocation(richiesta());
    righe[0].status = 'processing';
    righe[0].leaseOwner = 'chi-e-morto';
    righe[0].leaseExpiresAt = new Date(ORA.getTime() - 1);

    expect(await processRevocation(id, riesce, ORA)).toBe('done');
  });

  it('senza soggetto leggibile non si ritenta: lettera morta subito', async () => {
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id } = await recordRevocation(richiesta());
    righe[0].subjectCipher = 'testo-rovinato';

    expect(await processRevocation(id, riesce, ORA)).toBe('dead_letter');
    expect(righe[0].lastError).toContain('non ripetibile');
    expect(allarme).toHaveBeenCalled();
  });
});

describe('la lettera morta', () => {
  it('arriva dopo N tentativi, con un allarme senza dati personali', async () => {
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id } = await recordRevocation(richiesta());

    for (let i = 0; i < MAX_REVOCATION_ATTEMPTS; i++) {
      righe[0].nextAttemptAt = new Date(0);
      await processRevocation(id, fallisce('user_delete'), ORA);
    }

    expect(righe[0].status).toBe('dead_letter');
    expect(allarme).toHaveBeenCalledTimes(1);

    const riga = allarme.mock.calls[0][0] as string;
    expect(riga).toContain('ALLARME');
    expect(riga).toContain('npm run consent:replay');
    // Nessun dato personale nell'allarme: ne' l'identificativo del browser, ne'
    // il testo cifrato che lo contiene.
    expect(riga).not.toContain(VISITATORE);
    expect(riga).not.toContain(righe[0].subjectCipher);
  });

  it('l elenco non fa uscire il soggetto', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id } = await recordRevocation(richiesta());
    for (let i = 0; i < MAX_REVOCATION_ATTEMPTS; i++) {
      righe[0].nextAttemptAt = new Date(0);
      await processRevocation(id, fallisce('user_delete'), ORA);
    }

    const ferme = await listDeadRevocations();

    expect(ferme).toHaveLength(1);
    expect(JSON.stringify(ferme)).not.toContain(VISITATORE);
    expect(Object.keys(ferme[0])).not.toContain('subjectCipher');
  });

  it('il replay riparte da zero tentativi', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id } = await recordRevocation(richiesta());
    for (let i = 0; i < MAX_REVOCATION_ATTEMPTS; i++) {
      righe[0].nextAttemptAt = new Date(0);
      await processRevocation(id, fallisce('user_delete'), ORA);
    }

    expect(await replayDeadRevocations(undefined, ORA)).toBe(1);
    expect(righe[0].status).toBe('queued');
    expect(righe[0].attempts).toBe(0);
  });

  // Senza soggetto non c'e' niente da rigiocare: rimetterla in lavorazione
  // servirebbe solo a farle consumare altri cinque tentativi identici.
  it('il replay salta le revoche a cui il soggetto e gia stato tolto', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id } = await recordRevocation(richiesta());
    for (let i = 0; i < MAX_REVOCATION_ATTEMPTS; i++) {
      righe[0].nextAttemptAt = new Date(0);
      await processRevocation(id, fallisce('user_delete'), ORA);
    }
    righe[0].subjectCipher = null;

    expect(await replayDeadRevocations(undefined, ORA)).toBe(0);
    expect(righe[0].status).toBe('dead_letter');
  });
});

describe('il drenaggio', () => {
  it('lavora quel che il primo tentativo sincrono non ha applicato', async () => {
    const { id } = await recordRevocation(richiesta());
    await processRevocation(id, fallisce('user_delete'), ORA);
    righe[0].nextAttemptAt = new Date(0);

    const esito = await drainRevocations(riesce, ORA);

    expect(esito).toEqual({ processed: 1, retried: 0, deadLettered: 0 });
    expect(righe[0].status).toBe('completed');
  });

  it('non tocca quel che non e ancora dovuto', async () => {
    await recordRevocation(richiesta());
    righe[0].nextAttemptAt = new Date(ORA.getTime() + 60_000);

    expect(await drainRevocations(riesce, ORA)).toEqual({
      processed: 0,
      retried: 0,
      deadLettered: 0,
    });
  });
});

describe('le potature', () => {
  it('tolgono le concluse da oltre una settimana, non le morte', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id } = await recordRevocation(richiesta());
    await processRevocation(id, riesce, ORA);

    const dopo = new Date(ORA.getTime() + REVOCATION_COMPLETED_TTL_MS + 1);
    const esito = await pruneRevocations(dopo);

    expect(esito.pruned).toBe(1);
    expect(righe).toHaveLength(0);
  });

  // La ritenzione breve: su una lettera morta il soggetto serve ancora al
  // replay, ma non per sempre.
  it('portano via il cifrato dalle morte a fine ritenzione, lasciando la prova', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id } = await recordRevocation(richiesta());
    for (let i = 0; i < MAX_REVOCATION_ATTEMPTS; i++) {
      righe[0].nextAttemptAt = new Date(0);
      await processRevocation(id, fallisce('user_delete'), ORA);
    }

    const dopo = new Date(ORA.getTime() + REVOCATION_CIPHERTEXT_TTL_MS + 1);
    const esito = await pruneRevocations(dopo);

    expect(esito.subjectsPurged).toBe(1);
    expect(righe[0].subjectCipher).toBeNull();
    // La riga resta: e' l'unica traccia di una revoca non applicata.
    expect(righe[0].status).toBe('dead_letter');
    expect(righe[0].idempotencyKey).toBeTruthy();
  });

  it('non toccano il cifrato di una morta ancora dentro la ritenzione', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id } = await recordRevocation(richiesta());
    for (let i = 0; i < MAX_REVOCATION_ATTEMPTS; i++) {
      righe[0].nextAttemptAt = new Date(0);
      await processRevocation(id, fallisce('user_delete'), ORA);
    }

    expect((await pruneRevocations(ORA)).subjectsPurged).toBe(0);
    expect(righe[0].subjectCipher).not.toBeNull();
  });
});
