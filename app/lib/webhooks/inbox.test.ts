import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creaFakeWebhookStore } from './inbox-fake-store';

// La posta in arrivo finta, con l'indice unico e la presa condizionata sullo
// stato: sono quelle due regole a rendere un evento consegnato due volte un
// effetto solo, e dei mock che dicono sempre di si' non le proverebbero.
const store = creaFakeWebhookStore();
const righe = store.righe;
const webhookEvent = {
  create: vi.fn(store.create),
  findUnique: vi.fn(store.findUnique),
  findMany: vi.fn(store.findMany),
  updateMany: vi.fn(store.updateMany),
  update: vi.fn(store.update),
  deleteMany: vi.fn(store.deleteMany),
};

// Il getter e' necessario, non una civetteria: `vi.mock` viene issato in cima
// al file, quindi la fabbrica gira prima che `webhookEvent` esista. Con il
// getter il riferimento si risolve alla prima lettura, che avviene dopo.
vi.mock('~/db.server', () => ({
  prisma: {
    get webhookEvent() {
      return webhookEvent;
    },
  },
}));

import {
  drainWebhookEvents,
  listDeadWebhookEvents,
  processWebhookEvent,
  pruneWebhookEvents,
  recordWebhookReceipt,
  replayDeadWebhookEvents,
} from './inbox.server';
import { MAX_WEBHOOK_ATTEMPTS, WEBHOOK_TOPICS } from './inbox-model';
import type { WebhookProcessor } from './inbox.server';
import type { WebhookTopic } from './inbox-model';

const ORA = new Date('2026-09-05T12:00:00.000Z');

/**
 * L'elenco completo dei processori, con quello della disinstallazione scelto
 * dal test. Si costruisce dai topic invece di elencarli a mano: cosi' un topic
 * nuovo non lascia questo file indietro senza che nessuno se ne accorga.
 */
function processori(uninstall: WebhookProcessor): Record<WebhookTopic, WebhookProcessor> {
  const tutti = {} as Record<WebhookTopic, WebhookProcessor>;
  for (const topic of WEBHOOK_TOPICS) tutti[topic] = async () => 'done';
  return { ...tutti, 'app/uninstalled': uninstall };
}

function consegna(webhookId = 'consegna-1') {
  return {
    topic: 'app/uninstalled' as const,
    shopDomain: 'negozio.myshopify.com',
    webhookId,
    payload: { id: 1 },
  };
}

describe('la ricevuta', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
  });

  it('scrive una riga, e la riga e la presa in carico', async () => {
    const esito = await recordWebhookReceipt(consegna());

    expect(esito.duplicate).toBe(false);
    expect(righe).toHaveLength(1);
    expect(righe[0].status).toBe('queued');
  });

  it('solleva se la scrittura non riesce: chi chiama deve poter rispondere 5xx', async () => {
    // E' il punto di tutto il lavoro: senza la riga, l'evento non lo lavorera'
    // mai nessuno, e un 200 direbbe a Shopify di non ritentare.
    webhookEvent.create.mockRejectedValueOnce(new Error('database irraggiungibile'));

    await expect(recordWebhookReceipt(consegna())).rejects.toThrow('database irraggiungibile');
  });

  it('rifiuta un topic che nessuno sa lavorare, invece di scrivere una riga morta', async () => {
    await expect(
      recordWebhookReceipt({ ...consegna(), topic: 'orders/paid' as never }),
    ).rejects.toThrow('topic non gestito');
    expect(righe).toHaveLength(0);
  });

  it('lo stesso id di consegna due volte → una riga sola', async () => {
    const prima = await recordWebhookReceipt(consegna());
    const seconda = await recordWebhookReceipt(consegna());

    expect(seconda.duplicate).toBe(true);
    expect(seconda.id).toBe(prima.id);
    expect(righe).toHaveLength(1);
  });

  it('non riscrive il corpo della consegna gia presa', async () => {
    // La prima consegna e' quella in lavorazione: cambiarle il payload sotto i
    // piedi mentre lo sta leggendo e' il conflitto che la deduplica evita.
    await recordWebhookReceipt(consegna());
    await recordWebhookReceipt({ ...consegna(), payload: { id: 999 } });

    expect(righe[0].payload).toEqual({ id: 1 });
  });
});

describe('l elaborazione', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
  });

  it('lo stesso evento lavorato due volte → un solo effetto', async () => {
    const { id } = await recordWebhookReceipt(consegna());
    const lavoro = vi.fn(async () => 'done' as const);

    await processWebhookEvent(id, processori(lavoro), ORA);
    const secondo = await processWebhookEvent(id, processori(lavoro), ORA);

    expect(lavoro).toHaveBeenCalledTimes(1);
    expect(secondo).toBe('skipped');
    expect(righe[0].status).toBe('completed');
  });

  it('un fallimento non cancella il lavoro: torna in attesa, distanziato', async () => {
    const { id } = await recordWebhookReceipt(consegna());

    const esito = await processWebhookEvent(
      id,
      processori(async () => {
        throw new Error('il database non risponde');
      }),
      ORA,
    );

    expect(esito).toBe('retried');
    expect(righe[0].status).toBe('queued');
    expect(righe[0].attempts).toBe(1);
    expect(righe[0].nextAttemptAt.getTime()).toBeGreaterThan(ORA.getTime());
    expect(righe[0].lastError).toContain('il database non risponde');
  });

  it('oltre la soglia si smette, e lo si dice forte', async () => {
    const { id } = await recordWebhookReceipt(consegna());
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let giro = 0; giro < MAX_WEBHOOK_ATTEMPTS; giro++) {
      righe[0].status = 'queued';
      await processWebhookEvent(
        id,
        processori(async () => {
          throw new Error('guasto');
        }),
        ORA,
      );
    }

    expect(righe[0].status).toBe('dead_letter');
    expect(allarme.mock.calls.some((c) => String(c[0]).includes('ALLARME'))).toBe(true);
    allarme.mockRestore();
  });

  it('un esito senza speranza va in lettera morta subito, non dopo cinque giri', async () => {
    const { id } = await recordWebhookReceipt(consegna());
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});

    const esito = await processWebhookEvent(id, processori(async () => 'dead_letter'), ORA);

    expect(esito).toBe('dead_letter');
    expect(righe[0].attempts).toBe(1);
    allarme.mockRestore();
  });

  it('non lascia mai un evento dichiarato fatto quando non lo e', async () => {
    // E' la bugia peggiore che questa tabella possa raccontare: da 'completed'
    // non ci torna piu' nessuno.
    const { id } = await recordWebhookReceipt(consegna());

    await processWebhookEvent(
      id,
      processori(async () => {
        throw new Error('guasto');
      }),
      ORA,
    );

    expect(righe[0].status).not.toBe('completed');
    expect(righe[0].completedAt).toBeNull();
  });
});

describe('il drenaggio', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
  });

  it('riprende quel che era stato ricevuto e mai lavorato', async () => {
    await recordWebhookReceipt(consegna('a'));
    await recordWebhookReceipt(consegna('b'));

    const esito = await drainWebhookEvents(processori(async () => 'done'), ORA);

    expect(esito.processed).toBe(2);
    expect(righe.every((r) => r.status === 'completed')).toBe(true);
  });

  it('il budget del tempo ferma il giro, e non perde niente', async () => {
    // Il tetto al numero da solo non basta piu': da quando qui dentro passano
    // anche prodotti, clienti e ordini, ogni evento parla con Shopify e con il
    // database del merchant. Senza un tetto al TEMPO un arretrato di ordini
    // terrebbe fermo tutto il resto del giro del cron — comprese le
    // sincronizzazioni che stanno subito dopo.
    for (const id of ['a', 'b', 'c', 'd']) await recordWebhookReceipt(consegna(id));

    // Ogni lavorazione costa piu' del budget: dopo la prima si smette.
    const lento = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 12));
      return 'done' as const;
    });

    const esito = await drainWebhookEvents(processori(lento), ORA, 10, 10);

    expect(esito.budgetExhausted).toBe(true);
    expect(lento).toHaveBeenCalledTimes(1);
    // Non si e' perso niente: le altre tre sono ancora da lavorare, con la loro
    // scadenza gia' passata, quindi il giro dopo le ritrova in cima.
    expect(righe.filter((r) => r.status === 'queued')).toHaveLength(3);
  });

  it('quando gli eventi finiscono prima del budget, il budget non risulta speso', async () => {
    await recordWebhookReceipt(consegna('a'));

    const esito = await drainWebhookEvents(processori(async () => 'done'), ORA, 10, 10_000);

    expect(esito.budgetExhausted).toBe(false);
    expect(esito.processed).toBe(1);
  });

  it('non tocca quel che e ancora distanziato', async () => {
    await recordWebhookReceipt(consegna('a'));
    righe[0].nextAttemptAt = new Date(ORA.getTime() + 60_000);

    const lavoro = vi.fn(async () => 'done' as const);
    await drainWebhookEvents(processori(lavoro), ORA);

    expect(lavoro).not.toHaveBeenCalled();
  });

  it('recupera una lavorazione interrotta a meta', async () => {
    // Su una funzione serverless l'invocazione puo' morire fra la presa e la
    // chiusura: senza questo ramo l'evento resterebbe 'processing' per sempre,
    // e un negozio disinstallato resterebbe attivo — il guasto di partenza.
    await recordWebhookReceipt(consegna('a'));
    righe[0].status = 'processing';
    righe[0].startedAt = new Date(ORA.getTime() - 60 * 60_000);

    const esito = await drainWebhookEvents(processori(async () => 'done'), ORA);

    expect(esito.processed).toBe(1);
    expect(righe[0].status).toBe('completed');
  });

  it('non strappa una lavorazione appena cominciata', async () => {
    await recordWebhookReceipt(consegna('a'));
    righe[0].status = 'processing';
    righe[0].startedAt = new Date(ORA.getTime() - 1000);

    const lavoro = vi.fn(async () => 'done' as const);
    await drainWebhookEvents(processori(lavoro), ORA);

    expect(lavoro).not.toHaveBeenCalled();
  });
});

describe('la potatura e il replay', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
  });

  it('toglie di mezzo le concluse vecchie, non le ferme', async () => {
    await recordWebhookReceipt(consegna('conclusa'));
    righe[0].status = 'completed';
    righe[0].completedAt = new Date(ORA.getTime() - 30 * 24 * 60 * 60_000);

    await recordWebhookReceipt(consegna('ferma'));
    righe[1].status = 'dead_letter';

    const tolte = await pruneWebhookEvents(ORA);

    expect(tolte).toBe(1);
    // La lettera morta e' l'unica traccia di un evento mai applicato:
    // cancellarla vorrebbe dire far sparire il problema invece di risolverlo.
    expect(righe.map((r) => r.status)).toEqual(['dead_letter']);
  });

  it('il replay riparte con i tentativi azzerati', async () => {
    await recordWebhookReceipt(consegna('ferma'));
    righe[0].status = 'dead_letter';
    righe[0].attempts = MAX_WEBHOOK_ATTEMPTS;

    expect(await listDeadWebhookEvents()).toHaveLength(1);

    const rimessi = await replayDeadWebhookEvents(undefined, ORA);

    expect(rimessi).toBe(1);
    expect(righe[0].status).toBe('queued');
    // Ripartire con il contatore pieno vorrebbe dire un solo tentativo prima di
    // tornare dov'era.
    expect(righe[0].attempts).toBe(0);
  });
});
