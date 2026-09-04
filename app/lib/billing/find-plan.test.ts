import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/db.server', () => ({
  prisma: {
    plan: { findFirst: vi.fn(), findMany: vi.fn() },
    planPrice: { findMany: vi.fn() },
  },
}));

import { findPlanByName, findFreePlan, freePlanName, initialPlan } from './find-plan.server';
import { prisma } from '~/db.server';

/** Il listino: i piani da una parte, i prezzi in dollari dall'altra. */
function listino(
  plans: { planName: string; trialDays?: number | null }[],
  prices: { planName: string; priceMonthly: number; priceYearly: number }[],
) {
  (prisma.plan.findMany as any).mockResolvedValue(plans);
  (prisma.planPrice.findMany as any).mockResolvedValue(prices);
}

const free = (planName: string) => ({ planName, priceMonthly: 0, priceYearly: 0 });
const paid = (planName: string) => ({ planName, priceMonthly: 19, priceYearly: 190 });

describe('findFreePlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cerca il piano a prezzo zero nel listino in valuta base', async () => {
    listino([{ planName: 'Free' }, { planName: 'Pro' }], [free('Free'), paid('Pro')]);

    expect(await findFreePlan()).toEqual({ planName: 'Free' });
    expect(prisma.planPrice.findMany).toHaveBeenCalledWith({ where: { currency: 'USD' } });
  });

  it('il prezzo non sta piu sul piano: un piano a pagamento non e un ripiego', async () => {
    listino([{ planName: 'Pro' }], [paid('Pro')]);
    expect(await findFreePlan()).toBeNull();
  });

  it('salta i piani interni, che costano zero ma non sono un ripiego', async () => {
    // Lifetime e' a prezzo zero come Free. Se la cancellazione di un
    // abbonamento ci finisse sopra, il merchant si ritroverebbe gratis un piano
    // senza limiti: e' un regalo, non una retrocessione.
    listino(
      [{ planName: 'Lifetime' }, { planName: 'Free' }],
      [free('Lifetime'), free('Free')],
    );

    expect(await findFreePlan()).toEqual({ planName: 'Free' });
  });

  it('nessun piano gratuito acquistabile → null', async () => {
    listino([{ planName: 'Lifetime' }], [free('Lifetime')]);
    expect(await findFreePlan()).toBeNull();
  });

  it('un piano senza riga a listino conta come gratuito', async () => {
    // Non e' indulgenza: darlo per pagante bloccherebbe l'installazione di chi
    // sta atterrando sul piano d'ingresso, che e' il momento peggiore per
    // fermarsi. Un prezzo mancante e' un problema di listino, non del merchant.
    listino([{ planName: 'Free' }], []);
    expect(await findFreePlan()).toEqual({ planName: 'Free' });
  });
});

describe('freePlanName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restituisce il nome esatto che sta nel listino', async () => {
    listino([{ planName: 'Gratuito' }], [free('Gratuito')]);
    expect(await freePlanName()).toBe('Gratuito');
  });

  it('listino senza piano gratuito → ripiego, ma con un errore nei log', async () => {
    // Non deve far fallire un'installazione. Se il nome di ripiego e' sbagliato
    // ci pensa la foreign key su shops.current_plan a rifiutarlo.
    listino([], []);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await freePlanName()).toBe('Free');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('initialPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("porta i giorni di prova dal listino, dallo stesso sguardo del nome", () => {
    // Il punto di questa funzione: nome e durata escono insieme. Erano due
    // letture diverse — il nome dal listino, i giorni da una costante nel
    // codice — e dicevano cose diverse.
    listino([{ planName: 'Gratuito', trialDays: 14 }], [free('Gratuito')]);
    return expect(initialPlan()).resolves.toEqual({ planName: 'Gratuito', trialDays: 14 });
  });

  it('piano senza prova a listino: zero giorni, non un valore di comodo', async () => {
    listino([{ planName: 'Gratuito', trialDays: null }], [free('Gratuito')]);
    expect(await initialPlan()).toEqual({ planName: 'Gratuito', trialDays: 0 });
  });

  it('listino senza piano gratuito: nessuna prova regalata al ripiego', async () => {
    listino([], []);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await initialPlan()).toEqual({ planName: 'Free', trialDays: 0 });
    errorSpy.mockRestore();
  });
});

describe('findPlanByName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.plan.findFirst as any).mockResolvedValue({ planName: 'Pro' });
  });

  it('cerca senza distinguere maiuscole e minuscole', async () => {
    const plan = await findPlanByName('pro');

    expect(prisma.plan.findFirst).toHaveBeenCalledWith({
      where: { planName: { equals: 'pro', mode: 'insensitive' } },
    });
    expect(plan).toEqual({ planName: 'Pro' });
  });

  it('toglie gli spazi ai bordi', async () => {
    await findPlanByName('  Business  ');

    expect(prisma.plan.findFirst).toHaveBeenCalledWith({
      where: { planName: { equals: 'Business', mode: 'insensitive' } },
    });
  });

  it('nome assente o vuoto → null senza interrogare il database', async () => {
    expect(await findPlanByName(null)).toBeNull();
    expect(await findPlanByName(undefined)).toBeNull();
    expect(await findPlanByName('   ')).toBeNull();
    expect(prisma.plan.findFirst).not.toHaveBeenCalled();
  });

  it('nome fuori dal listino → null', async () => {
    (prisma.plan.findFirst as any).mockResolvedValue(null);
    expect(await findPlanByName('inesistente')).toBeNull();
  });
});
