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

// Il salvataggio ricalcola i costi sugli ordini (recompute-inline.server): il
// toast deve dire se i numeri di Dashboard e Clienti sono gia' quelli nuovi o
// se arrivano fra poco. Mai "aggiornati" se non lo sono.
describe('i numeri dopo un salvataggio', () => {
  const successi: Array<[ShippingActionData['intent'], string]> = [
    ['sync-zones', t.shipping.syncSuccess],
    ['save-zone-rates', t.shipping.modal.saveSuccess],
    ['save-option-cost', t.shipping.optionModal.saveSuccess],
    ['save-category', t.shipping.packaging.categories.saved],
    ['delete-category', t.shipping.packaging.categories.deleted],
    ['save-rule', t.shipping.packaging.rules.saved],
    ['delete-rule', t.shipping.packaging.rules.deleted],
    ['save-packaging-defaults', t.shipping.packaging.saveSuccess],
  ];

  for (const [intent, base] of successi) {
    prova(`${intent}: ricalcolo finito, il toast dice che i numeri sono aggiornati`, () => {
      const f = feedbackFromActionData({ intent, success: true, numbers: 'updated' }, t);
      expect(f.toast).toEqual({ content: t.shipping.numbers.updated(base), error: false });
    });

    prova(`${intent}: ricalcolo passato alla coda, il toast dice "a breve"`, () => {
      const f = feedbackFromActionData({ intent, success: true, numbers: 'pending' }, t);
      expect(f.toast).toEqual({ content: t.shipping.numbers.pending(base), error: false });
    });

    prova(`${intent}: niente da ricalcolare, il toast di sempre`, () => {
      expect(feedbackFromActionData({ intent, success: true, numbers: null }, t).toast).toEqual({
        content: base,
        error: false,
      });
      expect(feedbackFromActionData({ intent, success: true }, t).toast).toEqual({ content: base, error: false });
    });
  }

  prova('i due testi sono diversi, e ognuno nomina Dashboard e Clienti', () => {
    const aggiornati = t.shipping.numbers.updated('Salvato');
    const aBreve = t.shipping.numbers.pending('Salvato');
    expect(aggiornati).not.toBe(aBreve);
    for (const testo of [aggiornati, aBreve]) {
      expect(testo).toContain('Salvato');
      expect(testo).toContain('Dashboard');
      expect(testo).toContain('Clienti');
    }
  });

  prova('in inglese le stesse chiavi, con il loro testo', () => {
    const aggiornati = inglese.shipping.numbers.updated('Saved');
    const aBreve = inglese.shipping.numbers.pending('Saved');
    expect(aggiornati).toContain('Saved');
    expect(aggiornati).toContain('Customers');
    expect(aBreve).toContain('Customers');
    expect(aggiornati).not.toBe(aBreve);
    const f = feedbackFromActionData({ intent: 'save-option-cost', success: true, numbers: 'updated' }, inglese);
    expect(f.toast?.content).toBe(inglese.shipping.numbers.updated(inglese.shipping.optionModal.saveSuccess));
  });

  prova('un errore non parla mai dei numeri', () => {
    const f = feedbackFromActionData(
      { intent: 'save-zone-rates', success: false, error: 'invalid_request', numbers: 'updated' },
      t,
    );
    expect(f.toast).toEqual({ content: t.shipping.modal.saveError, error: true });
  });
});
