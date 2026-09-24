import { prisma } from '~/db.server';
import type { OptionCostType } from './types';

// Forma verificata sull'Admin API 2026-07 (validatore shopify-dev):
// DeliveryLocationGroupZone.methodDefinitions e' una connection;
// rateProvider e' l'unione DeliveryRateDefinition | DeliveryParticipant;
// methodConditions { field operator conditionCriteria: Weight | MoneyV2 }.

type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> }
) => Promise<Response>;

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: GraphqlError[];
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface CountryCode {
  countryCode: string;
  restOfWorld: boolean;
}

interface MethodCondition {
  field: 'TOTAL_WEIGHT' | 'TOTAL_PRICE' | string;
  operator: 'GREATER_THAN_OR_EQUAL_TO' | 'LESS_THAN_OR_EQUAL_TO' | string;
  conditionCriteria:
    | { __typename: 'Weight'; unit: string; value: number }
    | { __typename: 'MoneyV2'; amount: string };
}

interface MethodDefinition {
  name: string;
  active: boolean;
  rateProvider: { __typename: 'DeliveryRateDefinition' | 'DeliveryParticipant' | string };
  methodConditions: MethodCondition[];
}

interface LocationGroupZone {
  zone: { name: string; countries: Array<{ code: CountryCode }> };
  methodDefinitions: { pageInfo: { hasNextPage: boolean }; nodes: MethodDefinition[] };
}

interface ProfilesData {
  deliveryProfiles: {
    pageInfo: PageInfo;
    nodes: Array<{ id: string; profileLocationGroups: Array<{ locationGroup: { id: string } }> }>;
  };
}

interface GroupZonesData {
  deliveryProfile: {
    profileLocationGroups: Array<{
      locationGroupZones: { pageInfo: PageInfo; nodes: LocationGroupZone[] };
    }>;
  } | null;
}

// Una sola query con profili, zone e metodi annidati supera il tetto di 1000
// punti di costo per richiesta (20 profili x 100 zone x N metodi). Si legge
// quindi a pagine: prima i profili con i loro gruppi di sedi, poi le zone di
// ogni gruppo 5 alla volta, ognuna con fino a 30 metodi (~800 punti stimati).
const PROFILES_QUERY = `
  query DeliveryProfileGroups($after: String) {
    deliveryProfiles(first: 25, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        profileLocationGroups { locationGroup { id } }
      }
    }
  }
`;

const GROUP_ZONES_QUERY = `
  query DeliveryGroupZones($profileId: ID!, $locationGroupId: ID!, $after: String) {
    deliveryProfile(id: $profileId) {
      profileLocationGroups(locationGroupId: $locationGroupId) {
        locationGroupZones(first: 5, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            zone { name countries { code { countryCode restOfWorld } } }
            methodDefinitions(first: 30) {
              pageInfo { hasNextPage }
              nodes {
                name
                active
                rateProvider {
                  __typename
                  ... on DeliveryRateDefinition { price { amount } }
                  ... on DeliveryParticipant { id }
                }
                methodConditions {
                  field
                  operator
                  conditionCriteria {
                    __typename
                    ... on Weight { unit value }
                    ... on MoneyV2 { amount }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** Guardia contro cursori che non avanzano: nessun negozio reale ci arriva. */
const MAX_PAGES = 200;

async function runQuery<T>(
  graphql: AdminGraphql,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await graphql(query, { variables });
  const json = (await response.json()) as GraphqlResponse<T>;

  // Controlla errori GraphQL (es. scope mancante)
  if (json.errors && json.errors.length > 0) {
    const accessDenied = json.errors.some(
      (e) => e.extensions?.code === 'ACCESS_DENIED' || e.message.includes('Access denied')
    );
    if (accessDenied) {
      throw new Error('Manca lo scope read_shipping');
    }
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }

  if (!json.data) {
    throw new Error('Nessun dato nella risposta GraphQL');
  }
  return json.data;
}

/** Legge da Shopify tutte le zone (con i loro metodi) di tutti i profili. */
async function fetchLocationGroupZones(graphql: AdminGraphql): Promise<LocationGroupZone[]> {
  const groups: Array<{ profileId: string; locationGroupId: string }> = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: ProfilesData = await runQuery<ProfilesData>(graphql, PROFILES_QUERY, { after });
    for (const profile of data.deliveryProfiles.nodes) {
      for (const group of profile.profileLocationGroups) {
        groups.push({ profileId: profile.id, locationGroupId: group.locationGroup.id });
      }
    }
    if (!data.deliveryProfiles.pageInfo.hasNextPage) break;
    after = data.deliveryProfiles.pageInfo.endCursor;
  }

  const zones: LocationGroupZone[] = [];
  for (const { profileId, locationGroupId } of groups) {
    let zonesAfter: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: GroupZonesData = await runQuery<GroupZonesData>(graphql, GROUP_ZONES_QUERY, {
        profileId,
        locationGroupId,
        after: zonesAfter,
      });
      const connection = data.deliveryProfile?.profileLocationGroups[0]?.locationGroupZones;
      if (!connection) break;
      zones.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) break;
      zonesAfter = connection.pageInfo.endCursor;
    }
  }
  return zones;
}

// ---------------------------------------------------------------------------
// Dai metodi Shopify alle opzioni proposte
// ---------------------------------------------------------------------------

const KG_PER_UNIT: Record<string, number> = {
  GRAMS: 0.001,
  KILOGRAMS: 1,
  OUNCES: 0.028349523125,
  POUNDS: 0.45359237,
};

/** Tre decimali come la colonna `range_from/range_to` (DECIMAL 12,3). */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function criteriaValue(condition: MethodCondition): number | null {
  const criteria = condition.conditionCriteria;
  if (criteria.__typename === 'Weight') {
    const factor = KG_PER_UNIT[criteria.unit];
    if (factor === undefined) return null;
    return round3(criteria.value * factor);
  }
  if (criteria.__typename === 'MoneyV2') {
    const amount = Number(criteria.amount);
    return Number.isFinite(amount) ? round3(amount) : null;
  }
  return null;
}

interface ProposedRate {
  rangeFrom: number | null;
  rangeTo: number | null;
  cost: number;
}

interface ProposedOption {
  name: string;
  costType: OptionCostType;
  shopifyKind: string;
  rates: ProposedRate[];
}

/** Le soglie di un metodo sul campo dato: >= e' `from`, <= e' `to`. */
function bracketOf(method: MethodDefinition, field: string): ProposedRate {
  let rangeFrom: number | null = null;
  let rangeTo: number | null = null;
  for (const condition of method.methodConditions) {
    if (condition.field !== field) continue;
    const value = criteriaValue(condition);
    if (value === null) continue;
    if (condition.operator === 'GREATER_THAN_OR_EQUAL_TO') rangeFrom = value;
    else if (condition.operator === 'LESS_THAN_OR_EQUAL_TO') rangeTo = value;
  }
  return { rangeFrom, rangeTo, cost: 0 };
}

/**
 * Tutti i metodi con lo stesso nome in una zona sono UNA opzione: in Shopify le
 * fasce si fanno con tariffe omonime a condizioni diverse. Il tipo si propone
 * dal tipo Shopify; i costi partono a 0 perche' le cifre di Shopify sono cio'
 * che paga il cliente, non quanto spende il merchant.
 */
function proposeOption(name: string, methods: MethodDefinition[]): ProposedOption {
  const hasField = (field: string) =>
    methods.some((m) => m.methodConditions.some((cond) => cond.field === field));

  let field: string | null = null;
  let costType: OptionCostType;
  let shopifyKind: string;
  if (hasField('TOTAL_PRICE')) {
    field = 'TOTAL_PRICE';
    costType = 'value_brackets';
    shopifyKind = 'DeliveryRateDefinition:TOTAL_PRICE';
  } else if (hasField('TOTAL_WEIGHT')) {
    field = 'TOTAL_WEIGHT';
    costType = 'weight_brackets';
    shopifyKind = 'DeliveryRateDefinition:TOTAL_WEIGHT';
  } else if (methods.some((m) => m.rateProvider.__typename === 'DeliveryParticipant')) {
    costType = 'linear';
    shopifyKind = 'DeliveryParticipant';
  } else {
    costType = 'flat';
    shopifyKind = 'DeliveryRateDefinition';
  }

  if (field === null) {
    return { name, costType, shopifyKind, rates: [{ rangeFrom: null, rangeTo: null, cost: 0 }] };
  }

  const seen = new Set<string>();
  const rates: ProposedRate[] = [];
  for (const method of methods) {
    if (!method.methodConditions.some((cond) => cond.field === field)) continue;
    const bracket = bracketOf(method, field);
    const key = `${bracket.rangeFrom}|${bracket.rangeTo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rates.push(bracket);
  }
  // null come `from` = dal minimo; null come `to` = illimitata, in fondo.
  rates.sort(
    (a, b) =>
      (a.rangeFrom ?? -Infinity) - (b.rangeFrom ?? -Infinity) ||
      (a.rangeTo ?? Infinity) - (b.rangeTo ?? Infinity)
  );
  return { name, costType, shopifyKind, rates };
}

/** Stesso confronto dell'abbinamento ordine → opzione. */
const optionKey = (name: string) => name.trim().toLowerCase();

// ---------------------------------------------------------------------------

export async function syncShippingZones(
  admin: { graphql: AdminGraphql },
  shopId: string
): Promise<{ added: number; updated: number; optionsAdded: number }> {
  const locationGroupZones = await fetchLocationGroupZones(admin.graphql);

  // Aggrega le zone da tutti i profili (stesso nome = stessa zona)
  const zoneMap = new Map<
    string,
    {
      countries: Set<string>;
      restOfWorld: boolean;
      methods: Map<string, { name: string; methods: MethodDefinition[] }>;
    }
  >();

  for (const { zone, methodDefinitions } of locationGroupZones) {
    const existing = zoneMap.get(zone.name) || {
      countries: new Set<string>(),
      restOfWorld: false,
      methods: new Map(),
    };

    for (const { code } of zone.countries) {
      if (code.restOfWorld) {
        existing.restOfWorld = true;
      } else {
        existing.countries.add(code.countryCode);
      }
    }

    if (methodDefinitions.pageInfo.hasNextPage) {
      console.warn(
        `[sync-zones] La zona "${zone.name}" ha piu di 30 metodi di spedizione: importati solo i primi 30`
      );
    }
    // Anche i metodi disattivati: possono esserci ordini storici che li usano.
    for (const method of methodDefinitions.nodes) {
      const name = method.name.trim();
      if (!name) continue;
      const key = optionKey(name);
      const group = existing.methods.get(key) || { name, methods: [] };
      group.methods.push(method);
      existing.methods.set(key, group);
    }

    zoneMap.set(zone.name, existing);
  }

  // Leggi le zone esistenti per sapere quali sono nuove
  const existingZones = await prisma.shippingZone.findMany({
    where: { shopId },
    select: { zoneName: true },
  });
  const existingNames = new Set(existingZones.map((z) => z.zoneName));

  let added = 0;
  let updated = 0;
  let optionsAdded = 0;
  const syncedAt = new Date();

  // Upsert ogni zona
  for (const [zoneName, { countries, restOfWorld, methods }] of zoneMap.entries()) {
    const countriesArray = Array.from(countries).sort();
    const isNew = !existingNames.has(zoneName);

    const savedZone = await prisma.shippingZone.upsert({
      where: { shopId_zoneName: { shopId, zoneName } },
      create: {
        shopId,
        zoneName,
        countries: countriesArray,
        restOfWorld,
        rateType: 'linear',
        syncedAt,
      },
      update: {
        countries: countriesArray,
        restOfWorld,
        syncedAt,
      },
    });

    if (isNew) {
      added++;
    } else {
      updated++;
    }

    if (methods.size === 0) continue;

    // Opzioni gia' presenti: tipo e fasce li ha scritti il merchant, non si
    // toccano. Quelle sparite da Shopify restano (servono agli ordini storici).
    const existingOptions = await prisma.shippingOption.findMany({
      where: { zoneId: savedZone.id },
      select: { name: true },
    });
    const existingKeys = new Set(existingOptions.map((o) => optionKey(o.name)));

    for (const [key, group] of methods.entries()) {
      if (existingKeys.has(key)) continue;
      const option = proposeOption(group.name, group.methods);
      // upsert con update vuoto: se un sync concorrente l'ha appena creata,
      // resta com'e'.
      await prisma.shippingOption.upsert({
        where: { zoneId_name: { zoneId: savedZone.id, name: option.name } },
        create: {
          zoneId: savedZone.id,
          name: option.name,
          costType: option.costType,
          shopifyKind: option.shopifyKind,
          rates: { create: option.rates },
        },
        update: {},
      });
      optionsAdded++;
    }
  }

  return { added, updated, optionsAdded };
}
