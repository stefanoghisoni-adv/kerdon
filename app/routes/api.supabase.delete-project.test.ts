import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const listProjects = vi.fn();
const deleteProject = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'test-shop.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: { shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) } },
}));
vi.mock('~/lib/supabase-oauth.server', () => ({
  getValidAccessToken: async () => 'token',
}));
vi.mock('~/lib/supabase-management.server', () => ({
  listProjects: (...a: unknown[]) => listProjects(...a),
  deleteProject: (...a: unknown[]) => deleteProject(...a),
}));

import { action } from './api.supabase.delete-project';

const SHOP = {
  id: 'shop-1',
  shopDomain: 'test-shop.myshopify.com',
  authorization: 'ENABLED',
  locale: 'it',
  detectedLocale: null,
  supabaseConfig: { supabaseProjectRef: 'collegato' },
};

function call(refs: string[], method = 'POST') {
  const request = new Request('https://app.example.com/api/supabase/delete-project', {
    method,
    body: method === 'POST' ? JSON.stringify({ refs }) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
  return action({ request, params: {}, context: {} } as never);
}

describe('/api/supabase/delete-project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueShop.mockResolvedValue({ ...SHOP });
    listProjects.mockResolvedValue([
      { id: 'collegato', name: 'In uso' },
      { id: 'altro', name: 'Vecchio' },
    ]);
    deleteProject.mockResolvedValue(undefined);
  });

  it('elimina un database che non e in uso', async () => {
    const res = await call(['altro']);

    expect(await res.json()).toEqual({ ok: true });
    expect(deleteProject).toHaveBeenCalledWith('token', 'altro');
  });

  it('il database collegato ferma tutta la richiesta', async () => {
    // E' quello su cui l'app sta scrivendo: cancellarlo porterebbe via i dati
    // sincronizzati, e da li' non si torna indietro. Con altri in elenco non se
    // ne elimina meta': si ferma tutto.
    const res = await call(['collegato', 'altro']);

    expect(res.status).toBe(400);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('un progetto che non e suo non si tocca', async () => {
    // Il ref arriva dal browser: che appartenga a questo account lo dice
    // Supabase, non la richiesta.
    const res = await call(['di-qualcun-altro']);

    expect(res.status).toBe(404);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  // Scollegarsi e farsi eliminare i dati sono le vie d'uscita, e restano aperte
  // anche a chi non paga piu': condizionare la cancellazione all'avere un
  // abbonamento attivo e' cio' che il GDPR non ammette. Prima qui c'era un 403,
  // e chi non pagava restava chiuso dentro con i suoi dati ancora da noi.
  it('anche a negozio sospeso si elimina: e la via d uscita', async () => {
    findUniqueShop.mockResolvedValue({ ...SHOP, authorization: 'DISABLED' });

    const res = await call(['altro']);

    expect(res.status).toBe(200);
    expect(deleteProject).toHaveBeenCalled();
  });

  it('senza niente selezionato non si fa niente', async () => {
    const res = await call([]);

    expect(res.status).toBe(400);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('metodo diverso da POST → 405', async () => {
    const res = await call(['altro'], 'GET');

    expect(res.status).toBe(405);
    expect(deleteProject).not.toHaveBeenCalled();
  });
});

describe('piu di un database insieme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueShop.mockResolvedValue({ ...SHOP });
    listProjects.mockResolvedValue([
      { id: 'collegato', name: 'In uso' },
      { id: 'uno', name: 'Uno' },
      { id: 'due', name: 'Due' },
    ]);
    deleteProject.mockResolvedValue(undefined);
  });

  it('li elimina tutti', async () => {
    const res = await call(['uno', 'due']);

    expect(await res.json()).toEqual({ ok: true });
    expect(deleteProject.mock.calls.map((c) => c[1])).toEqual(['uno', 'due']);
  });

  it('lo stesso indicato due volte si elimina una volta sola', async () => {
    await call(['uno', 'uno']);

    expect(deleteProject).toHaveBeenCalledTimes(1);
  });
});
