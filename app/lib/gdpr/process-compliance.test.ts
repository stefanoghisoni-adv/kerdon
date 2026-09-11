import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/db.server', () => ({
  prisma: {
    // La presa e' un `UPDATE ... RETURNING`: aggiorna e riporta indietro il
    // numero del tentativo nella stessa istruzione, invece di incrementare e
    // poi rileggere. E' la correzione da cui parte tutto il resto.
    $queryRaw: vi.fn(),
    complianceRequest: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    shop: { findUnique: vi.fn() },
    syncJob: { create: vi.fn() },
  },
}));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn(() => ({})) }));
vi.mock('~/lib/queue/shop-lock.server', () => ({ runWithShopLease: vi.fn() }));
vi.mock('./customer-record.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./customer-record.server')>();
  return {
    ...actual,
    eraseCustomerFromMerchant: vi.fn(),
    eraseCustomerFromAppDatabase: vi.fn(),
  };
});
vi.mock('./subject-snapshot.server', () => ({
  materializeSubject: vi.fn(),
  collectSubjectData: vi.fn(),
}));
vi.mock('./shop-record.server', () => ({ eraseShopRecord: vi.fn() }));
vi.mock('./audit.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audit.server')>();
  return { ...actual, saveGdprOutcome: vi.fn(), trySaveGdprOutcome: vi.fn() };
});

import { Prisma } from '@prisma/client';
import {
  MAX_ATTEMPTS,
  drainComplianceRequests,
  processComplianceRequest,
  pruneExpiredExports,
} from './process-compliance.server';
import { prisma } from '~/db.server';
import { runWithShopLease } from '~/lib/queue/shop-lock.server';
import {
  eraseCustomerFromAppDatabase,
  eraseCustomerFromMerchant,
} from './customer-record.server';
import { collectSubjectData, materializeSubject } from './subject-snapshot.server';
import { eraseShopRecord } from './shop-record.server';
import { saveGdprOutcome, trySaveGdprOutcome } from './audit.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Il lavoro, dopo la ricevuta.
 *
 * Queste prove stavano nel file delle rotte finche' erano le rotte a fare il
 * lavoro. Non sono cambiate perche' il lavoro sia cambiato — cancella le stesse
 * tabelle, anonimizza gli stessi ordini — ma perche' e' cambiato dove avviene:
 * fuori dalla richiesta HTTP, dove puo' metterci il tempo che serve senza che
 * Shopify scambi la lentezza per un rifiuto.
 *
 * Le due cose che qui vanno difese piu' di tutte sono lo stato e la ripetizione.
 * Una consegna doppia non deve produrre due esportazioni ne' due cancellazioni
 * in corsa; un fallimento non deve sparire in silenzio ne' restare a ritentare
 * per sempre senza che nessuno se ne accorga.
 */

const SHOP = 'test-shop.myshopify.com';
const OK = { count: 1 };

/**
 * La riga come la restituisce la presa: colonne come si chiamano nel database,
 * perche' e' un `RETURNING` e non una lettura di Prisma.
 *
 * `attempts` e' gia' il valore INCREMENTATO — e' il tentativo in corso, e va da
 * 1 a MAX_ATTEMPTS. Prima veniva riletto e poi sommato di uno, e per questo la
 * lettera morta arrivava con un tentativo ancora da fare.
 */
function claimed(over: Record<string, unknown> = {}) {
  return [
    {
      id: 'req-1',
      webhook_id: 'consegna-1',
      topic: 'customers/redact',
      shop_domain: SHOP,
      shop_id: null,
      customer_ref: 'impronta',
      payload: { shop_domain: SHOP, customer: { id: 4021 } },
      attempts: 1,
      ...over,
    },
  ];
}

/** Il testo della `UPDATE` della presa, per guardarci dentro. */
function claimSql(): string {
  return String((prisma.$queryRaw as any).mock.calls[0][0].sql);
}

const shopWithConfig = {
  id: 'shop-1',
  supabaseConfig: { tableNameCustomers: 'customers' },
};

/**
 * L'argomento dell'ultima scrittura finale sulla riga della richiesta.
 *
 * `updateMany` e non `update`: ogni scrittura finale porta il lease nella
 * `WHERE`, quindi puo' toccare zero righe — ed e' proprio quello che deve fare
 * quando la richiesta e' passata in mano a qualcun altro.
 */
function lastUpdate() {
  const calls = (prisma.complianceRequest.updateMany as any).mock.calls;
  return calls.at(-1)?.[0].data;
}

/** La condizione dell'ultima scrittura finale. */
function lastWhere() {
  const calls = (prisma.complianceRequest.updateMany as any).mock.calls;
  return calls.at(-1)?.[0].where;
}

let errorSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.$queryRaw as any).mockResolvedValue(claimed());
  (prisma.complianceRequest.updateMany as any).mockResolvedValue(OK);
  (prisma.complianceRequest.update as any).mockResolvedValue({});
  (prisma.complianceRequest.deleteMany as any).mockResolvedValue({ count: 1 });
  (prisma.shop.findUnique as any).mockResolvedValue(shopWithConfig);
  (runWithShopLease as any).mockImplementation(
    async (_id: string, run: (lease: unknown) => Promise<void>) => {
      await run({ shopId: _id, assertHeld: async () => undefined });
      return 'eseguito';
    },
  );
  (eraseCustomerFromMerchant as any).mockResolvedValue([
    { table: 'customers', outcome: 'deleted', rows: 1 },
  ]);
  (eraseCustomerFromAppDatabase as any).mockResolvedValue([
    { table: 'customer_data_access_log', outcome: 'deleted', rows: 0 },
  ]);
  (materializeSubject as any).mockResolvedValue({
    snapshot: { takenAt: new Date(), customers: ['cli-1'], orders: [], orderLines: [], users: [] },
    steps: [],
  });
  (collectSubjectData as any).mockResolvedValue({
    data: { customer: { id: 4021 }, orders: [], order_lines: [], browsers: [] },
    steps: [{ table: 'customers', outcome: 'read', rows: 1 }],
  });
  (eraseShopRecord as any).mockResolvedValue({
    outcome: 'erased',
    shopId: null,
    proofId: 'prova-1',
    steps: [{ table: 'shops', outcome: 'deleted', rows: 1 }],
  });
  // Dichiarata qui e non lasciata al default: `clearAllMocks` azzera le
  // chiamate ma NON l'implementazione, quindi un test che la fa fallire se la
  // porterebbe dietro in tutti quelli dopo.
  (saveGdprOutcome as any).mockResolvedValue(undefined);
  (trySaveGdprOutcome as any).mockResolvedValue(undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('la presa, che rende innocua la consegna doppia', () => {
  it('chi arriva secondo non lavora niente', async () => {
    // Non un controllo prima — due invocazioni simultanee lo passerebbero
    // entrambe — ma un aggiornamento condizionato: chi non riceve nessuna riga
    // se ne va.
    (prisma.$queryRaw as any).mockResolvedValue([]);

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('skipped');
    expect(eraseCustomerFromMerchant).not.toHaveBeenCalled();
  });

  it('si prende solo cio che e dovuto: in coda o gia fallito, e con l attesa scaduta', async () => {
    await processComplianceRequest('req-1');

    expect(claimSql()).toContain("IN ('queued', 'failed')");
    // L'attesa sulla riga, e non un intervallo calcolato qui: e' il backoff
    // deciso al momento del fallimento.
    expect(claimSql()).toContain('next_attempt_at');
  });

  /**
   * IL DIFETTO DA CUI PARTE TUTTO. La presa incrementava, poi una lettura
   * separata rileggeva, e chi decideva la lettera morta sommava ancora uno: lo
   * stesso tentativo logico valeva due. Adesso il numero esiste in un posto
   * solo — il valore che `RETURNING` riporta indietro.
   */
  it('conta il tentativo e riporta indietro il valore, in una istruzione sola', async () => {
    await processComplianceRequest('req-1');

    expect(claimSql()).toContain('"attempts" = r."attempts" + 1');
    expect(claimSql()).toContain('RETURNING');
    expect(claimSql()).toContain('r."attempts"');
    // Nessuna rilettura separata: era li' che il valore veniva contato due
    // volte.
    expect(prisma.complianceRequest.findUnique).not.toHaveBeenCalled();
  });

  it('scrive sulla riga chi la sta lavorando, e fino a quando', async () => {
    await processComplianceRequest('req-1');

    expect(claimSql()).toContain('lease_owner');
    expect(claimSql()).toContain('lease_expires_at');
  });

  /**
   * Un'invocazione morta a meta' lasciava la richiesta in 'processing' per
   * sempre, a meno che a passare non fosse il cron — che la riportava a mano in
   * 'failed'. Chi arrivava dalla coda trovava la presa chiusa e se ne andava.
   * Adesso la riprende la presa stessa, e vale per tutte e due le strade.
   */
  it('una lavorazione abbandonata torna prendibile da sola', async () => {
    await processComplianceRequest('req-1');

    expect(claimSql()).toContain("r.\"status\" = 'processing'");
    expect(claimSql()).toContain('"lease_expires_at" IS NULL');
  });

  it('ogni scrittura finale porta con se chi ha in mano la richiesta', async () => {
    await processComplianceRequest('req-1');

    expect(lastWhere()).toMatchObject({ id: 'req-1', status: 'processing' });
    expect(typeof lastWhere().leaseOwner).toBe('string');
  });

  it('lease perso durante il lavoro: non si dichiara niente', async () => {
    // La scrittura finale tocca zero righe perche' la richiesta e' passata a
    // qualcun altro. Due invocazioni che dichiarano conclusa la stessa pratica
    // sono peggio di una che tace.
    (prisma.complianceRequest.updateMany as any).mockResolvedValue({ count: 0 });

    expect(await processComplianceRequest('req-1')).toBe('skipped');
  });
});

describe('customers/redact', () => {
  it('cancella nel database del merchant e nel nostro', async () => {
    const result = await processComplianceRequest('req-1');

    expect(result).toBe('done');
    expect(eraseCustomerFromMerchant).toHaveBeenCalled();
    expect(eraseCustomerFromAppDatabase).toHaveBeenCalled();
  });

  it('avviene sotto il lucchetto della sincronizzazione', async () => {
    // Una corsa avviata un istante prima riscriverebbe il cliente subito dopo
    // averlo cancellato.
    await processComplianceRequest('req-1');

    expect(runWithShopLease).toHaveBeenCalledWith('shop-1', expect.any(Function));
  });

  it('lucchetto occupato: non e un fallimento, si riprova', async () => {
    (runWithShopLease as any).mockResolvedValue('occupato');

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    expect(lastUpdate()?.status ?? 'failed').not.toBe('completed');
  });

  it('negozio senza progetto collegato: il nostro database si pulisce lo stesso', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue({ id: 'shop-1', supabaseConfig: null });

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('done');
    expect(eraseCustomerFromMerchant).not.toHaveBeenCalled();
    expect(eraseCustomerFromAppDatabase).toHaveBeenCalled();
  });

  it('negozio mai registrato: niente da cancellare, e non e un errore', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue(null);

    expect(await processComplianceRequest('req-1')).toBe('done');
  });

  it('cancellazione parziale: la richiesta NON risulta riuscita', async () => {
    (eraseCustomerFromMerchant as any).mockResolvedValue([
      { table: 'customers', outcome: 'failed', rows: 0, detail: 'statement timeout' },
    ]);

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    // La traccia di un fallimento passa da `trySave`: li' si sta gia'
    // registrando un guasto, e una traccia che non si scrive non deve coprirlo
    // con un secondo guasto. Il percorso della riuscita, invece, solleva.
    const traccia = (trySaveGdprOutcome as any).mock.calls.at(-1)[1];
    expect(traccia.steps.some((s: any) => s.outcome === 'failed')).toBe(true);
  });
});

describe('customers/data_request', () => {
  const asDataRequest = () =>
    (prisma.$queryRaw as any).mockResolvedValue(claimed({ topic: 'customers/data_request' }));

  it("l esportazione si scrive sulla riga, con una scadenza", async () => {
    asDataRequest();
    await processComplianceRequest('req-1');

    expect(lastUpdate().export).toBeTruthy();
    expect(lastUpdate().exportExpiresAt).toBeInstanceOf(Date);
  });

  it('chiusa la richiesta, il payload si azzera davvero', async () => {
    // `undefined` avrebbe voluto dire "non toccare", e l id della persona
    // sarebbe rimasto scritto in una coda di richieste gia eseguite.
    asDataRequest();
    await processComplianceRequest('req-1');

    expect(lastUpdate().payload).toBe(Prisma.DbNull);
  });

  /**
   * IL CONFINE DEL LUCCHETTO. Sotto lucchetto si stabilisce QUALI righe sono
   * della persona, e basta. Le righe intere si vanno a prendere dopo, a
   * lucchetto gia' mollato: tenerlo per tutto lo scaricamento fermerebbe il
   * negozio per minuti — niente sincronizzazione, niente webhook lavorati —
   * ogni volta che qualcuno chiede i propri dati.
   */
  it('la fotografia si prende sotto il lucchetto, lo scaricamento no', async () => {
    asDataRequest();
    let dentro = false;
    const quando: Record<string, boolean> = {};

    (runWithShopLease as any).mockImplementation(
      async (_id: string, run: (lease: unknown) => Promise<void>) => {
        dentro = true;
        await run({ shopId: _id, assertHeld: async () => undefined });
        dentro = false;
        return 'eseguito';
      },
    );
    (materializeSubject as any).mockImplementation(async () => {
      quando.fotografia = dentro;
      return {
        snapshot: { takenAt: new Date(), customers: [], orders: [], orderLines: [], users: [] },
        steps: [],
      };
    });
    (collectSubjectData as any).mockImplementation(async () => {
      quando.scaricamento = dentro;
      return { data: { customer: null, orders: [], order_lines: [], browsers: [] }, steps: [] };
    });

    await processComplianceRequest('req-1');

    expect(runWithShopLease).toHaveBeenCalledWith('shop-1', expect.any(Function));
    expect(quando.fotografia).toBe(true);
    expect(quando.scaricamento).toBe(false);
  });

  it('lucchetto occupato: si riprova, e nessuna fotografia a meta', async () => {
    // Occupato vuol dire che una sincronizzazione sta scrivendo proprio quelle
    // tabelle: impaginarle adesso metterebbe insieme due istanti.
    asDataRequest();
    (runWithShopLease as any).mockResolvedValue('occupato');

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    expect(collectSubjectData).not.toHaveBeenCalled();
    expect(lastUpdate().export).toBeUndefined();
  });

  it('lucchetto non disponibile: si riprova, non si esporta al buio', async () => {
    asDataRequest();
    (runWithShopLease as any).mockResolvedValue('non-disponibile');

    expect(await processComplianceRequest('req-1')).toBe('failed');
    expect(collectSubjectData).not.toHaveBeenCalled();
  });

  it('fotografia non riuscita: nessuna esportazione, e si ritenta', async () => {
    asDataRequest();
    (materializeSubject as any).mockResolvedValue({
      snapshot: null,
      steps: [{ table: 'orders', outcome: 'failed', rows: 0, detail: 'statement timeout' }],
    });

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    expect(collectSubjectData).not.toHaveBeenCalled();
    expect(lastUpdate()?.export).toBeUndefined();
  });

  it('persona mai sincronizzata: esportazione vuota, non un errore', async () => {
    asDataRequest();
    (prisma.shop.findUnique as any).mockResolvedValue({ id: 'shop-1', supabaseConfig: null });

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('done');
    expect(lastUpdate().export).toEqual({
      customer: null,
      orders: [],
      order_lines: [],
      browsers: [],
    });
  });

  it('raccolta incompleta: nessuna esportazione, e si ritenta', async () => {
    // Un esportazione incompleta messa a disposizione come completa e peggio di
    // una ritentata: chi la legge crederebbe che il resto non esiste.
    asDataRequest();
    (collectSubjectData as any).mockResolvedValue({
      data: null,
      steps: [{ table: 'orders', outcome: 'failed', rows: 0, detail: 'statement timeout' }],
    });

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    expect(lastUpdate()?.export).toBeUndefined();
  });

  it('righe cambiate fra la fotografia e la ripresa: si ritenta', async () => {
    // Il confronto e' su conteggi E chiavi: una riga sparita e una comparsa
    // lasciano il conteggio dov'era, e l esportazione uscirebbe con dentro una
    // riga che nella fotografia non c era.
    asDataRequest();
    (collectSubjectData as any).mockResolvedValue({
      data: null,
      steps: [
        {
          table: 'orders',
          outcome: 'failed',
          rows: 2,
          detail: 'Il database e cambiato durante l esportazione: si rifa da capo',
        },
      ],
    });

    expect(await processComplianceRequest('req-1')).toBe('failed');
    expect(lastUpdate()?.export).toBeUndefined();
  });
});

describe('shop/redact', () => {
  const asShopRedact = () =>
    (prisma.$queryRaw as any).mockResolvedValue(
      claimed({ topic: 'shop/redact', customer_ref: null }),
    );

  it('riuscita: della richiesta stessa non resta traccia nel database', async () => {
    // La riga porta il dominio del negozio appena cancellato: tenerla vorrebbe
    // dire non averlo cancellato. Si puo' togliere solo perche' la prova
    // minimizzata e' gia' stata scritta dentro la transazione che ha cancellato
    // il negozio — senza quella, questa riga sarebbe l'ultima cosa rimasta a
    // dire che la richiesta e' arrivata.
    asShopRedact();
    const result = await processComplianceRequest('req-1');

    expect(result).toBe('done');
    expect(prisma.complianceRequest.deleteMany).toHaveBeenCalledWith({
      where: { shopDomain: SHOP },
    });
  });

  /**
   * Occupato e lucchetto giu' sono due modi di dire "non si e' fatto niente":
   * la riga resta, e resta anche il negozio. Prima questo caso non esisteva —
   * `shop/redact` non prendeva nessun lucchetto, mentre `customers/redact` lo
   * prendeva: la richiesta piu' distruttiva delle due era l'unica senza.
   */
  it.each([
    ['busy', 'occupato'],
    ['lock_unavailable', 'irraggiungibile'],
  ])('lucchetto %s: la richiesta resta ritentabile', async (outcome) => {
    asShopRedact();
    (eraseShopRecord as any).mockResolvedValue({
      outcome,
      shopId: 'shop-1',
      steps: [{ table: 'richiesta', outcome: 'failed', rows: 0, detail: 'si riprova' }],
    });

    expect(await processComplianceRequest('req-1')).toBe('failed');
    expect(prisma.complianceRequest.deleteMany).not.toHaveBeenCalled();
    expect(lastUpdate().status).toBe('failed');
  });

  /**
   * La seconda consegna non ha piu' un negozio in cui riconoscersi: la prova e'
   * l'unica cosa rimasta, e trovarla vale quanto aver fatto il lavoro.
   */
  it('seconda consegna: la prova gia scritta chiude la pratica', async () => {
    asShopRedact();
    (eraseShopRecord as any).mockResolvedValue({
      outcome: 'already_erased',
      shopId: null,
      proofId: 'prova-1',
      steps: [{ table: 'shop_erasure_proofs', outcome: 'skipped', rows: 0 }],
    });

    expect(await processComplianceRequest('req-1')).toBe('done');
    expect(prisma.complianceRequest.deleteMany).toHaveBeenCalledWith({
      where: { shopDomain: SHOP },
    });
  });

  it('porta l id della consegna fino alla cancellazione', async () => {
    asShopRedact();
    await processComplianceRequest('req-1');

    expect(eraseShopRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: SHOP,
        webhookId: 'consegna-1',
        topic: 'shop/redact',
      }),
    );
  });

  it('fallita: la riga resta, perche il negozio e ancora li', async () => {
    asShopRedact();
    (eraseShopRecord as any).mockResolvedValue({
      outcome: 'failed',
      shopId: 'shop-1',
      steps: [{ table: 'sessions', outcome: 'failed', rows: 0, detail: 'timeout' }],
    });

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    expect(prisma.complianceRequest.deleteMany).not.toHaveBeenCalled();
  });
});

describe('quando va male', () => {
  const fallisce = () =>
    (eraseCustomerFromMerchant as any).mockResolvedValue([
      { table: 'customers', outcome: 'failed', rows: 0, detail: 'timeout' },
    ]);

  it('un fallimento torna in coda per il giro dopo', async () => {
    fallisce();

    await processComplianceRequest('req-1');

    expect(lastUpdate().status).toBe('failed');
    expect(lastUpdate().lastError).toContain('timeout');
  });

  it('il ritentativo si distanzia, invece di ripartire subito', async () => {
    // Cinque tentativi tutti allo stesso intervallo contro un progetto che non
    // risponde sono cinque modi di fare lo stesso errore in mezz'ora.
    fallisce();
    const now = new Date('2026-09-10T12:00:00Z');

    await processComplianceRequest('req-1', now);

    expect(lastUpdate().nextAttemptAt).toBeInstanceOf(Date);
    expect(lastUpdate().nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('il lease si rilascia insieme allo stato: chi ha finito non tiene niente', async () => {
    fallisce();
    await processComplianceRequest('req-1');

    expect(lastUpdate().leaseOwner).toBeNull();
    expect(lastUpdate().leaseExpiresAt).toBeNull();
  });

  /**
   * IL TENTATIVO NUMERO MAX E' L'ULTIMO DAVVERO ESEGUITO, NON IL PENULTIMO.
   *
   * Prima il valore arrivava incrementato due volte — una dalla presa, una da
   * chi decideva la lettera morta — e la richiesta di una persona vera si
   * fermava al quarto tentativo dichiarando di averne fatti cinque.
   */
  it(`il tentativo ${MAX_ATTEMPTS - 1} lascia ancora un tentativo da fare`, async () => {
    (prisma.$queryRaw as any).mockResolvedValue(claimed({ attempts: MAX_ATTEMPTS - 1 }));
    fallisce();

    await processComplianceRequest('req-1');

    expect(lastUpdate().status).toBe('failed');
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('ALLARME');
  });

  it(`il tentativo ${MAX_ATTEMPTS} viene eseguito, e solo dopo si smette`, async () => {
    // Restare a ritentare in eterno sarebbe peggio: la richiesta di una persona
    // vera sarebbe ferma e nessuno se ne accorgerebbe.
    (prisma.$queryRaw as any).mockResolvedValue(claimed({ attempts: MAX_ATTEMPTS }));
    fallisce();

    await processComplianceRequest('req-1');

    // Il lavoro e' stato fatto: e' l'ultimo tentativo, non uno saltato.
    expect(eraseCustomerFromMerchant).toHaveBeenCalled();
    expect(lastUpdate().status).toBe('dead_letter');
    const allarme = errorSpy.mock.calls.flat().join(' ');
    expect(allarme).toContain('ALLARME');
    expect(allarme).toContain(`${MAX_ATTEMPTS} tentativi`);
  });

  /**
   * LA PROVA E' UNA CONDIZIONE, NON UN DI PIU'.
   *
   * Prima l'errore di scrittura della traccia veniva inghiottito da un `catch`
   * che scriveva un `console.error` e lasciava proseguire: la richiesta si
   * dichiarava completata, e l'unica prova rimasta era testo in un log a
   * ritenzione breve. Davanti a chi la chiede, quella richiesta non risulta
   * eseguita affatto.
   */
  it('traccia non scritta: la richiesta NON si chiude', async () => {
    (saveGdprOutcome as any).mockRejectedValue(new Error('registro non raggiungibile'));

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    expect(lastUpdate().status).toBe('failed');
    expect(lastUpdate().completedAt).toBeUndefined();
  });

  it('un errore inatteso non fa risultare la richiesta eseguita', async () => {
    (eraseCustomerFromMerchant as any).mockRejectedValue(new Error('chiave non decifrabile'));

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
  });

  it('la traccia registra i passi, mai i dati della persona', async () => {
    await processComplianceRequest('req-1');
    const scritto = JSON.stringify((saveGdprOutcome as any).mock.calls.at(-1)[1]);

    expect(scritto).not.toContain('4021');
    expect(scritto).toContain('impronta');
  });
});

describe('il giro del cron', () => {
  it('non dipende dalla coda: riprende cio che e rimasto indietro', async () => {
    // Se la sveglia non e mai arrivata — Redis giu al momento della presa in
    // carico — la riga e comunque qui. E questo passaggio a rendere la coda
    // durevole invece di una speranza.
    (prisma.complianceRequest.findMany as any).mockResolvedValue([{ id: 'req-1' }]);

    const { processed } = await drainComplianceRequests();

    expect(processed).toBe(1);
  });

  /**
   * Prima il ripristino di una 'processing' abbandonata stava QUI, quindi
   * avveniva solo se a passare era il cron: una richiesta svegliata dalla coda
   * su una riga abbandonata trovava la presa chiusa e se ne andava. Adesso la
   * riprende la presa, e il drenaggio si limita a passargliela.
   */
  it('una lavorazione abbandonata a meta viene ripresa', async () => {
    (prisma.complianceRequest.findMany as any).mockResolvedValue([{ id: 'req-1' }]);

    const { processed } = await drainComplianceRequests();

    const or = (prisma.complianceRequest.findMany as any).mock.calls[0][0].where.OR;
    const abbandonate = or.filter((c: any) => c.status === 'processing');
    expect(abbandonate).toHaveLength(2);
    expect(abbandonate.some((c: any) => c.leaseExpiresAt?.lt instanceof Date)).toBe(true);
    // Le righe rimaste in volo da prima che il lease esistesse: su NULL un
    // confronto non e falso, e nullo, quindi va detto esplicitamente.
    expect(abbandonate.some((c: any) => c.leaseExpiresAt === null)).toBe(true);

    // E nessuna scrittura per riportarla a mano in 'failed': non serve piu.
    expect(prisma.complianceRequest.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    expect(processed).toBe(1);
  });

  it('le fallite si riprendono quando l attesa scritta sulla riga e scaduta', async () => {
    (prisma.complianceRequest.findMany as any).mockResolvedValue([]);
    const now = new Date('2026-09-10T12:00:00Z');

    await drainComplianceRequests(now);

    const or = (prisma.complianceRequest.findMany as any).mock.calls[0][0].where.OR;
    const dovute = or.find((c: any) => c.status?.in);
    expect(dovute.status.in).toEqual(['queued', 'failed']);
    expect(dovute.nextAttemptAt.lte).toEqual(now);
  });

  it('conta separatamente cio che e riuscito e cio che no', async () => {
    (prisma.complianceRequest.findMany as any).mockResolvedValue([
      { id: 'req-1' },
      { id: 'req-2' },
    ]);
    (eraseCustomerFromMerchant as any)
      .mockResolvedValueOnce([{ table: 'customers', outcome: 'deleted', rows: 1 }])
      .mockResolvedValueOnce([{ table: 'customers', outcome: 'failed', rows: 0, detail: 'x' }]);

    const result = await drainComplianceRequests();

    expect(result).toEqual({ processed: 1, failed: 1 });
  });
});

describe('le esportazioni scadute', () => {
  it('si tolgono davvero, non solo si contano', async () => {
    (prisma.complianceRequest.updateMany as any).mockResolvedValue({ count: 3 });

    const removed = await pruneExpiredExports();

    expect(removed).toBe(3);
    const data = (prisma.complianceRequest.updateMany as any).mock.calls[0][0].data;
    expect(data.export).toBe(Prisma.DbNull);
    expect(data.exportExpiresAt).toBeNull();
  });

  it('una copia dei dati di una persona senza scadenza sarebbe per sempre', async () => {
    (prisma.complianceRequest.updateMany as any).mockResolvedValue({ count: 0 });
    const now = new Date('2026-08-29T12:00:00Z');

    await pruneExpiredExports(now);

    const where = (prisma.complianceRequest.updateMany as any).mock.calls[0][0].where;
    expect(where.exportExpiresAt.lt).toEqual(now);
  });
});
