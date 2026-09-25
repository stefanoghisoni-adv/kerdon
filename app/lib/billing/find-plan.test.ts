import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/db.server', () => ({
  prisma: {
    plan: { findFirst: vi.fn(), findMany: vi.fn() },
    planPrice: { findMany: vi.fn() },
  },
}));

import {
  findPlanByName,
  findPlanForSubscription,
  findFreePlan,
  freePlanName,
  initialPlan,
} from './find-plan.server';
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
    listino([{ planName: 'Basic' }, { planName: 'Growth' }], [free('Basic'), paid('Growth')]);

    expect(await findFreePlan()).toEqual({ planName: 'Basic' });
    expect(prisma.planPrice.findMany).toHaveBeenCalledWith({ where: { currency: 'USD' } });
  });

  it('il prezzo non sta piu sul piano: un piano a pagamento non e un ripiego', async () => {
    listino([{ planName: 'Growth' }], [paid('Growth')]);
    expect(await findFreePlan()).toBeNull();
  });

  it('salta i piani interni, che costano zero ma non sono un ripiego', async () => {
    // Lifetime e' a prezzo zero come Basic. Se la cancellazione di un
    // abbonamento ci finisse sopra, il merchant si ritroverebbe gratis un piano
    // senza limiti: e' un regalo, non una retrocessione.
    listino(
      [{ planName: 'Lifetime' }, { planName: 'Basic' }],
      [free('Lifetime'), free('Basic')],
    );

    expect(await findFreePlan()).toEqual({ planName: 'Basic' });
  });

  it('nessun piano gratuito acquistabile → null', async () => {
    listino([{ planName: 'Lifetime' }], [free('Lifetime')]);
    expect(await findFreePlan()).toBeNull();
  });

  it('un piano senza riga a listino conta come gratuito', async () => {
    // Non e' indulgenza: darlo per pagante bloccherebbe l'installazione di chi
    // sta atterrando sul piano d'ingresso, che e' il momento peggiore per
    // fermarsi. Un prezzo mancante e' un problema di listino, non del merchant.
    listino([{ planName: 'Basic' }], []);
    expect(await findFreePlan()).toEqual({ planName: 'Basic' });
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

    expect(await freePlanName()).toBe('Basic');
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

    expect(await initialPlan()).toEqual({ planName: 'Basic', trialDays: 0 });
    errorSpy.mockRestore();
  });
});

describe('findPlanByName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.plan.findFirst as any).mockResolvedValue({ planName: 'Growth' });
  });

  it('cerca senza distinguere maiuscole e minuscole', async () => {
    const plan = await findPlanByName('growth');

    expect(prisma.plan.findFirst).toHaveBeenCalledWith({
      where: { planName: { equals: 'growth', mode: 'insensitive' } },
    });
    expect(plan).toEqual({ planName: 'Growth' });
  });

  it('toglie gli spazi ai bordi', async () => {
    await findPlanByName('  Scale  ');

    expect(prisma.plan.findFirst).toHaveBeenCalledWith({
      where: { planName: { equals: 'Scale', mode: 'insensitive' } },
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

  it('nome di prima non piu in listino → il piano che ne ha preso il posto', async () => {
    (prisma.plan.findFirst as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ planName: 'Growth' });

    expect(await findPlanByName('Pro')).toEqual({ planName: 'Growth' });
    expect(prisma.plan.findFirst).toHaveBeenLastCalledWith({
      where: { planName: { equals: 'Growth', mode: 'insensitive' } },
    });
  });

  it('nome sconosciuto senza successore → una sola ricerca', async () => {
    (prisma.plan.findFirst as any).mockResolvedValue(null);
    expect(await findPlanByName('Agenzia')).toBeNull();
    expect(prisma.plan.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('findPlanForSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.plan.findFirst as any).mockResolvedValue({ planName: 'x' });
  });

  it.each([
    ['Core', 29, 'Growth'],
    ['Core', 149, 'Core'],
    ['Core', null, 'Core'],
    ['Scale', 1490, 'Core'],
    ['Pro', 19, 'Growth'],
  ])('abbonamento "%s" a %s → cerca %s', async (nome, importo, cercato) => {
    await findPlanForSubscription(nome, importo);
    expect(prisma.plan.findFirst).toHaveBeenCalledWith({
      where: { planName: { equals: cercato, mode: 'insensitive' } },
    });
  });
});
