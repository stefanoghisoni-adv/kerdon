// app/lib/shipping/logistics-cost.ts
import type { FallbackRule, LogisticsConfig, OrderLogisticsInput, ZoneConfig } from './types';

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

export function findZone(zones: ZoneConfig[], country: string | null): ZoneConfig | null {
  if (country) {
    const esplicita = zones.find((z) => z.countries.includes(country));
    if (esplicita) return esplicita;
  }
  return zones.find((z) => z.restOfWorld) ?? null;
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

export function computeLogisticsCost(
  order: OrderLogisticsInput,
  config: LogisticsConfig | null,
): { shipping: number; packaging: number; returns: number; total: number } {
  if (!config) return { shipping: 0, packaging: 0, returns: 0, total: 0 };

  let shipping = 0;
  let packaging = 0;

  // Un ordine mai partito non ha pagato ne' corriere ne' scatola.
  if (isShipped(order.fulfillment_status)) {
    const weightKg = resolveWeightKg(order, config.defaultWeightPerItemKg);
    const zone = findZone(config.zones, order.shipping_country_code);
    if (zone && weightKg != null) shipping = centesimi(shippingFor(zone, weightKg));

    const categoria = resolvePackagingCategory(order.packaging_category, weightKg, config.fallbackRules);
    packaging = config.categories.find((c) => c.name === categoria)?.cost ?? 0;
  }

  const returns = order.returned_at ? (config.returnCost ?? 0) : 0;

  return { shipping, packaging, returns, total: centesimi(shipping + packaging + returns) };
}
