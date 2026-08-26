import type { Dictionary } from '~/lib/i18n/context';
import type { Locale } from '~/lib/i18n/locales';
import { syncFrequencyLabel } from '~/components/Dashboard/account-format';
import type { PlanFeature } from './plan-catalog';

/**
 * La riga di una funzione del piano, come si legge.
 *
 * Il testo si compone qui e non dove la funzione nasce: le card dei piani si
 * costruiscono anche nei loader, che non sanno in che lingua sta guardando il
 * merchant. Li' resta il dato — il tetto, le ore — e qui diventa una frase.
 */
export function featureLabel(
  feature: PlanFeature,
  t: Pick<Dictionary, 'common' | 'plan' | 'sync'>,
  locale: Locale,
): string {
  switch (feature.key) {
    case 'products':
      return feature.value == null
        ? t.plan.features.productsUnlimited
        : t.plan.features.products(amount(feature.value, locale));
    case 'sync':
      // "Ogni 7 giorni" -> "Sync ogni 7 giorni": la cadenza arriva gia' scritta,
      // con la minuscola perche' entra in mezzo a una frase.
      return t.plan.features.sync(syncFrequencyLabel(feature.value, t).toLowerCase());

    case 'customers':
      if (!feature.included) return t.plan.features.customersSync;
      return feature.value == null
        ? t.plan.features.customersUnlimited
        : t.plan.features.customers(amount(feature.value, locale));
    case 'feeds':
      return t.plan.features.feeds;
    case 'push':
      return t.plan.features.push;
  }
}

/**
 * I numeri lunghi si leggono a colpo d'occhio solo raggruppati: 50.000 in
 * italiano, 50,000 in inglese. Il separatore lo decide la lingua, non noi.
 */
function amount(value: number, locale: Locale): string {
  return value.toLocaleString(locale);
}
