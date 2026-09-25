// app/lib/shipping/types.ts
/**
 * `per_package`: costo per pacco spedito, `rates[0].cost` x numero di pacchi.
 * Per chi paga il corriere a collo e non a peso.
 */
export type RateType = 'linear' | 'brackets' | 'per_package';

export interface RateBracket {
  weightFromKg: number | null;
  weightToKg: number | null;
  cost: number;
}

/** `per_package`: come la tariffa di zona omonima, `brackets[0].cost` x pacchi. */
export type OptionCostType = 'flat' | 'linear' | 'weight_brackets' | 'value_brackets' | 'per_package';

export interface OptionBracket {
  from: number | null;
  to: number | null;
  cost: number;
}

export interface ShippingOptionConfig {
  name: string;
  costType: OptionCostType;
  /**
   * false finche' il merchant non salva il costo: l'import propone zeri
   * segnaposto, e fino ad allora gli ordini prendono la tariffa della zona.
   */
  confirmed: boolean;
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
  /**
   * Quante spedizioni partite davvero Shopify ha registrato per l'ordine: un
   * pacco ciascuna. NULL sugli ordini scritti prima dello schema 14 e non
   * ancora recuperati; il calcolo lo legge con `effectivePackageCount`.
   */
  package_count: number | null;
}
