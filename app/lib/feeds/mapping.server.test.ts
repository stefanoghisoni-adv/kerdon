import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/db.server', () => ({
  prisma: {
    feedFieldMapping: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { loadMapping, saveField, variablesOf, RECENT_LIMIT } from './mapping.server';
import { defaultMapping } from './gmc';
import { prisma } from '~/db.server';

const rows = (value: unknown[]) => (prisma.feedFieldMapping.findMany as any).mockResolvedValue(value);
const saved = (value: unknown) =>
  (prisma.feedFieldMapping.findUnique as any).mockResolvedValue(value);

describe('loadMapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('un campo mai toccato torna con il suggerimento', async () => {
    // Nessuna riga sul database: aggiungere un campo nuovo al feed non deve
    // richiedere di scrivere righe per tutti i negozi che esistono.
    rows([]);
    const mapping = await loadMapping('shop-1', 'google');

    expect(mapping.title.variable).toBe(defaultMapping().title);
    expect(mapping.title.recent).toEqual([]);
  });

  it('copre ogni campo del feed, anche con il database vuoto', async () => {
    rows([]);
    const mapping = await loadMapping('shop-1', 'google');
    for (const field of Object.keys(defaultMapping())) {
      expect(mapping[field]).toBeDefined();
    }
  });

  it('la scelta salvata vince sul suggerimento', async () => {
    rows([{ field: 'gtin', variable: 'sku', recent: ['barcode'] }]);
    const mapping = await loadMapping('shop-1', 'google');

    expect(mapping.gtin.variable).toBe('sku');
    expect(mapping.gtin.recent).toEqual(['barcode']);
  });

  it('una variabile che non esiste piu ricade sul suggerimento', async () => {
    // Meglio un campo che funziona di uno che punta nel vuoto: un valore
    // sconosciuto produrrebbe una colonna vuota nel file, e Google la legge
    // come un campo mancante.
    rows([{ field: 'brand', variable: 'colonna_sparita', recent: ['anche_questa'] }]);
    const mapping = await loadMapping('shop-1', 'google');

    expect(mapping.brand.variable).toBe(defaultMapping().brand);
    expect(mapping.brand.recent).toEqual([]);
  });
});

describe('variablesOf', () => {
  it('lascia solo le variabili, come le vuole il generatore', async () => {
    (prisma.feedFieldMapping.findMany as any).mockResolvedValue([
      { field: 'gtin', variable: 'sku', recent: [] },
    ]);
    const variables = variablesOf(await loadMapping('shop-1', 'google'));

    expect(variables.gtin).toBe('sku');
    expect(typeof variables.title).toBe('string');
  });
});

describe('saveField', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const upsertArgs = () => (prisma.feedFieldMapping.upsert as any).mock.calls[0][0];

  it('la variabile che si lascia entra fra le recenti', async () => {
    saved({ variable: 'barcode', recent: [] });
    await saveField('shop-1', 'google', 'gtin', 'sku');

    expect(upsertArgs().update).toEqual({ variable: 'sku', recent: ['barcode'] });
  });

  it('quella appena scelta non entra fra le recenti', async () => {
    // E' gia' in cima come scelta corrente: averla due volte nella stessa
    // tendina la farebbe sembrare due opzioni diverse.
    saved({ variable: 'barcode', recent: ['sku', 'handle'] });
    await saveField('shop-1', 'google', 'gtin', 'sku');

    expect(upsertArgs().update.recent).toEqual(['barcode', 'handle']);
  });

  it('nessun doppione fra le recenti', async () => {
    saved({ variable: 'barcode', recent: ['handle', 'barcode', 'handle'] });
    await saveField('shop-1', 'google', 'gtin', 'sku');

    expect(upsertArgs().update.recent).toEqual(['barcode', 'handle']);
  });

  it('riscegliere la stessa variabile non sporca le recenti', async () => {
    saved({ variable: 'sku', recent: ['barcode'] });
    await saveField('shop-1', 'google', 'gtin', 'sku');

    expect(upsertArgs().update).toEqual({ variable: 'sku', recent: ['barcode'] });
  });

  it('si tengono al massimo cinque scelte', async () => {
    saved({ variable: 'barcode', recent: ['a', 'b', 'c', 'd', 'e', 'f'] });
    await saveField('shop-1', 'google', 'gtin', 'sku');

    expect(upsertArgs().update.recent).toHaveLength(RECENT_LIMIT);
    expect(upsertArgs().update.recent[0]).toBe('barcode');
  });

  it('primo salvataggio su un campo: nessuna recente da ricordare', async () => {
    saved(null);
    await saveField('shop-1', 'google', 'gtin', 'sku');

    expect(upsertArgs().create).toEqual({
      shopId: 'shop-1',
      platform: 'google',
      field: 'gtin',
      variable: 'sku',
      recent: [],
    });
  });

  it('le recenti sono per campo, non per negozio', async () => {
    // Le variabili che si provano su `gtin` non sono quelle che si provano su
    // `title`: la riga si cerca sulla terna negozio+piattaforma+campo.
    saved({ variable: 'barcode', recent: [] });
    await saveField('shop-1', 'google', 'gtin', 'sku');

    expect((prisma.feedFieldMapping.findUnique as any).mock.calls[0][0].where).toEqual({
      shopId_platform_field: { shopId: 'shop-1', platform: 'google', field: 'gtin' },
    });
  });
});
