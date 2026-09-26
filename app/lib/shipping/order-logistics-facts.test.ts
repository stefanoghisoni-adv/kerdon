// app/lib/shipping/order-logistics-facts.test.ts
//
// I fatti logistici di un ordine (pacchi, reso, opzione di spedizione) dalla
// forma GraphQL: un solo algoritmo per sincronizzazione, webhook e recupero.

import { describe, it, expect } from 'vitest';
import {
  deriveOrderLogisticsFacts,
  qualifyingReturnAt,
  LOGISTICS_FACTS_FIELDS,
  FULFILLMENTS_FIRST,
  RETURNS_FIRST,
} from './order-logistics-facts';

const base = {
  fulfillments: [],
  returns: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  shippingLines: { nodes: [{ title: 'Express' }] },
};

describe('qualifyingReturnAt: il reso conta solo se OPEN o CLOSED', () => {
  const r = (status: string, createdAt = '2026-08-05T00:00:00Z') => ({ status, createdAt });

  it.each([
    ['REQUESTED', null],
    ['OPEN', '2026-08-05T00:00:00Z'],
    ['CLOSED', '2026-08-05T00:00:00Z'],
    ['DECLINED', null],
    ['CANCELED', null],
  ])('%s', (stato, atteso) => {
    expect(qualifyingReturnAt([r(stato)])).toBe(atteso);
  });

  it('fra piu\' resi validi vince il primo in ordine di tempo, non di elenco', () => {
    expect(
      qualifyingReturnAt([
        r('CLOSED', '2026-08-09T00:00:00Z'),
        r('REQUESTED', '2026-08-01T00:00:00Z'),
        r('OPEN', '2026-08-06T10:00:00Z'),
        r('CANCELED', '2026-08-02T00:00:00Z'),
      ]),
    ).toBe('2026-08-06T10:00:00Z');
  });

  it('un reso OPEN poi annullato sparisce: nessuna data', () => {
    expect(qualifyingReturnAt([r('OPEN')])).toBe('2026-08-05T00:00:00Z');
    expect(qualifyingReturnAt([r('CANCELED')])).toBeNull();
  });

  it('lo stato si confronta senza badare alle maiuscole', () => {
    expect(qualifyingReturnAt([r('open')])).toBe('2026-08-05T00:00:00Z');
  });
});

describe('deriveOrderLogisticsFacts', () => {
  it('pacchi dai tracking, reso qualificante, prima shipping line', () => {
    const fatti = deriveOrderLogisticsFacts({
      ...base,
      fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'A' }, { number: 'B' }, { number: 'C' }] }],
      returns: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ status: 'CLOSED', createdAt: '2026-08-10T00:00:00Z' }] },
    });
    expect(fatti).toEqual({
      packageCount: 3,
      tracked: true,
      returnedAt: '2026-08-10T00:00:00Z',
      shippingMethod: 'Express',
      unknown: [],
    });
  });

  it('piu\' shipping line: decide la prima', () => {
    const fatti = deriveOrderLogisticsFacts({
      ...base,
      shippingLines: { nodes: [{ title: 'Express' }, { title: 'Standard' }] },
    });
    expect(fatti.shippingMethod).toBe('Express');
  });

  it('nessuna shipping line o titolo vuoto: nessuna opzione (dato noto, non oscurato)', () => {
    expect(deriveOrderLogisticsFacts({ ...base, shippingLines: { nodes: [] } })).toMatchObject({ shippingMethod: null, unknown: [] });
    expect(deriveOrderLogisticsFacts({ ...base, shippingLines: { nodes: [{ title: '' }] } })).toMatchObject({ shippingMethod: null, unknown: [] });
  });

  it('il tracking di una spedizione annullata vale ancora come "partito" per lo stato, come prima', () => {
    const fatti = deriveOrderLogisticsFacts({ ...base, fulfillments: [{ status: 'CANCELLED', trackingInfo: [{ number: 'X' }] }] });
    expect(fatti.tracked).toBe(true);
    expect(fatti.packageCount).toBe(0);
  });

  describe('campi oscurati o assenti: sconosciuti, mai zero', () => {
    it('spedizioni nulle (la lista e\' non nulla nello schema): pacchi e tracking sconosciuti', () => {
      const fatti = deriveOrderLogisticsFacts({ ...base, fulfillments: null });
      expect(fatti.packageCount).toBeNull();
      expect(fatti.tracked).toBeNull();
      expect(fatti.unknown).toEqual(['fulfillments']);
    });

    it('trackingInfo nullo su una spedizione partita: pacchi sconosciuti', () => {
      const fatti = deriveOrderLogisticsFacts({ ...base, fulfillments: [{ status: 'SUCCESS', trackingInfo: null }] });
      expect(fatti.packageCount).toBeNull();
      expect(fatti.unknown).toContain('fulfillments');
    });

    it('stato nullo su una spedizione: pacchi sconosciuti (lo stato e\' non nullo nello schema)', () => {
      const fatti = deriveOrderLogisticsFacts({ ...base, fulfillments: [{ status: null, trackingInfo: [] }] });
      expect(fatti.packageCount).toBeNull();
    });

    it('resi nulli, nodi nulli o elenco non completo: reso sconosciuto', () => {
      expect(deriveOrderLogisticsFacts({ ...base, returns: null }).unknown).toEqual(['returns']);
      expect(deriveOrderLogisticsFacts({ ...base, returns: { nodes: null } }).unknown).toEqual(['returns']);
      expect(
        deriveOrderLogisticsFacts({
          ...base,
          returns: { pageInfo: { hasNextPage: true, endCursor: 'c' }, nodes: [{ status: 'CANCELED', createdAt: '2026-08-01T00:00:00Z' }] },
        }).unknown,
      ).toEqual(['returns']);
      // Un reso valido senza data: non si sa quando, quindi non si scrive.
      expect(deriveOrderLogisticsFacts({ ...base, returns: { nodes: [{ status: 'OPEN', createdAt: null }] } }).unknown).toEqual(['returns']);
    });

    it('shipping line nulle o titolo nullo (non nullo nello schema): opzione sconosciuta', () => {
      expect(deriveOrderLogisticsFacts({ ...base, shippingLines: null }).unknown).toEqual(['shippingLines']);
      expect(deriveOrderLogisticsFacts({ ...base, shippingLines: { nodes: [{ title: null }] } }).unknown).toEqual(['shippingLines']);
    });

    it('campi assenti del tutto (query che non li chiede): sconosciuti', () => {
      expect(deriveOrderLogisticsFacts({}).unknown).toEqual(['fulfillments', 'returns', 'shippingLines']);
    });
  });
});

describe('la query dei fatti logistici', () => {
  it('chiede spedizioni con stato e tutti i tracking, resi con pageInfo, e la prima shipping line', () => {
    expect(LOGISTICS_FACTS_FIELDS).toContain(`fulfillments(first: ${FULFILLMENTS_FIRST}) { status trackingInfo { number } }`);
    expect(LOGISTICS_FACTS_FIELDS).toContain(
      `returns(first: ${RETURNS_FIRST}) { pageInfo { hasNextPage endCursor } nodes { status createdAt } }`,
    );
    expect(LOGISTICS_FACTS_FIELDS).toContain('shippingLines(first: 1) { nodes { title } }');
  });
});
