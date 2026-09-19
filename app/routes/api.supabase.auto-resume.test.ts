// app/routes/api.supabase.auto-resume.test.ts
//
// L'interruttore con cui il merchant dice se l'app debba riaccendere da sola il
// suo database. Quel che conta qui e' il verso dell'incertezza: qualunque cosa
// non si capisca deve finire in "no, non toccarlo".
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const setAutoResumeEnabled = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'negozio.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: { shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) } },
}));
vi.mock('~/lib/supabase/auto-resume-setting.server', () => ({
  setAutoResumeEnabled: (...a: unknown[]) => setAutoResumeEnabled(...a),
}));

import { action } from './api.supabase.auto-resume';

const premi = (valore: string) => {
  const body = new URLSearchParams({ enabled: valore });
  return action({
    request: new Request('https://app/api/supabase/auto-resume', { method: 'post', body }),
    params: {},
    context: {},
  } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueShop.mockResolvedValue({ id: 'shop-1' });
  setAutoResumeEnabled.mockResolvedValue(true);
});

describe('la scelta del merchant', () => {
  it('accesa si salva accesa', async () => {
    const res = await premi('true');

    expect(setAutoResumeEnabled).toHaveBeenCalledWith('shop-1', true);
    expect(await res.json()).toEqual({ ok: true, enabled: true });
  });

  it('spenta si salva spenta', async () => {
    await premi('false');

    expect(setAutoResumeEnabled).toHaveBeenCalledWith('shop-1', false);
  });

  it('un valore che non sappiamo leggere non accende mai', async () => {
    // In dubbio si spegne: "non toccare il mio database" e' l'esito che non fa
    // niente a nessuno, e l'altro tocca l'infrastruttura di una persona vera.
    await premi('forse');

    expect(setAutoResumeEnabled).toHaveBeenCalledWith('shop-1', false);
  });
});

describe('quando non c e dove scrivere la scelta', () => {
  it('lo dice, invece di far credere che sia stata presa', async () => {
    setAutoResumeEnabled.mockResolvedValue(false);

    const res = await premi('false');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, code: 'unavailable' });
  });
});
