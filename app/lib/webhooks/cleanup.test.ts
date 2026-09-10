import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { afterCleanupFailure } from './cleanup';

/**
 * Quando una pulizia non riesce.
 *
 * La domanda che questo file esiste per fissare e' una sola: quali passi
 * possono proseguire in silenzio. La risposta non e' nuova e non e' di questo
 * modulo — e' la tassonomia dei guasti della corsa periodica — e il punto e'
 * proprio che sia la stessa: la stessa cancellazione mancata non puo' essere
 * grave da una parte e trascurabile dall'altra.
 */

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cosa si puo lasciar passare', () => {
  it('i cosmetici proseguono: si perde un dettaglio, mai un dato del merchant', () => {
    // Sono le tre letture che servono solo a dire "aggiunto" invece di
    // "aggiornato". Le uniche a cui e' concesso proseguire in silenzio.
    expect(afterCleanupFailure('detail.returned-rows', 'prodotto 1', new Error('timeout'))).toBeNull();
    expect(afterCleanupFailure('detail.existing-customers', 'blocco', new Error('timeout'))).toBeNull();
  });

  it('tutto il resto tiene l evento vivo invece di dichiararlo concluso', () => {
    // Era `console.warn` e consegna completata: il lavoro non fatto non
    // restava scritto da nessuna parte, e il webhook non torna una seconda
    // volta a ricordarlo.
    expect(afterCleanupFailure('product.orphan-delete', 'prodotto 1', new Error('denied'))).toBe(
      'retry',
    );
    expect(afterCleanupFailure('customer.consent-revoke', 'cliente 7', new Error('denied'))).toBe(
      'retry',
    );
    expect(afterCleanupFailure('order.stale-lines', 'ordine 5001', new Error('denied'))).toBe(
      'retry',
    );
  });
});

describe('cosa resta scritto', () => {
  it('un passo che tiene l evento vivo si segnala come errore, non come avviso', () => {
    // Un ritentativo silenzioso e' difficile da spiegare quanto un fallimento
    // silenzioso: chi guarda i log deve poter vedere perche' quell'evento
    // continua a ripresentarsi.
    afterCleanupFailure('product.orphan-delete', 'prodotto 42', new Error('permission denied'));

    const scritto = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(scritto).toContain('product.orphan-delete');
    expect(scritto).toContain('prodotto 42');
    expect(scritto).toContain('permission denied');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('un errore di Supabase non e una Error, e il messaggio si legge lo stesso', () => {
    // I guasti del database del merchant arrivano come oggetti con `message`,
    // non come eccezioni: dare `[object Object]` a chi legge il log
    // varrebbe come non scrivere niente.
    afterCleanupFailure('product.orphan-delete', 'prodotto 42', {
      message: 'permission denied for table products',
      code: '42501',
    });

    const scritto = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(scritto).toContain('permission denied for table products');
    expect(scritto).not.toContain('[object Object]');
  });
});
