// app/components/Shipping/feedback.test.ts
//
// Cosa vede il merchant dopo ogni azione della pagina Spedizioni.
//
// Il difetto da cui nasce: l'intento si leggeva da `fetcher.formData`, che
// Remix azzera quando il fetcher torna a riposo — cioe' proprio quando arriva
// la risposta. Nessun toast compariva mai, e la modale si chiudeva comunque:
// un salvataggio rifiutato sembrava riuscito. Ora l'intento viaggia nella
// risposta, e queste prove fissano cosa ne esce.

import { describe, it as prova, expect } from 'vitest';
import { it as italiano } from '~/lib/i18n/it';
import { en as inglese } from '~/lib/i18n/en';
import { feedbackFromActionData } from './feedback';

const t = italiano;

describe('feedbackFromActionData', () => {
  prova('nessuna risposta: niente da mostrare', () => {
    expect(feedbackFromActionData(undefined, t)).toEqual({
      toast: null,
      scopeError: false,
      zoneSaved: false,
      zoneError: null,
    });
  });

  prova('tariffe salvate: toast di successo e modale da chiudere', () => {
    expect(feedbackFromActionData({ intent: 'save-zone-rates', success: true }, t)).toEqual({
      toast: { content: t.shipping.modal.saveSuccess, error: false },
      scopeError: false,
      zoneSaved: true,
      zoneError: null,
    });
  });

  prova('tariffe rifiutate: toast di errore, modale aperta con il messaggio del server', () => {
    const f = feedbackFromActionData(
      { intent: 'save-zone-rates', success: false, error: 'shipping.errors.bracketsHaveGaps' },
      t,
    );
    expect(f.toast).toEqual({ content: t.shipping.modal.saveError, error: true });
    expect(f.zoneSaved).toBe(false);
    expect(f.zoneError).toBe(t.shipping.errors.bracketsHaveGaps);
  });

  prova('tariffe rifiutate per un motivo senza testo dedicato: il messaggio generico', () => {
    const f = feedbackFromActionData({ intent: 'save-zone-rates', success: false, error: 'zone_not_found' }, t);
    expect(f.zoneError).toBe(t.shipping.modal.saveError);
    expect(f.toast?.error).toBe(true);
  });

  prova('packaging salvato: toast di successo', () => {
    expect(feedbackFromActionData({ intent: 'save-packaging', success: true }, t).toast).toEqual({
      content: t.shipping.packaging.saveSuccess,
      error: false,
    });
  });

  prova('packaging rifiutato: toast di errore con il motivo quando c e', () => {
    expect(
      feedbackFromActionData(
        { intent: 'save-packaging', success: false, error: 'shipping.packaging.errors.ruleInvalidCategory' },
        t,
      ).toast,
    ).toEqual({ content: t.shipping.packaging.errors.ruleInvalidCategory, error: true });
    expect(
      feedbackFromActionData({ intent: 'save-packaging', success: false, error: 'invalid_request' }, t).toast,
    ).toEqual({ content: t.shipping.packaging.saveError, error: true });
  });

  prova('zone importate: toast di successo, nessun banner', () => {
    const f = feedbackFromActionData({ intent: 'sync-zones', success: true }, t);
    expect(f.toast).toEqual({ content: t.shipping.syncSuccess, error: false });
    expect(f.scopeError).toBe(false);
  });

  prova('importazione fallita: toast di errore', () => {
    const f = feedbackFromActionData({ intent: 'sync-zones', success: false, error: 'sync_error' }, t);
    expect(f.toast).toEqual({ content: t.shipping.syncError, error: true });
    expect(f.scopeError).toBe(false);
  });

  prova('permesso mancante: il banner, non un toast che sparisce', () => {
    const f = feedbackFromActionData({ intent: 'sync-zones', success: false, error: 'scope_error' }, t);
    expect(f.scopeError).toBe(true);
    expect(f.toast).toBeNull();
  });

  prova('una risposta senza intento non inventa un messaggio', () => {
    expect(feedbackFromActionData({ intent: null, success: false, error: 'unknown_intent' }, t).toast).toBeNull();
    expect(feedbackFromActionData({ success: true }, t).toast).toBeNull();
  });

  prova('in inglese i testi arrivano dal dizionario inglese', () => {
    expect(feedbackFromActionData({ intent: 'save-zone-rates', success: true }, inglese).toast?.content).toBe(
      inglese.shipping.modal.saveSuccess,
    );
  });
});
