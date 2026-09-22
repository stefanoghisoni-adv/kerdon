import { isSelectablePlan } from '~/components/Billing/plan-access';
import type { Dictionary } from '~/lib/i18n/context';

// Il nome tecnico del piano (colonna plan_name) non e' adatto alla UI: mappa esplicita.
const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  core: 'Core',
  growth: 'Growth',
  scale: 'Scale',
  lifetime: 'Lifetime',
};

export function planLabel(planName: string | null | undefined): string {
  const key = (planName ?? '').trim().toLowerCase();
  if (!key) return '—';
  if (PLAN_LABELS[key]) return PLAN_LABELS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export interface SyncBadge {
  tone?: 'success';
  content: string;
}

// Badge di una sincronizzazione: verde quando gira, grigio quando non gira. Il
// grigio e' lo stesso dei badge senza tono (es. il piano Lifetime): "non attiva"
// non e' un errore, e' solo una funzione che al momento non e' in uso.
export function syncStatusBadge(
  active: boolean,
  t: Pick<Dictionary, 'common'>,
): SyncBadge {
  return active
    ? { tone: 'success', content: t.common.active }
    : { content: t.common.inactive };
}

export interface PlanOption {
  planName: string;
  priceMonthly: number;
  customersSyncEnabled: boolean;
  productFeedsEnabled?: boolean;
}

/**
 * Piano piu' economico fra quelli che includono la sincronizzazione dei clienti,
 * per invitare all'upgrade chi non ce l'ha. Restituisce il nome tecnico (da
 * passare a planLabel) oppure null se non c'e' nulla da proporre.
 *
 * Fuori restano i piani non acquistabili (lifetime, assegnato dall'owner): non
 * hanno una pagina di acquisto e proporli manderebbe il merchant su una tab che
 * per lui non esiste.
 */
export function firstPlanWithCustomersSync(
  plans: PlanOption[],
  currentPlan: string | null | undefined,
): string | null {
  const current = (currentPlan ?? '').trim().toLowerCase();
  const candidates = plans
    .filter(
      (p) =>
        p.customersSyncEnabled &&
        isSelectablePlan(p.planName) &&
        p.planName.trim().toLowerCase() !== current,
    )
    // A parita' di prezzo l'ordine alfabetico rende il risultato prevedibile.
    .sort((a, b) => a.priceMonthly - b.priceMonthly || a.planName.localeCompare(b.planName));

  return candidates[0]?.planName ?? null;
}

/**
 * Piano piu' economico fra quelli che includono i feed di catalogo.
 *
 * Stessa regola dei clienti, e per la stessa ragione: una riga che dice "non
 * ce l'hai" senza dire come averlo lascia il merchant a cercare da solo in che
 * piano stia quella funzione.
 */
export function firstPlanWithFeeds(
  plans: PlanOption[],
  currentPlan: string | null | undefined,
): string | null {
  const current = (currentPlan ?? '').trim().toLowerCase();
  return (
    plans
      .filter(
        (p) =>
          p.productFeedsEnabled &&
          isSelectablePlan(p.planName) &&
          p.planName.trim().toLowerCase() !== current,
      )
      .sort((a, b) => a.priceMonthly - b.priceMonthly || a.planName.localeCompare(b.planName))[0]
      ?.planName ?? null
  );
}

// Plan.maxSyncFrequencyHours e' un Float: sotto l'ora si legge meglio in minuti,
// sopra le 24 ore (multipli esatti) in giorni ("Ogni 7 giorni" invece di "168 ore").
export function syncFrequencyLabel(
  hours: number | null | undefined,
  t: Pick<Dictionary, 'common' | 'sync'>,
): string {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return t.common.notSet;
  if (hours < 1) return t.sync.every.minutes(Math.round(hours * 60));
  if (hours === 1) return t.sync.every.hour;
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? t.sync.every.day : t.sync.every.days(days);
  }
  const value = Number.isInteger(hours) ? hours : Number(hours.toFixed(1));
  return t.sync.every.hours(value);
}
