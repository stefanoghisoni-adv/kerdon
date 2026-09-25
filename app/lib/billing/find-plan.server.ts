import type { Plan } from '@prisma/client';
import { prisma } from '~/db.server';
import { isSelectablePlan } from '~/components/Billing/plan-access';
import { BASE_CURRENCY } from './money';
import { BASE_PLAN_NAME, resolvePlanName } from './plan-tiers';

// Il nome del piano viaggia in due posti che non si aggiornano insieme: la
// colonna `plans.plan_name` (il listino) e `shops.current_plan` (quello scritto
// sul negozio al momento dell'attivazione). Basta rinominare un piano nel
// listino — anche solo cambiando un'iniziale maiuscola — perche' i due smettano
// di combaciare, e un confronto esatto restituirebbe null.
//
// Un null qui non e' innocuo: chi legge il piano ricade su valori di comodo
// (`maxProducts` assente vale "illimitato", `customersSyncEnabled` vale false),
// quindi un piano non trovato toglie il tetto ai prodotti e spegne la sync dei
// clienti senza dire niente a nessuno. Per questo la ricerca passa sempre di
// qui, insensibile a maiuscole e spazi.

/**
 * Il piano con questo nome, confronto insensibile a maiuscole/minuscole e spazi
 * ai bordi. Null se il nome e' vuoto o non c'e' nel listino.
 *
 * Un nome di prima che nel listino non c'e' piu' ("Pro", "Enterprise") porta al
 * piano che oggi ne ha preso il posto: e' la strada di un link o di un
 * abbonamento nati prima del cambio di nome.
 */
export async function findPlanByName(
  name: string | null | undefined,
): Promise<Plan | null> {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;

  // findFirst e non findUnique: il confronto insensibile a maiuscole richiede
  // `mode: 'insensitive'`, che Prisma accetta solo sulle query non-unique.
  const plan = await prisma.plan.findFirst({
    where: { planName: { equals: trimmed, mode: 'insensitive' } },
  });
  if (plan) return plan;

  const today = resolvePlanName(trimmed);
  if (today.toLowerCase() === trimmed.toLowerCase()) return null;
  return prisma.plan.findFirst({
    where: { planName: { equals: today, mode: 'insensitive' } },
  });
}

/**
 * Il piano di un abbonamento Shopify, dal nome e — se c'e' — dall'importo di
 * listino.
 *
 * Un abbonamento porta il nome con cui e' nato, e i nomi Core/Growth/Scale fra
 * il 23 e il 26 settembre 2026 indicavano lo scaglione sotto: un "Core" da 29 e'
 * il Growth di oggi, non il Core da 149. L'importo lo dice; il nome da solo no.
 */
export async function findPlanForSubscription(
  name: string | null | undefined,
  listPrice?: number | null,
): Promise<Plan | null> {
  return findPlanByName(resolvePlanName(name, listPrice));
}

// Nome da usare se il listino non ha nessun piano gratuito. E' l'ultima
// spiaggia: serve solo a non far fallire un'installazione, e se e' sbagliato la
// foreign key su shops.current_plan lo rifiuta subito invece di lasciar passare
// un negozio con un piano che non esiste.
const FALLBACK_FREE_PLAN_NAME = BASE_PLAN_NAME;

/**
 * Il piano gratuito del listino: quello a prezzo zero, il piu' vecchio se ce
 * n'e' piu' d'uno. Null se non ne esiste nessuno.
 *
 * E' il piano su cui atterra chi installa l'app e quello a cui si torna quando
 * un abbonamento finisce. Va cercato, non scritto a mano: il nome nel listino
 * puo' cambiare, e un nome inventato qui darebbe un negozio senza piano valido.
 */
export async function findFreePlan(): Promise<Plan | null> {
  // Il prezzo non sta piu' sul piano: gratuito e' chi ha zero nel listino in
  // valuta base. Un piano senza riga conta come gratuito — non e' una svista
  // benevola, e' l'unico esito prudente: dare per pagante un piano di cui non
  // si conosce il prezzo bloccherebbe l'installazione invece di completarla.
  const [plans, base] = await Promise.all([
    prisma.plan.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.planPrice.findMany({ where: { currency: BASE_CURRENCY } }),
  ]);

  const priced = new Map(base.map((row) => [row.planName, row]));
  const freeOfCharge = plans.filter((plan) => {
    const row = priced.get(plan.planName);
    return !row || (Number(row.priceMonthly) === 0 && Number(row.priceYearly) === 0);
  });

  // I piani interni assegnati dall'owner (lifetime) costano zero ma non sono un
  // ripiego: finirci per la cancellazione di un abbonamento regalerebbe un
  // piano senza limiti. Il piano gratuito e' quello che un merchant puo'
  // davvero ritrovarsi.
  return freeOfCharge.find((plan) => isSelectablePlan(plan.planName)) ?? null;
}

/** Il nome esatto del piano gratuito, per chi deve solo scriverlo su uno shop. */
export async function freePlanName(): Promise<string> {
  return (await initialPlan()).planName;
}

/** Con che piano e con quanti giorni di prova nasce un negozio nuovo. */
export interface InitialPlan {
  planName: string;
  /** Giorni di prova a listino. 0 = nessuna prova. */
  trialDays: number;
}

/**
 * Il piano di partenza, nome e durata della prova nello STESSO sguardo al
 * listino.
 *
 * Erano due cose lette in due modi: il nome dal listino, i giorni scritti a mano
 * — sette — in chi creava il negozio. Il listino nel frattempo diceva
 * quattordici, quindi ogni negozio nuovo nasceva con una scadenza che non
 * corrispondeva a nessuna promessa fatta: ne' a quella delle card, ne' a quella
 * su cui il codice diceva di basarsi. Due numeri per la stessa cosa sono un
 * numero sbagliato, e non c'e' modo di sapere quale.
 *
 * Zero giorni e' una risposta valida — un piano gratuito che una prova non ce
 * l'ha — e chi scrive la riga la sa distinguere: nessuna prova non e' una prova
 * che scade subito.
 */
export async function initialPlan(): Promise<InitialPlan> {
  const plan = await findFreePlan();
  if (plan) return { planName: plan.planName, trialDays: plan.trialDays ?? 0 };

  console.error(
    `[plans] nessun piano gratuito nel listino: uso "${FALLBACK_FREE_PLAN_NAME}"`,
  );
  // Senza listino non si inventa una prova: il negozio nasce senza, e la
  // foreign key su `shops.current_plan` fermera' comunque l'installazione se
  // anche il nome di ripiego non esiste.
  return { planName: FALLBACK_FREE_PLAN_NAME, trialDays: 0 };
}
