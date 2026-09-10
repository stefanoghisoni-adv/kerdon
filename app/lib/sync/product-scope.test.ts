import { describe, it, expect } from 'vitest';
import {
  createScopeSelector,
  decideProductScope,
  scopeCounts,
  sweepVerdict,
  type ScopeCandidate,
} from './product-scope';

const p = (productId: number, createdAt?: string | null): ScopeCandidate => ({
  productId,
  createdAt: createdAt ?? null,
});

describe('la scelta di chi resta dentro l ambito', () => {
  it('senza tetto sono dentro tutti, e non c e nessuna eccedenza', () => {
    const esito = decideProductScope([p(3), p(1), p(2)], null);
    expect(esito.inScope.map((c) => c.productId)).toEqual([1, 2, 3]);
    expect(esito.outOfQuota).toEqual([]);
  });

  it('col tetto restano i piu vecchi, e gli altri sono eccedenza', () => {
    const esito = decideProductScope(
      [
        p(10, '2024-05-01T00:00:00Z'),
        p(11, '2023-01-01T00:00:00Z'),
        p(12, '2025-01-01T00:00:00Z'),
      ],
      2,
    );
    expect(esito.inScope.map((c) => c.productId)).toEqual([11, 10]);
    expect(esito.outOfQuota.map((c) => c.productId)).toEqual([12]);
  });

  // IL REQUISITO CHE TUTTO IL RESTO POGGIA SU DI LUI. Se l'ambito cambiasse con
  // l'ordine delle pagine, a ogni corsa qualche prodotto entrerebbe e
  // qualcun altro si fermerebbe — e il merchant vedrebbe i suoi dati ballare
  // senza aver toccato niente.
  it('l ordine in cui arrivano le pagine non cambia chi resta dentro', () => {
    const catalogo = [
      p(5, '2024-03-01T00:00:00Z'),
      p(1, '2024-01-01T00:00:00Z'),
      p(9, '2024-02-01T00:00:00Z'),
      p(7, '2024-04-01T00:00:00Z'),
      p(3, '2024-05-01T00:00:00Z'),
    ];

    const dritto = decideProductScope(catalogo, 3);
    const rovescio = decideProductScope([...catalogo].reverse(), 3);
    const mescolato = decideProductScope(
      [catalogo[2], catalogo[4], catalogo[0], catalogo[3], catalogo[1]],
      3,
    );

    expect(dritto.inScope.map((c) => c.productId)).toEqual([1, 9, 5]);
    expect(rovescio.inScope).toEqual(dritto.inScope);
    expect(mescolato.inScope).toEqual(dritto.inScope);
  });

  it('la stessa risorsa vista due volte non consuma due posti', () => {
    const esito = decideProductScope([p(1, '2024-01-01'), p(1, '2024-01-01'), p(2, '2024-02-01')], 2);
    expect(esito.inScope.map((c) => c.productId)).toEqual([1, 2]);
    expect(esito.outOfQuota).toEqual([]);
  });

  it('senza data di creazione decide l id, che su Shopify cresce col tempo', () => {
    const esito = decideProductScope([p(30), p(10), p(20)], 2);
    expect(esito.inScope.map((c) => c.productId)).toEqual([10, 20]);
  });
});

describe('il selettore, mentre le pagine passano', () => {
  it('senza tetto ammette tutti e non scarta nessuno', () => {
    const s = createScopeSelector(null);
    expect(s.offer(p(1)).admitted).toBe(true);
    expect(s.offer(p(2)).admitted).toBe(true);
    expect(s.displaced()).toEqual([]);
    expect(s.remaining()).toBeNull();
  });

  it('a quota piena i nuovi piu recenti restano fuori', () => {
    const s = createScopeSelector(2);
    expect(s.offer(p(1, '2024-01-01')).admitted).toBe(true);
    expect(s.offer(p(2, '2024-02-01')).admitted).toBe(true);
    expect(s.remaining()).toBe(0);

    const terzo = s.offer(p(3, '2024-03-01'));
    expect(terzo.admitted).toBe(false);
    // Non ha scalzato nessuno: non e' mai entrato.
    expect(terzo.displaced).toBeNull();
    expect(s.displaced().map((c) => c.productId)).toEqual([3]);
  });

  it('un prodotto piu vecchio che arriva tardi prende il posto del piu recente', () => {
    const s = createScopeSelector(2);
    s.offer(p(5, '2024-05-01'));
    s.offer(p(6, '2024-06-01'));

    const vecchio = s.offer(p(1, '2024-01-01'));
    expect(vecchio.admitted).toBe(true);
    expect(vecchio.displaced?.productId).toBe(6);
    expect(s.chosen().map((c) => c.productId)).toEqual([1, 5]);
  });

  // Stessa proprieta' di `decideProductScope`, ma vista pagina per pagina: e' su
  // questa che poggia la scelta di scrivere mentre si impagina invece di tenere
  // in memoria un catalogo intero.
  it('offerti in qualunque ordine, i prescelti sono sempre gli stessi', () => {
    const catalogo = [
      p(5, '2024-03-01'),
      p(1, '2024-01-01'),
      p(9, '2024-02-01'),
      p(7, '2024-04-01'),
      p(3, '2024-05-01'),
    ];

    const dritto = createScopeSelector(3);
    for (const c of catalogo) dritto.offer(c);

    const rovescio = createScopeSelector(3);
    for (const c of [...catalogo].reverse()) rovescio.offer(c);

    expect(dritto.chosen().map((c) => c.productId)).toEqual([1, 9, 5]);
    expect(rovescio.chosen().map((c) => c.productId)).toEqual([1, 9, 5]);
  });

  it('il seme occupa i posti: chi e gia dentro ci resta', () => {
    const s = createScopeSelector(2, [p(1, '2024-01-01'), p(2, '2024-02-01')]);
    expect(s.remaining()).toBe(0);
    // Un aggiornamento a chi e' gia' dentro passa sempre.
    expect(s.offer(p(1, '2024-01-01')).admitted).toBe(true);
    expect(s.offer(p(99, '2024-09-01')).admitted).toBe(false);
  });

  it('tetto a zero: nessuno entra, e nessuno viene scalzato', () => {
    const s = createScopeSelector(0);
    const esito = s.offer(p(1));
    expect(esito.admitted).toBe(false);
    expect(esito.displaced).toBeNull();
    expect(s.displaced().map((c) => c.productId)).toEqual([1]);
  });
});

describe('quando si puo spazzare', () => {
  it('impaginazione finita e varianti complete: si puo', () => {
    expect(sweepVerdict({ paginationComplete: true, productsWithIncompleteVariants: 0 })).toEqual({
      allowed: true,
    });
  });

  // E' il guasto da cui nasce tutto: fermarsi al tetto del piano veniva
  // scambiato per "il catalogo e' finito", e la spazzata portava via cio' che
  // stava oltre.
  it('impaginazione non finita: non si spazza, nemmeno con le varianti a posto', () => {
    expect(sweepVerdict({ paginationComplete: false, productsWithIncompleteVariants: 0 })).toEqual({
      allowed: false,
      reason: 'pagination_incomplete',
    });
  });

  it('un solo elenco di varianti monco basta a fermarla', () => {
    expect(sweepVerdict({ paginationComplete: true, productsWithIncompleteVariants: 1 })).toEqual({
      allowed: false,
      reason: 'variants_incomplete',
    });
  });
});

describe('i conti che l interfaccia mostra', () => {
  it('separa le attive dalle ferme e dice da quando', () => {
    const conti = scopeCounts([
      { productId: 1, inScope: true },
      { productId: 2, inScope: true },
      { productId: 3, inScope: false, lastInScopeAt: '2026-01-10T00:00:00Z' },
      { productId: 4, inScope: false, lastInScopeAt: '2026-03-20T00:00:00Z' },
    ]);

    expect(conti.active).toBe(2);
    expect(conti.paused).toBe(2);
    // La piu' recente fra le ferme: da li' in poi non e' cambiato piu' niente.
    expect(conti.pausedDataFrom?.toISOString()).toBe('2026-03-20T00:00:00.000Z');
  });

  it('niente di fermo: nessuna data da mostrare', () => {
    const conti = scopeCounts([{ productId: 1, inScope: true }]);
    expect(conti).toEqual({ active: 1, paused: 0, pausedDataFrom: null });
  });

  it('una data illeggibile non diventa una data inventata', () => {
    const conti = scopeCounts([{ productId: 1, inScope: false, lastInScopeAt: 'non-una-data' }]);
    expect(conti.paused).toBe(1);
    expect(conti.pausedDataFrom).toBeNull();
  });
});
