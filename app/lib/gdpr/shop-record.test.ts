import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn(), update: vi.fn() },
    shopErasureProof: { findUnique: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('~/lib/queue/shop-lock.server', () => ({ runWithShopLease: vi.fn() }));
vi.mock('~/lib/read-proxy/context.server', () => ({
  invalidateReadContextForShop: vi.fn(),
  invalidateReadContextForDomain: vi.fn(),
}));

import { prisma } from '~/db.server';
import { runWithShopLease } from '~/lib/queue/shop-lock.server';
import { invalidateReadContextForShop } from '~/lib/read-proxy/context.server';
import { eraseShopRecord } from './shop-record.server';
import { shopErasureRef } from './erasure-proof.server';
import { stepsFailed } from './steps';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * La cancellazione di un negozio.
 *
 * IL GUASTO DA CUI QUESTO FILE NASCE, per intero, perche' e' quello che ogni
 * prova qui sotto rende impossibile. Le tre cancellazioni — log di accesso,
 * sessioni, `shops` — stavano in tre `try` separati, in quest'ordine, con la
 * motivazione scritta accanto: "se uno cade, gli altri devono comunque provarci
 * — meglio nove tabelle su dieci di zero". Ma la relazione dei log e' ON DELETE
 * SET NULL: se i log fallivano e `shops` riusciva, quelle righe restavano con
 * lo `shop_id` azzerato, e il ritentativo — che riparte dal DOMINIO — non
 * trovava piu' nessun negozio da cui ricavare l'id. Non erano nove tabelle su
 * dieci: erano righe che nessuno avrebbe mai piu' potuto togliere.
 *
 * E la traccia di controllo finiva in `sync_jobs`, che cade in cascata con il
 * negozio: la prova si autodistruggeva insieme a cio' che doveva provare, e
 * quel che restava era un `console.log`.
 *
 * Le quattro proprieta' che qui si difendono, in ordine di quanto costa
 * perderle: non si comincia senza lucchetto; o si cancella tutto o niente; la
 * prova sopravvive al negozio e non contiene il negozio; senza la prova la
 * richiesta non si chiude.
 */

const SHOP_DOMAIN = 'negozio-di-prova.myshopify.com';
const SHOP_ID = 'shop-1';
const WEBHOOK_ID = 'consegna-abc';
const NOW = new Date('2026-09-05T10:00:00Z');

/** Le operazioni dentro la transazione: una per tabella, tutte controllabili. */
let tx: any;
let errorSpy: any;

function richiesta(over: Record<string, unknown> = {}) {
  return {
    shopDomain: SHOP_DOMAIN,
    webhookId: WEBHOOK_ID,
    topic: 'shop/redact',
    now: NOW,
    ...over,
  };
}

/** L'argomento con cui la prova e' stata creata dentro la transazione. */
function provaScritta() {
  return tx.shopErasureProof.create.mock.calls.at(-1)?.[0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  tx = {
    customerDataAccessLog: { deleteMany: vi.fn().mockResolvedValue({ count: 7 }) },
    supabaseConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    supabaseOAuthToken: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    session: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    shopErasureProof: { create: vi.fn().mockResolvedValue({ id: 'prova-1' }) },
    shop: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };

  // La transazione vera annulla tutto se il callback solleva: qui si riproduce
  // la sola cosa che al codice interessa — che il lancio esca, e che nessuno
  // scambi per riuscita una transazione annullata.
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(tx));

  (prisma.shopErasureProof.findUnique as any).mockResolvedValue(null);
  (prisma.shop.findUnique as any).mockResolvedValue({ id: SHOP_ID });
  (prisma.shop.update as any).mockResolvedValue({ erasureGeneration: 5 });
  (prisma.shopErasureProof.create as any).mockResolvedValue({ id: 'prova-vuota' });

  (runWithShopLease as any).mockImplementation(async (_id: string, run: any) => {
    await run({ shopId: _id, assertHeld: vi.fn().mockResolvedValue(undefined) });
    return 'eseguito';
  });
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('il lucchetto viene prima di tutto', () => {
  /**
   * FAIL-CLOSED. Un negozio occupato vuol dire che qualcun altro ci sta gia'
   * lavorando dentro: cominciare lo stesso vorrebbe dire cancellare righe sotto
   * i piedi di chi le sta scrivendo. La richiesta resta ritentabile, che e'
   * l'unica risposta che non perde niente.
   */
  it('negozio occupato: non si marca e non si cancella niente', async () => {
    (runWithShopLease as any).mockResolvedValue('occupato');

    const esito = await eraseShopRecord(richiesta());

    expect(esito.outcome).toBe('busy');
    expect(esito.shopId).toBe(SHOP_ID);
    expect(stepsFailed(esito.steps)).toBe(true);
    expect(prisma.shop.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  /**
   * Il caso che nella versione su Redis andava al contrario: lucchetto
   * irraggiungibile, si proseguiva lo stesso. Qui il backend giu' significa che
   * non si sa se qualcuno stia lavorando, e non saperlo vale quanto saperlo.
   */
  it('backend del lucchetto giu: nessuna cancellazione parziale', async () => {
    (runWithShopLease as any).mockResolvedValue('non-disponibile');

    const esito = await eraseShopRecord(richiesta());

    expect(esito.outcome).toBe('lock_unavailable');
    expect(esito.shopId).toBe(SHOP_ID);
    expect(prisma.shop.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
    expect(tx.shop.deleteMany).not.toHaveBeenCalled();
  });

  it('verifica il possesso prima di cominciare', async () => {
    const assertHeld = vi.fn().mockResolvedValue(undefined);
    (runWithShopLease as any).mockImplementation(async (_id: string, run: any) => {
      await run({ shopId: _id, assertHeld });
      return 'eseguito';
    });

    await eraseShopRecord(richiesta());

    expect(assertHeld).toHaveBeenCalled();
  });

  /**
   * La cancellazione e' l'unico lavoro che ha il diritto di alzare il gettone
   * del ciclo di vita, quindi e' anche l'unico a cui il lucchetto non deve
   * rinfacciarlo: senza, la verifica del possesso si accorgerebbe della
   * cancellazione — la propria — e la fermerebbe.
   */
  it('chiede il lucchetto dichiarando che sta cancellando', async () => {
    await eraseShopRecord(richiesta());

    const opts = (runWithShopLease as any).mock.calls[0][2];
    expect(opts).toMatchObject({ duringErasure: true });
  });
});

describe('la marcatura, prima della transazione', () => {
  /**
   * Deve essere visibile MENTRE si cancella, non alla fine: dentro la
   * transazione nessun altro la vedrebbe fino al commit, cioe' per tutta la
   * parte lunga il negozio risulterebbe ancora aperto a chiunque legga.
   */
  it('chiude il negozio alle scritture prima di toccare qualunque riga', async () => {
    const ordine: string[] = [];
    (prisma.shop.update as any).mockImplementation(async () => {
      ordine.push('marcatura');
      return { erasureGeneration: 5 };
    });
    tx.session.deleteMany.mockImplementation(async () => {
      ordine.push('cancellazione');
      return { count: 2 };
    });

    await eraseShopRecord(richiesta());

    expect(ordine).toEqual(['marcatura', 'cancellazione']);
    expect((prisma.shop.update as any).mock.calls[0][0].data.lifecycleStatus).toBe('erasing');
  });

  it('la generazione finisce nella prova', async () => {
    await eraseShopRecord(richiesta());

    expect(provaScritta().erasureGeneration).toBe(5);
  });

  it('svuota subito le cache che tenevano la chiave di servizio', async () => {
    await eraseShopRecord(richiesta());

    expect(invalidateReadContextForShop).toHaveBeenCalledWith(SHOP_ID);
  });
});

describe('la transazione: tutto, o niente', () => {
  it('riuscita: negozio, credenziali, sessioni e log spariscono insieme', async () => {
    const esito = await eraseShopRecord(richiesta());

    expect(esito.outcome).toBe('erased');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    expect(tx.customerDataAccessLog.deleteMany).toHaveBeenCalledWith({
      where: { shopId: SHOP_ID },
    });
    expect(tx.supabaseConfig.deleteMany).toHaveBeenCalledWith({ where: { shopId: SHOP_ID } });
    expect(tx.supabaseOAuthToken.deleteMany).toHaveBeenCalledWith({ where: { shopId: SHOP_ID } });
    // Le sessioni si legano al DOMINIO, non alla riga: nessuna cascata le
    // porterebbe via, e dentro ci sono l'access token e i dati di chi ha
    // installato l'app.
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP_DOMAIN } });
    expect(tx.shop.deleteMany).toHaveBeenCalledWith({ where: { id: SHOP_ID } });
  });

  /**
   * `shops` per ultima, e non e' pignoleria sull'ordine: la relazione dei log
   * e' SET NULL, quindi cancellare il negozio per primo li lascerebbe orfani
   * con lo `shop_id` azzerato — il guasto da cui e' partito tutto.
   */
  it('cancella il negozio per ultimo, dopo le righe che il vincolo lascerebbe orfane', async () => {
    const ordine: string[] = [];
    const segna = (nome: string, count: number) => async () => {
      ordine.push(nome);
      return { count };
    };
    tx.customerDataAccessLog.deleteMany.mockImplementation(segna('log', 7));
    tx.session.deleteMany.mockImplementation(segna('sessioni', 2));
    tx.shopErasureProof.create.mockImplementation(async () => {
      ordine.push('prova');
      return { id: 'prova-1' };
    });
    tx.shop.deleteMany.mockImplementation(segna('shops', 1));

    await eraseShopRecord(richiesta());

    expect(ordine.indexOf('log')).toBeLessThan(ordine.indexOf('shops'));
    expect(ordine.indexOf('sessioni')).toBeLessThan(ordine.indexOf('shops'));
    expect(ordine.indexOf('prova')).toBeLessThan(ordine.indexOf('shops'));
    expect(ordine.at(-1)).toBe('shops');
  });

  /**
   * UNA PROVA PER OGNI DELETE, ed e' il cuore di questo file. Qualunque
   * cancellazione fallisca, l'esito e' lo stesso: niente e' stato cancellato, e
   * lo `shopId` torna indietro valorizzato — cioe' il ritentativo ha ancora un
   * negozio da cui ripartire. Prima, a seconda di quale falliva, poteva non
   * averlo piu'.
   */
  const passi: Array<[string, () => any]> = [
    ['customer_data_access_logs', () => tx.customerDataAccessLog.deleteMany],
    ['supabase_configs', () => tx.supabaseConfig.deleteMany],
    ['supabase_oauth_tokens', () => tx.supabaseOAuthToken.deleteMany],
    ['sessions', () => tx.session.deleteMany],
    ['shops', () => tx.shop.deleteMany],
  ];

  for (const [nome, quale] of passi) {
    it(`fallimento su ${nome}: transazione annullata, lo shopId resta disponibile`, async () => {
      quale().mockRejectedValue(new Error(`${nome} non risponde`));

      const esito = await eraseShopRecord(richiesta());

      expect(esito.outcome).toBe('failed');
      // Il ritentativo riparte dal dominio e ha bisogno di ritrovare l'id: era
      // esattamente questo che si perdeva quando il negozio veniva cancellato
      // mentre le righe collegate restavano indietro.
      expect(esito.shopId).toBe(SHOP_ID);
      expect(stepsFailed(esito.steps)).toBe(true);
      expect(esito.steps[0].detail).toContain('nessuna riga cancellata');
      expect(esito.proofId).toBeUndefined();
    });
  }

  /**
   * SE LA PROVA NON SI SCRIVE, LA RICHIESTA NON SI CHIUDE. La prova sta dentro
   * la transazione apposta: fuori e prima dichiarerebbe cancellato un negozio
   * che una `shops` fallita lascerebbe li'; fuori e dopo, un guasto fra le due
   * lascerebbe una cancellazione senza nessuna prova.
   */
  it('fallimento sulla scrittura della prova: niente completata, niente cancellato', async () => {
    tx.shopErasureProof.create.mockRejectedValue(new Error('registro non raggiungibile'));

    const esito = await eraseShopRecord(richiesta());

    expect(esito.outcome).toBe('failed');
    expect(esito.shopId).toBe(SHOP_ID);
    expect(stepsFailed(esito.steps)).toBe(true);
  });
});

describe('la prova che sopravvive al negozio', () => {
  it('non contiene il dominio ne nessun altro dato della persona', async () => {
    await eraseShopRecord(richiesta());

    const prova = provaScritta();
    const scritto = JSON.stringify(prova);

    expect(scritto).not.toContain(SHOP_DOMAIN);
    expect(scritto).not.toContain('negozio-di-prova');
    expect(scritto).not.toContain('myshopify');
    // E nemmeno l'id interno del negozio: sarebbe un riferimento in piu' a una
    // riga che abbiamo appena finito di cancellare.
    expect(scritto).not.toContain(SHOP_ID);
    expect(prova.shopId).toBeUndefined();
  });

  it('contiene solo quel che serve a dimostrare l esecuzione', async () => {
    await eraseShopRecord(richiesta());

    const prova = provaScritta();
    expect(Object.keys(prova).sort()).toEqual(
      [
        'webhookId',
        'topic',
        'shopRef',
        'procedureVersion',
        'outcome',
        'erasureGeneration',
        'erasedAt',
        'counts',
      ].sort(),
    );
    expect(prova.webhookId).toBe(WEBHOOK_ID);
    expect(prova.topic).toBe('shop/redact');
    expect(prova.erasedAt).toBe(NOW);
    expect(prova.outcome).toBe('completed');
  });

  /**
   * Verificabile senza essere leggibile: chi arriva con la domanda "questo
   * negozio e' stato cancellato?" ricalcola l'impronta e trova la riga.
   */
  it('l impronta corrisponde al negozio, per chi gia sa di chi parla', async () => {
    await eraseShopRecord(richiesta());

    expect(provaScritta().shopRef).toBe(shopErasureRef(SHOP_DOMAIN));
  });

  it('porta i conteggi di quel che e stato tolto, tabella per tabella', async () => {
    await eraseShopRecord(richiesta());

    expect(provaScritta().counts).toEqual({
      customer_data_access_logs: 7,
      supabase_configs: 1,
      supabase_oauth_tokens: 1,
      sessions: 2,
      shops: 1,
    });
  });

  it('i passi restituiti dicono che le credenziali sono state revocate', async () => {
    const esito = await eraseShopRecord(richiesta());

    const configs = esito.steps.find((s) => s.table === 'supabase_configs');
    expect(configs?.outcome).toBe('deleted');
    expect(configs?.detail).toContain('revocata');
  });

  /**
   * Il database del merchant NON si tocca, ed e' dichiarato con zero righe
   * apposta: e' l'unico posto dove restano dati dopo questa richiesta, e chi
   * legge la traccia deve vedere scritto che e' una decisione e non una svista.
   */
  it('dichiara di non aver toccato il database del merchant', async () => {
    const esito = await eraseShopRecord(richiesta());

    const merchant = esito.steps.find((s) => s.table.includes('progetto Supabase'));
    expect(merchant?.outcome).toBe('skipped');
    expect(merchant?.rows).toBe(0);
    expect(merchant?.detail).toContain('proprieta');
  });
});

describe('la seconda consegna della stessa richiesta', () => {
  /**
   * L'IDEMPOTENZA QUI NON PUO' POGGIARE SUL NEGOZIO, perche' il negozio non
   * c'e' piu': la prova e' l'unica cosa in cui la seconda consegna puo'
   * riconoscersi. Senza questa lettura ripartirebbe da zero e — nel caso
   * peggiore, con una riga `shops` ricreata da una reinstallazione —
   * cancellerebbe un negozio vivo per conto di una richiesta gia' eseguita.
   */
  it('trova la prova e non ricrea, ne ricancella, niente', async () => {
    (prisma.shopErasureProof.findUnique as any).mockResolvedValue({ id: 'prova-1' });

    const esito = await eraseShopRecord(richiesta());

    expect(esito.outcome).toBe('already_erased');
    expect(esito.proofId).toBe('prova-1');
    expect(stepsFailed(esito.steps)).toBe(false);
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
    expect(runWithShopLease).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.shopErasureProof.create).not.toHaveBeenCalled();
  });

  it('cerca la prova per id della consegna, che e la chiave che Shopify ripete', async () => {
    await eraseShopRecord(richiesta());

    expect(prisma.shopErasureProof.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { webhookId: WEBHOOK_ID } }),
    );
  });
});

describe('un negozio che non abbiamo mai avuto', () => {
  beforeEach(() => {
    (prisma.shop.findUnique as any).mockResolvedValue(null);
  });

  /**
   * Non c'e' niente da cancellare, ma la richiesta e' arrivata lo stesso e va
   * dimostrata: "di questo negozio non tenevamo nulla" e' una risposta, e una
   * risposta va provata come le altre.
   */
  it('scrive comunque la prova, con i conteggi a zero', async () => {
    const esito = await eraseShopRecord(richiesta());

    expect(esito.outcome).toBe('erased');
    expect(runWithShopLease).not.toHaveBeenCalled();

    const prova = (prisma.shopErasureProof.create as any).mock.calls[0][0].data;
    expect(prova.outcome).toBe('skipped');
    expect(prova.erasureGeneration).toBeNull();
    expect(prova.counts).toEqual({
      sessions: 0,
      supabase_configs: 0,
      supabase_oauth_tokens: 0,
      customer_data_access_logs: 0,
      shops: 0,
    });
  });

  it('se nemmeno quella prova si scrive, la richiesta non si chiude', async () => {
    (prisma.shopErasureProof.create as any).mockRejectedValue(new Error('registro giu'));

    const esito = await eraseShopRecord(richiesta());

    expect(esito.outcome).toBe('failed');
    expect(stepsFailed(esito.steps)).toBe(true);
  });
});
