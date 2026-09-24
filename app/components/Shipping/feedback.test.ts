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
import type { ShippingActionData } from './feedback';

const t = italiano;

describe('feedbackFromActionData', () => {
  prova('nessuna risposta: niente da mostrare', () => {
    expect(feedbackFromActionData(undefined, t)).toEqual({
      toast: null,
      scopeError: false,
      zoneSaved: false,
      zoneError: null,
      optionSaved: false,
      optionError: null,
      packagingSaved: false,
      packagingError: null,
    });
  });

  prova('tariffe salvate: toast di successo e modale da chiudere', () => {
    expect(feedbackFromActionData({ intent: 'save-zone-rates', success: true }, t)).toEqual({
      toast: { content: t.shipping.modal.saveSuccess, error: false },
      scopeError: false,
      zoneSaved: true,
      zoneError: null,
      optionSaved: false,
      optionError: null,
      packagingSaved: false,
      packagingError: null,
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

  prova('costi opzione salvati: toast di successo e modale da chiudere', () => {
    const data: ShippingActionData = { intent: 'save-option-cost', success: true };
    const f = feedbackFromActionData(data, t);
    expect(f.toast).toEqual({ content: t.shipping.optionModal.saveSuccess, error: false });
    expect(f.optionSaved).toBe(true);
    expect(f.optionError).toBeNull();
  });

  prova('costi opzione rifiutati: toast di errore, modale aperta con il motivo', () => {
    const data: ShippingActionData = {
      intent: 'save-option-cost',
      success: false,
      error: 'shipping.errors.invalidFlatCost',
    };
    const f = feedbackFromActionData(data, t);
    expect(f.toast).toEqual({ content: t.shipping.optionModal.saveError, error: true });
    expect(f.optionSaved).toBe(false);
    expect(f.optionError).toBe(t.shipping.errors.invalidFlatCost);
  });

  prova('costi opzione rifiutati per un motivo senza testo dedicato: il messaggio generico', () => {
    const data: ShippingActionData = { intent: 'save-option-cost', success: false, error: 'option_not_found' };
    expect(feedbackFromActionData(data, t).optionError).toBe(t.shipping.optionModal.saveError);
  });

  prova('categoria salvata o eliminata: il suo toast e la modale da chiudere', () => {
    const salvata = feedbackFromActionData({ intent: 'save-category', success: true }, t);
    expect(salvata.toast).toEqual({ content: t.shipping.packaging.categories.saved, error: false });
    expect(salvata.packagingSaved).toBe(true);
    expect(salvata.packagingError).toBeNull();

    const eliminata = feedbackFromActionData({ intent: 'delete-category', success: true }, t);
    expect(eliminata.toast).toEqual({ content: t.shipping.packaging.categories.deleted, error: false });
    expect(eliminata.packagingSaved).toBe(true);
  });

  prova('regola salvata o eliminata: il suo toast e la modale da chiudere', () => {
    expect(feedbackFromActionData({ intent: 'save-rule', success: true }, t)).toMatchObject({
      toast: { content: t.shipping.packaging.rules.saved, error: false },
      packagingSaved: true,
    });
    expect(feedbackFromActionData({ intent: 'delete-rule', success: true }, t)).toMatchObject({
      toast: { content: t.shipping.packaging.rules.deleted, error: false },
      packagingSaved: true,
    });
  });

  prova('eliminazione bloccata: la modale resta aperta con il motivo', () => {
    const f = feedbackFromActionData(
      { intent: 'delete-category', success: false, error: 'shipping.packaging.errors.categoryStillReferenced' },
      t,
    );
    expect(f.packagingSaved).toBe(false);
    expect(f.packagingError).toBe(t.shipping.packaging.errors.categoryStillReferenced);
    expect(f.toast).toEqual({ content: t.shipping.packaging.errors.categoryStillReferenced, error: true });
  });

  prova('modifica rifiutata senza testo dedicato: il messaggio generico nella modale', () => {
    const f = feedbackFromActionData({ intent: 'save-rule', success: false, error: 'invalid_request' }, t);
    expect(f.packagingError).toBe(t.shipping.packaging.saveError);
    expect(f.toast).toEqual({ content: t.shipping.packaging.saveError, error: true });
  });

  prova('peso di default e resi salvati: toast di successo, nessuna modale', () => {
    const f = feedbackFromActionData({ intent: 'save-packaging-defaults', success: true }, t);
    expect(f.toast).toEqual({ content: t.shipping.packaging.saveSuccess, error: false });
    expect(f.packagingSaved).toBe(false);
  });
});
