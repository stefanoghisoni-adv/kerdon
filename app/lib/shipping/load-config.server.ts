import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { normalizeOrigin } from './category-origin';
import { sortRules } from './rule-order';
import type {
  LogisticsConfig,
  ZoneConfig,
  PackagingCategory,
  FallbackRule,
  ShippingOptionConfig,
  OptionCostType,
  RateType,
} from './types';

export async function loadLogisticsConfig(shopId: string): Promise<LogisticsConfig | null> {
  try {
    return await loadLogisticsConfigStrict(shopId);
  } catch (error) {
    // Qui arrivano solo i guasti veri (il P2021 lo assorbe gia' la variante
    // severa): si loggano ma non fanno fallire chi legge.
    console.warn('[loadLogisticsConfig] Errore durante il caricamento:', error);
    return null;
  }
}

/**
 * La configurazione, distinguendo "non c'e'" da "non si e' potuta leggere".
 *
 * Serve al ricalcolo in background, dove i due casi portano a scritture
 * opposte: senza tariffe il costo giusto e' zero su tutti gli ordini, mentre
 * con le tariffe illeggibili per un guasto di rete non si deve scrivere niente
 * — altrimenti un singhiozzo del database azzererebbe costi corretti. Quindi:
 * null quando la configurazione manca (anche con le tabelle owner non ancora
 * create, P2021), eccezione per qualunque altro errore. Le sole tabelle delle
 * opzioni mancanti non contano come "configurazione assente": zone e imballo
 * si leggono comunque (vedi readZonesWithOptions).
 */
export async function loadLogisticsConfigStrict(
  shopId: string,
): Promise<LogisticsConfig | null> {
  try {
    const zones = await readZonesWithOptions(shopId);

    // Leggi packaging config
    const packagingConfig = await prisma.packagingConfig.findUnique({
      where: { shopId },
    });

    // Se non esiste nulla, ritorna null
    if (zones.length === 0 && !packagingConfig) {
      return null;
    }

    // Converti zone da Prisma a LogisticsConfig
    const zoneConfigs: ZoneConfig[] = zones.map((zone) => ({
      zoneName: zone.zoneName,
      countries: zone.countries,
      restOfWorld: zone.restOfWorld,
      rateType: zone.rateType as RateType,
      rates: zone.rates.map((rate) => ({
        weightFromKg: rate.weightFrom ? Number(rate.weightFrom) : null,
        weightToKg: rate.weightTo ? Number(rate.weightTo) : null,
        cost: Number(rate.cost),
      })),
      options: convertOptions(zone.options),
    }));

    // Converti packaging config con validazione difensiva
    const categories = validateCategories(packagingConfig?.categories);
    const fallbackRules = validateFallbackRules(packagingConfig?.fallbackRules);

    return {
      zones: zoneConfigs,
      categories,
      fallbackRules,
      defaultWeightPerItemKg: packagingConfig?.defaultWeightPerItem
        ? Number(packagingConfig.defaultWeightPerItem)
        : null,
      returnCost: packagingConfig?.returnCost ? Number(packagingConfig.returnCost) : null,
    };
  } catch (error) {
    // Se la tabella non esiste ancora (P2021), ritorna null senza rumore
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
      return null;
    }

    throw error;
  }
}

/**
 * La tabella o la colonna non c'e' ancora (P2021 / P2022): la finestra fra il
 * rilascio del codice e la migrazione del DB owner, che si lancia a mano.
 */
export function isMissingTableError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2021' || error.code === 'P2022')
  );
}

/**
 * Le zone con tariffe e opzioni; senza opzioni se le loro tabelle mancano.
 *
 * Le opzioni arrivano con una migrazione a parte, lanciata a mano dopo il
 * rilascio. Nel frattempo zone, tariffe e imballo sono dati veri del merchant:
 * se l'assenza delle opzioni facesse fallire tutta la lettura, la
 * configurazione risulterebbe "assente" e il ricalcolo scriverebbe zero su
 * tutti gli ordini. Si rilegge quindi senza opzioni, e ogni ordine prende la
 * tariffa della zona, come prima delle opzioni. Se manca anche la tabella
 * delle zone, la seconda lettura fallisce con lo stesso codice e il chiamante
 * lo tratta come "nessuna configurazione".
 */
async function readZonesWithOptions(shopId: string) {
  try {
    return await prisma.shippingZone.findMany({
      where: { shopId },
      include: {
        rates: true,
        options: {
          include: { rates: true },
        },
      },
    });
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    const zones = await prisma.shippingZone.findMany({
      where: { shopId },
      include: { rates: true },
    });
    return zones.map((zone) => ({ ...zone, options: [] }));
  }
}

/**
 * Valida e filtra le categorie dal JSON, scartando quelle malformate.
 *
 * L'origine si legge a parte e non scarta mai una categoria: le categorie
 * salvate prima che esistesse non ce l'hanno, e valgono 'manual'.
 */
export function validateCategories(json: unknown): PackagingCategory[] {
  if (!Array.isArray(json)) {
    return [];
  }

  return json
    .filter((item): item is PackagingCategory => {
      return (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as any).name === 'string' &&
        typeof (item as any).cost === 'number'
      );
    })
    .map((item) => ({ name: item.name, cost: item.cost, origin: normalizeOrigin(item.origin) }));
}

/**
 * Valida e filtra le fallback rules dal JSON, scartando quelle malformate, e le
 * mette in ordine di peso (vedi rule-order): pagina, modifiche e calcolo le
 * vedono tutti nello stesso ordine.
 */
export function validateFallbackRules(json: unknown): FallbackRule[] {
  if (!Array.isArray(json)) {
    return [];
  }

  return sortRules(json.filter((item): item is FallbackRule => {
    return (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as any).category === 'string' &&
      ((item as any).weightMaxKg === null || typeof (item as any).weightMaxKg === 'number')
    );
  }));
}

/**
 * Converte le opzioni da Prisma a ShippingOptionConfig, scartando quelle con
 * costType sconosciuto.
 */
function convertOptions(
  options: Array<{
    name: string;
    costType: string;
    confirmed: boolean;
    rates: Array<{
      rangeFrom: Prisma.Decimal | null;
      rangeTo: Prisma.Decimal | null;
      cost: Prisma.Decimal;
    }>;
  }>,
): ShippingOptionConfig[] {
  const validTypes: OptionCostType[] = ['flat', 'linear', 'weight_brackets', 'value_brackets', 'per_package'];

  return options
    .filter((option) => {
      if (!validTypes.includes(option.costType as OptionCostType)) {
        console.warn(
          '[loadLogisticsConfig] costType sconosciuto, opzione scartata:',
          option.costType,
          option.name,
        );
        return false;
      }
      return true;
    })
    .map((option) => ({
      name: option.name,
      costType: option.costType as OptionCostType,
      confirmed: option.confirmed === true,
      brackets: option.rates.map((rate) => ({
        from: rate.rangeFrom ? Number(rate.rangeFrom) : null,
        to: rate.rangeTo ? Number(rate.rangeTo) : null,
        cost: Number(rate.cost),
      })),
    }));
}

/**
 * La configurazione per chi scrive ordini: mai un'eccezione.
 *
 * `loadLogisticsConfig` gia' non solleva, ma chi scrive ordini non deve
 * dipendere da questa promessa: un guasto sulle tariffe non puo' far perdere
 * l'ordine, al massimo lo scrive con costo logistico zero — che il ricalcolo
 * in background sistema appena le tariffe tornano leggibili. Si chiama una
 * volta per corsa o per evento, mai per ordine.
 */
export async function loadLogisticsConfigForWrite(shopId: string): Promise<LogisticsConfig | null> {
  try {
    return await loadLogisticsConfig(shopId);
  } catch (error) {
    console.warn(
      `[logistics] configurazione non caricata per lo shop ${shopId}: costo logistico a zero`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
