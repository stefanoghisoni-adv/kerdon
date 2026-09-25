// app/lib/shipping/logistics-cost.ts
import type { FallbackRule, LogisticsConfig, OrderLogisticsInput, ShippingOptionConfig, ZoneConfig } from './types';

/**
 * Gli stati che contano come spedito. Esportati perche' il recupero dello
 * storico li scrive in SQL: la sua idea di "spedito" deve essere questa.
 */
export const SHIPPED_STATUSES = ['FULFILLED', 'PARTIALLY_FULFILLED'] as const;

const SPEDITO = new Set<string>(SHIPPED_STATUSES);

const centesimi = (n: number) => Math.round(n * 100) / 100;

export function isShipped(status: string | null): boolean {
  return status != null && SPEDITO.has(status.toUpperCase());
}

export function resolveWeightKg(order: OrderLogisticsInput, defaultPerItemKg: number | null): number | null {
  if (order.total_weight_grams != null && order.total_weight_grams > 0) {
    return order.total_weight_grams / 1000;
  }
  if (defaultPerItemKg != null && defaultPerItemKg > 0 && order.item_count != null && order.item_count > 0) {
    return defaultPerItemKg * order.item_count;
  }
  return null;
}

export function resolvePackagingCategory(
  fromShopify: string | null,
  weightKg: number | null,
  rules: FallbackRule[],
): string | null {
  if (fromShopify) return fromShopify;
  if (weightKg == null) return null;
  const regola = rules.find((r) => r.weightMaxKg == null || weightKg <= r.weightMaxKg);
  return regola?.category ?? null;
}

/**
 * La zona di un paese; `null` quando il paese non c'e'.
 *
 * Senza paese non si ripiega sul resto del mondo: un ordine senza indirizzo di
 * spedizione (ritiro in negozio, POS, prodotto digitale) non ha preso nessun
 * corriere, e addebitargli la tariffa piu' cara del listino abbasserebbe il
 * profitto di un costo mai pagato.
 */
export function findZone(zones: ZoneConfig[], country: string | null): ZoneConfig | null {
  if (!country) return null;
  const esplicita = zones.find((z) => z.countries.includes(country));
  if (esplicita) return esplicita;
  return zones.find((z) => z.restOfWorld) ?? null;
}

/**
 * Trova l'opzione di spedizione per nome, con confronto case-insensitive e spazi rimossi.
 * Ritorna null se il metodo e' null o vuoto, o se nessuna opzione confermata combacia.
 *
 * Le opzioni non confermate non contano: l'import le crea con costo zero da
 * compilare, e abbinarle farebbe risultare gratuita ogni spedizione con quel
 * nome. Finche' il merchant non salva l'opzione vale la tariffa della zona.
 */
export function findOption(zone: ZoneConfig, method: string | null): ShippingOptionConfig | null {
  if (!method) return null;
  const normalized = method.trim().toLowerCase();
  // Vuoto dopo il trim vale come assente: la stringa vuota e' la sentinella
  // "controllato, nessuna shipping line" del recupero dello storico, e non
  // deve poter abbinare un'opzione dal nome vuoto.
  if (normalized === '') return null;
  return zone.options.find((opt) => opt.confirmed && opt.name.trim().toLowerCase() === normalized) ?? null;
}

/**
 * Quanti pacchi far pagare a un ordine spedito.
 *
 * Il numero viene dalle spedizioni che Shopify ha registrato, ma puo' mancare
 * (ordine scritto prima che lo si leggesse, recupero non ancora passato) o
 * essere zero (evaso con il tracking su un'app esterna, senza una spedizione
 * in Shopify). Chi chiama questa funzione sa gia' che l'ordine e' partito, e
 * un ordine partito ha viaggiato almeno in un pacco: contarne zero lo farebbe
 * risultare spedito gratis. Un valore senza senso (negativo, non finito) vale
 * uno per la stessa ragione; un decimale si tronca, perche' mezzo pacco non
 * esiste e arrotondare per eccesso inventerebbe un costo.
 */
export function effectivePackageCount(packageCount: number | null): number {
  if (packageCount == null || !Number.isFinite(packageCount)) return 1;
  return Math.max(1, Math.trunc(packageCount));
}

/** null quando il tipo ha bisogno del peso e il peso non c'e'. */
function shippingFor(zone: ZoneConfig, weightKg: number | null, packages: number): number | null {
  if (zone.rateType === 'per_package') {
    return (zone.rates[0]?.cost ?? 0) * packages;
  }
  if (weightKg == null) return null;
  if (zone.rateType === 'linear') {
    return (zone.rates[0]?.cost ?? 0) * weightKg;
  }
  const fascia = zone.rates.find(
    (r) => weightKg >= (r.weightFromKg ?? 0) && (r.weightToKg == null || weightKg < r.weightToKg),
  );
  return fascia?.cost ?? 0;
}

function shippingForOption(
  option: ShippingOptionConfig,
  weightKg: number | null,
  totalPrice: number | null,
  packages: number,
): number {
  if (option.costType === 'flat') {
    return option.brackets[0]?.cost ?? 0;
  }

  if (option.costType === 'per_package') {
    return (option.brackets[0]?.cost ?? 0) * packages;
  }

  if (option.costType === 'linear') {
    if (weightKg == null) return 0;
    return (option.brackets[0]?.cost ?? 0) * weightKg;
  }

  if (option.costType === 'weight_brackets') {
    if (weightKg == null) return 0;
    const fascia = option.brackets.find(
      (b) => weightKg >= (b.from ?? 0) && (b.to == null || weightKg < b.to),
    );
    return fascia?.cost ?? 0;
  }

  if (option.costType === 'value_brackets') {
    if (totalPrice == null) return 0;
    const fascia = option.brackets.find(
      (b) => totalPrice >= (b.from ?? 0) && (b.to == null || totalPrice < b.to),
    );
    return fascia?.cost ?? 0;
  }

  return 0;
}

export function computeLogisticsCost(
  order: OrderLogisticsInput,
  config: LogisticsConfig | null,
): { shipping: number; packaging: number; returns: number; total: number } {
  if (!config) return { shipping: 0, packaging: 0, returns: 0, total: 0 };

  let shipping = 0;
  let packaging = 0;

  // Un ordine mai partito non ha pagato ne' corriere ne' scatola. Nemmeno uno
  // evaso senza indirizzo di spedizione: ritiro in negozio, POS e prodotti
  // digitali risultano FULFILLED ma non hanno viaggiato, quindi niente
  // spedizione e niente imballo. Il reso invece resta: se la merce torna
  // indietro, il rientro lo si paga comunque.
  if (isShipped(order.fulfillment_status) && order.shipping_country_code) {
    const weightKg = resolveWeightKg(order, config.defaultWeightPerItemKg);
    const zone = findZone(config.zones, order.shipping_country_code);

    if (zone) {
      // Il numero di pacchi si risolve qui, una volta: il costo per pacco di
      // un'opzione e quello della zona devono contare gli stessi pacchi.
      const packages = effectivePackageCount(order.package_count);
      const option = findOption(zone, order.shipping_method);
      if (option) {
        shipping = centesimi(shippingForOption(option, weightKg, order.total_price, packages));
      } else {
        // Senza peso la tariffa della zona al peso non si applica (null), ma
        // quella per pacco si': il peso non le serve.
        shipping = centesimi(shippingFor(zone, weightKg, packages) ?? 0);
      }
    }

    const categoria = resolvePackagingCategory(order.packaging_category, weightKg, config.fallbackRules);
    packaging = config.categories.find((c) => c.name === categoria)?.cost ?? 0;
  }

  const returns = order.returned_at ? (config.returnCost ?? 0) : 0;

  return { shipping, packaging, returns, total: centesimi(shipping + packaging + returns) };
}
