// app/lib/shipping/logistics-cost.ts
import type { FallbackRule, LogisticsConfig, OrderLogisticsInput, ShippingOptionConfig, ZoneConfig } from './types';

const SPEDITO = new Set(['FULFILLED', 'PARTIALLY_FULFILLED']);

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
 * Ritorna null se il metodo e' null o se nessuna opzione combacia.
 */
export function findOption(zone: ZoneConfig, method: string | null): ShippingOptionConfig | null {
  if (!method) return null;
  const normalized = method.trim().toLowerCase();
  return zone.options.find((opt) => opt.name.trim().toLowerCase() === normalized) ?? null;
}

function shippingFor(zone: ZoneConfig, weightKg: number): number {
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
): number {
  if (option.costType === 'flat') {
    return option.brackets[0]?.cost ?? 0;
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
      const option = findOption(zone, order.shipping_method);
      if (option) {
        shipping = centesimi(shippingForOption(option, weightKg, order.total_price));
      } else if (weightKg != null) {
        shipping = centesimi(shippingFor(zone, weightKg));
      }
    }

    const categoria = resolvePackagingCategory(order.packaging_category, weightKg, config.fallbackRules);
    packaging = config.categories.find((c) => c.name === categoria)?.cost ?? 0;
  }

  const returns = order.returned_at ? (config.returnCost ?? 0) : 0;

  return { shipping, packaging, returns, total: centesimi(shipping + packaging + returns) };
}
