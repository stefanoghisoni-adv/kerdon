// app/lib/shipping/packaging-store.server.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: { packagingConfig: { findUnique, upsert } },
}));

const { readPackaging, writePackaging } = await import('./packaging-store.server');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readPackaging', () => {
  it('senza configurazione: niente categorie e niente regole', async () => {
    findUnique.mockResolvedValue(null);
    expect(await readPackaging('shop-1')).toEqual({ categories: [], rules: [] });
  });

  it('regole fuori ordine: le modifiche partono dall ordine in cui si applicano', async () => {
    findUnique.mockResolvedValue({
      categories: [{ name: 'A', cost: 1 }],
      fallbackRules: [
        { weightMaxKg: 5, category: 'A' },
        { weightMaxKg: 1, category: 'B' },
        { weightMaxKg: null, category: 'C' },
      ],
    });

    const letto = await readPackaging('shop-1');

    expect(letto.categories).toEqual([{ name: 'A', cost: 1, origin: 'manual' }]);
    expect(letto.rules).toEqual([
      { weightMaxKg: 1, category: 'B' },
      { weightMaxKg: 5, category: 'A' },
      { weightMaxKg: null, category: 'C' },
    ]);
  });
});

describe('writePackaging', () => {
  it('scrive solo categorie e regole', async () => {
    upsert.mockResolvedValue({});
    await writePackaging('shop-1', { categories: [{ name: 'A', cost: 1, origin: 'manual' }], rules: [] });
    const data = { categories: [{ name: 'A', cost: 1, origin: 'manual' }], fallbackRules: [] };
    expect(upsert).toHaveBeenCalledWith({
      where: { shopId: 'shop-1' },
      create: { shopId: 'shop-1', ...data },
      update: data,
    });
  });
});
