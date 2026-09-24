// app/lib/shipping/types.ts
export type RateType = 'linear' | 'brackets';

export interface RateBracket {
  weightFromKg: number | null;
  weightToKg: number | null;
  cost: number;
}

export type OptionCostType = 'flat' | 'linear' | 'weight_brackets' | 'value_brackets';

export interface OptionBracket {
  from: number | null;
  to: number | null;
  cost: number;
}

export interface ShippingOptionConfig {
  name: string;
  costType: OptionCostType;
  brackets: OptionBracket[];
}

export interface ZoneConfig {
  zoneName: string;
  countries: string[];
  restOfWorld: boolean;
  rateType: RateType;
  rates: RateBracket[];
  options: ShippingOptionConfig[];
}

/**
 * Da dove arriva una categoria di imballo: creata dal merchant o portata da
 * Shopify. Serve solo a mostrarla; il costo si calcola uguale.
 */
export type CategoryOrigin = 'shopify' | 'manual';

/** `origin` assente = 'manual' (le categorie salvate prima che esistesse). */
export interface PackagingCategory { name: string; cost: number; origin?: CategoryOrigin }
/** `weightMaxKg` null = regola "tutto il resto". Si applica la prima che combacia. */
export interface FallbackRule { weightMaxKg: number | null; category: string }

export interface LogisticsConfig {
  zones: ZoneConfig[];
  categories: PackagingCategory[];
  fallbackRules: FallbackRule[];
  defaultWeightPerItemKg: number | null;
  returnCost: number | null;
}

/** I campi dell'ordine che servono al costo, come stanno su `orders`. */
export interface OrderLogisticsInput {
  fulfillment_status: string | null;
  shipping_country_code: string | null;
  total_weight_grams: number | null;
  item_count: number | null;
  returned_at: string | null;
  packaging_category: string | null;
  shipping_method: string | null;
  total_price: number | null;
}
