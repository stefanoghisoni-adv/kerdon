import { describe, it, expect } from 'vitest';
import {
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_BACKOFF_MAX_MS,
  isExhausted,
  isWebhookTopic,
  nextWebhookAttemptAt,
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

  it('rifiuta quello che non e una stringa nota', () => {
    expect(isWebhookTopic('orders/create')).toBe(false);
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
