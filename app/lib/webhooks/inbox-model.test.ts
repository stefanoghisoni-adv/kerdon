import { describe, it, expect } from 'vitest';
import {
  MAX_WEBHOOK_ATTEMPTS,
  MAX_WEBHOOK_BODY_BYTES,
  WEBHOOK_BACKOFF_MAX_MS,
  WEBHOOK_RESPONSE_HARD_LIMIT_MS,
  WEBHOOK_RESPONSE_TARGET_MS,
  isExhausted,
  isWebhookTopic,
  nextWebhookAttemptAt,
  responseBudgetReport,
  statusAfterAttempt,
} from './inbox-model';

const ORA = new Date('2026-09-05T12:00:00.000Z');

describe('i topic accettati', () => {
  it('sono i due amministrativi, e nessun altro', () => {
    expect(isWebhookTopic('app/uninstalled')).toBe(true);
    expect(isWebhookTopic('app_subscriptions/update')).toBe(true);
  });

  it('non comprendono i webhook di conformita: quelli hanno la loro posta in arrivo', () => {
    // Non e' un dettaglio di elenco: `compliance_requests` ha i termini di
    // legge e il payload che si cancella da solo. Farli passare di qui
    // vorrebbe dire conservare l'id di una persona in una tabella che non e'
    // fatta per quello.
    expect(isWebhookTopic('customers/redact')).toBe(false);
    expect(isWebhookTopic('shop/redact')).toBe(false);
  });

  it('accetta anche i topic operativi, che ora passano dalla stessa posta in arrivo', () => {
    // Prodotti, clienti e ordini facevano il lavoro dentro la richiesta HTTP e
    // non lasciavano nessuna riga: una consegna ritentata rifaceva tutto da
    // capo. Adesso hanno la ricevuta, la presa e la lettera morta degli altri.
    expect(isWebhookTopic('products/update')).toBe(true);
    expect(isWebhookTopic('customers/delete')).toBe(true);
    expect(isWebhookTopic('refunds/create')).toBe(true);
    expect(isWebhookTopic('orders/delete')).toBe(true);
  });

  it('rifiuta quello che non e una stringa nota', () => {
    // Un topic mai iscritto non deve poter creare una riga: nessun processore
    // saprebbe lavorarla, e resterebbe in attesa per sempre.
    expect(isWebhookTopic('orders/paid')).toBe(false);
    expect(isWebhookTopic('products/updated')).toBe(false);
    expect(isWebhookTopic(undefined)).toBe(false);
    expect(isWebhookTopic(42)).toBe(false);
  });
});

describe('il distanziamento fra un tentativo e l altro', () => {
  it('parte da un minuto e raddoppia', () => {
    expect(nextWebhookAttemptAt(1, ORA).getTime() - ORA.getTime()).toBe(60_000);
    expect(nextWebhookAttemptAt(2, ORA).getTime() - ORA.getTime()).toBe(120_000);
    expect(nextWebhookAttemptAt(3, ORA).getTime() - ORA.getTime()).toBe(240_000);
  });

  it('non supera mai il tetto', () => {
    // Senza tetto il raddoppio arriva a giorni, e un evento fermo per un guasto
    // gia' risolto resterebbe fermo per tutti quelli.
    for (const tentativo of [10, 20, 50]) {
      expect(nextWebhookAttemptAt(tentativo, ORA).getTime() - ORA.getTime()).toBe(
        WEBHOOK_BACKOFF_MAX_MS,
      );
    }
  });

  it('al primo tentativo non torna indietro nel tempo', () => {
    expect(nextWebhookAttemptAt(0, ORA).getTime()).toBeGreaterThan(ORA.getTime());
  });
});

describe('quando si smette di riprovare', () => {
  it('non prima della soglia', () => {
    expect(isExhausted(MAX_WEBHOOK_ATTEMPTS - 1)).toBe(false);
    expect(isExhausted(MAX_WEBHOOK_ATTEMPTS)).toBe(true);
  });
});

describe('lo stato dopo un tentativo', () => {
  it('riuscito → concluso', () => {
    expect(statusAfterAttempt('done', 1)).toBe('completed');
  });

  it('da ritentare → torna in attesa, non "fallito"', () => {
    // Non esiste uno stato 'failed', come nella coda: cosi' c'e' un posto solo
    // da guardare per sapere cosa e' pronto.
    expect(statusAfterAttempt('retry', 1)).toBe('queued');
  });

  it('da ritentare oltre la soglia → lettera morta', () => {
    expect(statusAfterAttempt('retry', MAX_WEBHOOK_ATTEMPTS)).toBe('dead_letter');
  });

  it('senza speranza → lettera morta subito, senza consumare i tentativi', () => {
    // Un listino senza piano gratuito non si aggiusta ritentando: continuare a
    // riprovare vorrebbe dire solo ritardare il momento in cui qualcuno se ne
    // accorge.
    expect(statusAfterAttempt('dead_letter', 1)).toBe('dead_letter');
  });

  it('non riporta mai l evento in lavorazione', () => {
    // Se lo facesse, la riga resterebbe presa da un processo che ha gia'
    // finito, e solo la scadenza del drenaggio la libererebbe.
    for (const esito of ['done', 'retry', 'dead_letter'] as const) {
      expect(statusAfterAttempt(esito, 1)).not.toBe('processing');
    }
  });
});

describe('il budget di risposta', () => {
  it('il percentile e una misura presa davvero, non una media fra due', () => {
    // "Piu' vicino al rango": su venti misure il novantacinquesimo percentile
    // e' la diciannovesima, e la ventesima resta il massimo. Interpolare
    // vorrebbe dire giudicare il budget su un tempo che nessuno ha mai
    // misurato — e su poche misure e' proprio il caso in cui serve.
    const misure = Array.from({ length: 20 }, (_v, i) => (i + 1) * 10);
    expect(responseBudgetReport(misure).p95Ms).toBe(190);
    expect(responseBudgetReport(misure).maxMs).toBe(200);
  });

  it('con una misura sola, percentile e massimo coincidono', () => {
    expect(responseBudgetReport([42])).toMatchObject({ p95Ms: 42, maxMs: 42 });
  });

  it("l'ordine in cui arrivano le misure non conta", () => {
    expect(responseBudgetReport([900, 10, 50]).maxMs).toBe(900);
    expect(responseBudgetReport([50, 900, 10]).maxMs).toBe(900);
  });

  it('sopra il secondo il bersaglio e mancato, sopra i cinque il muro e sfondato', () => {
    // Le due soglie non dicono la stessa cosa. Il bersaglio e' dove le risposte
    // devono stare; il muro e' il punto oltre il quale Shopify considera la
    // consegna non riuscita e ritenta — e ritentare quando in realta' avevamo
    // appena finito e' il modo esatto in cui nascono i doppioni.
    const lente = Array(20).fill(WEBHOOK_RESPONSE_TARGET_MS + 1);
    expect(responseBudgetReport(lente).withinTarget).toBe(false);
    expect(responseBudgetReport(lente).withinHardLimit).toBe(true);

    const oltreIlMuro = [...Array(19).fill(10), WEBHOOK_RESPONSE_HARD_LIMIT_MS + 1];
    expect(responseBudgetReport(oltreIlMuro).withinHardLimit).toBe(false);
  });

  it('nessuna misura non e un fallimento', () => {
    expect(responseBudgetReport([])).toMatchObject({ withinTarget: true, withinHardLimit: true });
  });
});

describe('il tetto del corpo', () => {
  it('e largo per quel che Shopify manda davvero', () => {
    // Un ordine con centinaia di righe o un prodotto con centinaia di varianti
    // stanno abbondantemente sotto: il tetto ferma il corpo sbagliato, non
    // quello grande.
    expect(MAX_WEBHOOK_BODY_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(MAX_WEBHOOK_BODY_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
