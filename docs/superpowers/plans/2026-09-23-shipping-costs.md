# Costi di spedizione — Implementation Plan (rev. 1.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Il merchant configura zone, tariffe, packaging e costo resi in una sezione "Spedizioni"; ogni ordine spedito porta il suo costo logistico, sottratto una volta per ordine dal profitto.

**Architecture:** Configurazione sul DB owner (Prisma). Funzione pura `computeLogisticsCost` che, dati ordine + configurazione, restituisce il costo. Il costo viene salvato in `orders.logistics_cost` sul DB merchant quando l'ordine si scrive, e ricalcolato in background quando cambia la configurazione. Le query del profitto lo sottraggono una volta per ordine.

**Tech Stack:** Remix, Prisma (DB owner), Supabase Management API `runQuery`/`runQueryRows` (DB merchant), Shopify Admin GraphQL, Polaris, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-shipping-costs-design.md` — la **Revisione 1.1** in testa è vincolante e prevale sul resto.

## Global Constraints

- Solo componenti Polaris; niente div/CSS custom dove esiste un componente.
- Tutti i testi in `app/lib/i18n/it.ts` e `app/lib/i18n/en.ts` (en è `typeof it`: le due lingue devono avere le stesse chiavi). Nei componenti si usa `useT()` da `~/lib/i18n/context`.
- Copy: solo benefici per il merchant; mai citare tabelle, database, RLS, sync interne.
- Tema chiaro sempre.
- Commenti in italiano, nello stile del codice esistente (spiegano il perché).
- Il costo logistico si sottrae **una volta per ordine**, mai una volta per riga.
- Spedizione + packaging solo su ordini spediti; rientro solo su ordini con reso.
- Ogni tabella nuova sul DB owner: `ENABLE ROW LEVEL SECURITY` nella migrazione.
- Commit che finiscono con:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` e `Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM`
- Test: `npx vitest run <file>`; typecheck: `npx tsc --noEmit`.

## Modelli per task

| Task | Contenuto | Modello |
|---|---|---|
| 1 | Tabelle owner + tipi | sonnet |
| 2 | Funzione pura del costo | sonnet |
| 3 | Import zone + scope | sonnet |
| 4 | Ordini: colonne v12, campi GraphQL, costo in scrittura | opus |
| 5 | Profitto: sottrazione una volta per ordine | opus |
| 6 | Ricalcolo in background al cambio configurazione | opus |
| 7 | Pagina Spedizioni: menu, tabella zone, modale tariffe | sonnet |
| 8 | Card packaging, peso di default, costo rientro | sonnet |
| 9 | Avviso "ordini senza peso" in dashboard | sonnet |
| 10 | E2E | sonnet |

---

### Task 1: Tabelle owner e tipi

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260923120000_shipping_costs/migration.sql`
- Create: `app/lib/shipping/types.ts`

**Interfaces — Produces:** modelli Prisma `ShippingZone`, `ShippingRate`, `PackagingConfig`, `ShippingAlertDismissal`; tipi in `types.ts` (sotto).

- [ ] **Step 1: modelli Prisma** — aggiungi in fondo a `schema.prisma`:

```prisma
model ShippingZone {
  id          String         @id @default(uuid())
  shopId      String         @map("shop_id")
  zoneName    String         @map("zone_name")
  countries   String[]
  restOfWorld Boolean        @default(false) @map("rest_of_world")
  rateType    String         @default("linear") @map("rate_type")
  syncedAt    DateTime       @default(now()) @map("synced_at")
  rates       ShippingRate[]

  @@unique([shopId, zoneName])
  @@index([shopId])
  @@map("shipping_zones")
}

model ShippingRate {
  id         String       @id @default(uuid())
  zoneId     String       @map("zone_id")
  weightFrom Decimal?     @map("weight_from") @db.Decimal(10, 3)
  weightTo   Decimal?     @map("weight_to") @db.Decimal(10, 3)
  cost       Decimal      @db.Decimal(10, 2)
  zone       ShippingZone @relation(fields: [zoneId], references: [id], onDelete: Cascade)

  @@index([zoneId])
  @@map("shipping_rates")
}

model PackagingConfig {
  shopId               String   @id @map("shop_id")
  categories           Json     @default("[]")
  fallbackRules        Json     @default("[]") @map("fallback_rules")
  defaultWeightPerItem Decimal? @map("default_weight_per_item") @db.Decimal(10, 3)
  returnCost           Decimal? @map("return_cost") @db.Decimal(10, 2)
  updatedAt            DateTime @updatedAt @map("updated_at")

  @@map("packaging_config")
}

model ShippingAlertDismissal {
  shopId      String   @id @map("shop_id")
  dismissedAt DateTime @default(now()) @map("dismissed_at")

  @@map("shipping_alert_dismissals")
}
```

`cost` significa: tariffa lineare → € per kg (una sola riga, `weightFrom`/`weightTo` null); fasce → € fissi della fascia `[weightFrom, weightTo)`, `weightTo` null = senza limite.

- [ ] **Step 2: migrazione SQL** — scrivi `migration.sql` equivalente ai modelli (`CREATE TABLE IF NOT EXISTS`, indici, FK con `ON DELETE CASCADE`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` per tutte e quattro le tabelle). Commento in testa in italiano, stile di `prisma/migrations/20260825100000_product_feeds/migration.sql`.

- [ ] **Step 3: tipi**

```ts
// app/lib/shipping/types.ts
export type RateType = 'linear' | 'brackets';

export interface RateBracket {
  weightFromKg: number | null;
  weightToKg: number | null;
  cost: number;
}

export interface ZoneConfig {
  zoneName: string;
  countries: string[];
  restOfWorld: boolean;
  rateType: RateType;
  rates: RateBracket[];
}

export interface PackagingCategory { name: string; cost: number }
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
}
```

- [ ] **Step 4:** `npx prisma generate && npx tsc --noEmit` → nessun errore.
- [ ] **Step 5: commit** `feat(spedizioni): tabelle di configurazione e tipi`.

---

### Task 2: Funzione pura del costo logistico

**Files:** Create `app/lib/shipping/logistics-cost.ts`, `app/lib/shipping/logistics-cost.test.ts`

**Interfaces — Consumes:** tipi del Task 1. **Produces:**
- `isShipped(status: string | null): boolean`
- `resolveWeightKg(order: OrderLogisticsInput, defaultPerItemKg: number | null): number | null`
- `resolvePackagingCategory(fromShopify: string | null, weightKg: number | null, rules: FallbackRule[]): string | null`
- `findZone(zones: ZoneConfig[], country: string | null): ZoneConfig | null`
- `computeLogisticsCost(order: OrderLogisticsInput, config: LogisticsConfig | null): { shipping: number; packaging: number; returns: number; total: number }`

- [ ] **Step 1: test che falliscono**

```ts
// app/lib/shipping/logistics-cost.test.ts
import { describe, it, expect } from 'vitest';
import { computeLogisticsCost, findZone, isShipped, resolvePackagingCategory, resolveWeightKg } from './logistics-cost';
import type { LogisticsConfig, OrderLogisticsInput } from './types';

const config: LogisticsConfig = {
  zones: [
    { zoneName: 'Italia', countries: ['IT'], restOfWorld: false, rateType: 'linear', rates: [{ weightFromKg: null, weightToKg: null, cost: 2 }] },
    { zoneName: 'UE', countries: ['FR', 'DE'], restOfWorld: false, rateType: 'brackets', rates: [
      { weightFromKg: 0, weightToKg: 1, cost: 5 },
      { weightFromKg: 1, weightToKg: 5, cost: 8 },
      { weightFromKg: 5, weightToKg: null, cost: 15 },
    ] },
    { zoneName: 'Mondo', countries: [], restOfWorld: true, rateType: 'linear', rates: [{ weightFromKg: null, weightToKg: null, cost: 10 }] },
  ],
  categories: [{ name: 'Busta', cost: 1.5 }, { name: 'Box', cost: 3 }],
  fallbackRules: [{ weightMaxKg: 1, category: 'Busta' }, { weightMaxKg: null, category: 'Box' }],
  defaultWeightPerItemKg: 0.5,
  returnCost: 5,
};

const base: OrderLogisticsInput = {
  fulfillment_status: 'fulfilled', shipping_country_code: 'IT', total_weight_grams: 3000,
  item_count: 2, returned_at: null, packaging_category: 'Box',
};

describe('isShipped', () => {
  it('spedito, parziale e con tracking contano', () => {
    expect(isShipped('fulfilled')).toBe(true);
    expect(isShipped('FULFILLED')).toBe(true);
    expect(isShipped('PARTIALLY_FULFILLED')).toBe(true);
  });
  it('non spedito o sconosciuto non conta', () => {
    expect(isShipped('UNFULFILLED')).toBe(false);
    expect(isShipped(null)).toBe(false);
  });
});

describe('resolveWeightKg', () => {
  it('usa il peso dell ordine in grammi', () => {
    expect(resolveWeightKg(base, 0.5)).toBe(3);
  });
  it('peso assente o zero: default per articolo x articoli', () => {
    expect(resolveWeightKg({ ...base, total_weight_grams: 0 }, 0.5)).toBe(1);
    expect(resolveWeightKg({ ...base, total_weight_grams: null }, 0.5)).toBe(1);
  });
  it('niente peso e niente default: null', () => {
    expect(resolveWeightKg({ ...base, total_weight_grams: null }, null)).toBeNull();
  });
});

describe('resolvePackagingCategory', () => {
  it('quella indicata dall ordine vince', () => {
    expect(resolvePackagingCategory('Busta', 10, config.fallbackRules)).toBe('Busta');
  });
  it('altrimenti la prima regola che combacia col peso', () => {
    expect(resolvePackagingCategory(null, 0.8, config.fallbackRules)).toBe('Busta');
    expect(resolvePackagingCategory(null, 3, config.fallbackRules)).toBe('Box');
  });
  it('senza peso: null', () => {
    expect(resolvePackagingCategory(null, null, config.fallbackRules)).toBeNull();
  });
});

describe('findZone', () => {
  it('paese elencato', () => {
    expect(findZone(config.zones, 'FR')?.zoneName).toBe('UE');
  });
  it('paese non elencato cade nel resto del mondo', () => {
    expect(findZone(config.zones, 'US')?.zoneName).toBe('Mondo');
  });
  it('senza resto del mondo: null', () => {
    expect(findZone(config.zones.slice(0, 2), 'US')).toBeNull();
  });
});

describe('computeLogisticsCost', () => {
  it('lineare: 3 kg x 2 = 6, piu packaging Box 3', () => {
    expect(computeLogisticsCost(base, config)).toEqual({ shipping: 6, packaging: 3, returns: 0, total: 9 });
  });
  it('fasce: 4 kg in UE = 8', () => {
    const c = computeLogisticsCost({ ...base, shipping_country_code: 'FR', total_weight_grams: 4000 }, config);
    expect(c.shipping).toBe(8);
  });
  it('confine di fascia: 1 kg esatto cade nella fascia 1-5', () => {
    const c = computeLogisticsCost({ ...base, shipping_country_code: 'FR', total_weight_grams: 1000 }, config);
    expect(c.shipping).toBe(8);
  });
  it('packaging assente sull ordine: regola di fallback', () => {
    const c = computeLogisticsCost({ ...base, packaging_category: null, total_weight_grams: 500 }, config);
    expect(c.packaging).toBe(1.5);
  });
  it('non spedito: niente spedizione ne packaging', () => {
    const c = computeLogisticsCost({ ...base, fulfillment_status: 'UNFULFILLED' }, config);
    expect(c).toEqual({ shipping: 0, packaging: 0, returns: 0, total: 0 });
  });
  it('reso: aggiunge il costo di rientro', () => {
    const c = computeLogisticsCost({ ...base, returned_at: '2026-09-20T10:00:00Z' }, config);
    expect(c.returns).toBe(5);
    expect(c.total).toBe(14);
  });
  it('categoria non piu configurata: packaging 0, nessun errore', () => {
    const c = computeLogisticsCost({ ...base, packaging_category: 'XL' }, config);
    expect(c.packaging).toBe(0);
  });
  it('nessuna configurazione: tutto 0', () => {
    expect(computeLogisticsCost(base, null).total).toBe(0);
  });
  it('arrotonda al centesimo', () => {
    const c = computeLogisticsCost({ ...base, total_weight_grams: 1234, packaging_category: null }, { ...config, fallbackRules: [] });
    expect(c.shipping).toBe(2.47);
  });
});
```

- [ ] **Step 2:** `npx vitest run app/lib/shipping/logistics-cost.test.ts` → FAIL (modulo mancante).
- [ ] **Step 3: implementazione**

```ts
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
```

Nota: la fixture usa `fulfillment_status: 'fulfilled'` (minuscolo) — il Task 4 scrive `'FULFILLED'` quando c'è tracking; `isShipped` normalizza.

- [ ] **Step 4:** test → PASS; `npx tsc --noEmit` pulito.
- [ ] **Step 5: commit** `feat(spedizioni): calcolo del costo logistico per ordine`.

---

### Task 3: Import delle zone da Shopify + scope

**Files:** Create `app/lib/shipping/sync-zones.server.ts`, `app/lib/shipping/sync-zones.server.test.ts`, `app/lib/shipping/load-config.server.ts`, `app/lib/shipping/load-config.server.test.ts`; Modify `shopify.app.toml` (scopes).

**Interfaces — Produces:**
- `syncShippingZones(admin: { graphql: AdminGraphql }, shopId: string): Promise<{ added: number; updated: number }>` — `admin` è quello di `authenticate.admin(request)`; prima di scrivere, guarda come le rotte esistenti ottengono `shopId` (es. `app/routes/customers.tsx`) e usa lo stesso identificatore.
- `loadLogisticsConfig(shopId: string): Promise<LogisticsConfig | null>` — legge le tre tabelle, converte `Decimal` in `number`, ritorna `null` se non esistono né zone con tariffe né packaging. Se la tabella non esiste ancora (Prisma `P2021`), ritorna `null` senza rumore — stesso schema di `app/lib/customers/birthdate-dismissal.server.ts`.

**Query:**

```graphql
query DeliveryZones {
  deliveryProfiles(first: 20) {
    nodes {
      profileLocationGroups {
        locationGroupZones(first: 100) {
          nodes { zone { name countries { code { countryCode restOfWorld } } } }
        }
      }
    }
  }
}
```

Regole: più profili possono avere zone con lo stesso nome → unisci i paesi (senza duplicati). `restOfWorld: true` su un paese → `restOfWorld` della zona = true (il paese non entra in `countries`). Upsert su `(shopId, zoneName)`: crea con `rateType 'linear'` e nessuna tariffa; aggiorna solo `countries`, `restOfWorld`, `syncedAt` — tariffe e tipo restano. Zone sparite da Shopify restano.

- [ ] **Step 1:** test con `admin.graphql` finto (risposta `Response` JSON) e Prisma mockato come in `birthdate-dismissal.server.test.ts`: zona nuova → create; zona esistente → update che non tocca `rateType`; stesso nome su due profili → paesi uniti; resto del mondo → `restOfWorld: true`. Per `loadLogisticsConfig`: conversione Decimal→number, `null` senza configurazione, `null` su P2021.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS + tsc.
- [ ] **Step 5:** in `shopify.app.toml` aggiungi `read_shipping,read_returns` alla stringa `scopes`.
- [ ] **Step 6: commit** `feat(spedizioni): import delle zone da Shopify`.

---

### Task 4: Ordini — colonne v12, campi GraphQL, costo in scrittura

**Files:** Modify `app/lib/supabase-schema.ts` (`ORDERS_COLUMNS`), `app/lib/supabase/merchant-migrations.ts` (`LATEST_SCHEMA_VERSION` 11→12), `app/lib/shopify-api.server.ts` (`orderNodeFields`, tipo `GqlOrder`, mapping verso `ShopifyOrder`), `app/lib/customers/order-rows.ts` (`ShopifyOrder`, `OrderRow`, `orderToRows`), `app/lib/customers/order-write.server.ts` e i chiamanti (`app/lib/webhooks/handle-order.server.ts`, `app/lib/workers/processors.server.ts`) + i loro test.

**Interfaces — Consumes:** `computeLogisticsCost`, `OrderLogisticsInput` (Task 2), `loadLogisticsConfig` (Task 3).

Requisiti:
1. Colonne nuove in `ORDERS_COLUMNS`: `fulfillment_status TEXT`, `shipping_country_code TEXT`, `total_weight_grams INTEGER`, `item_count INTEGER`, `returned_at TIMESTAMP`, `packaging_category TEXT`, `logistics_cost NUMERIC(10, 2)`. Bump a 12; nessuna migrazione dati (restano NULL fino alla prossima scrittura/ricalcolo).
2. `orderNodeFields` aggiunge: `displayFulfillmentStatus`, `fulfillments(first: 10) { trackingInfo { number } }`, `shippingAddress { countryCodeV2 }`, `totalWeight`, `returns(first: 5) { nodes { status createdAt } }`, `metafield(namespace: "custom", key: "packaging_category") { value }`. Verifica con la documentazione Admin API della versione usata dal progetto che i nomi dei campi esistano; se `fulfillments` non è una connessione nella versione in uso, usa la forma corretta.
3. Mapping: `fulfillment_status` = `'FULFILLED'` se almeno un fulfillment ha un tracking, altrimenti `displayFulfillmentStatus`; `returned_at` = `createdAt` del primo reso con stato diverso da `CANCELED`/`DECLINED`; `item_count` = somma di `currentQuantity` delle righe; `total_weight_grams` = `totalWeight` convertito in intero.
4. `logistics_cost` = `computeLogisticsCost(...).total` calcolato quando l'ordine viene scritto: la configurazione si carica **una volta per esecuzione** (per il batch nel worker, per l'evento nel webhook), non una volta per ordine. `orderToRows` resta pura: riceve la configurazione come parametro opzionale (`null` → `logistics_cost` 0).
5. Tutti i test esistenti di `order-rows`, `order-write`, `handle-order`, `processors` restano verdi; aggiungi casi per: tracking → FULFILLED; reso annullato ignorato; costo calcolato con config; config null → 0.

- [ ] Step 1 test che falliscono → Step 2 FAIL → Step 3 implementazione → Step 4 `npx vitest run app/lib/customers app/lib/webhooks app/lib/workers` PASS + tsc → Step 5 commit `feat(spedizioni): dati di spedizione e costo logistico sugli ordini`.

---

### Task 5: Profitto — sottrazione una volta per ordine

**Files:** Modify `app/lib/customers/net-contribution.ts`, `app/lib/customers/customers-query.ts` + relativi test. **Non** toccare `top-products.ts` (il profitto per prodotto resta senza costo logistico — spec rev. 1.1 punto 2).

Requisiti:
1. Le query in `customers-query.ts` uniscono `orders o` a `order_lines l`: ogni ordine compare tante volte quante sono le sue righe. Il costo logistico va sottratto **una sola volta per ordine** da ogni `profit` calcolato lì. Aggiungi in `net-contribution.ts` un frammento esportato (es. `ORDER_LOGISTICS_SUM`) che somma `o.logistics_cost` contando ogni ordine una volta sola (per esempio con un `FILTER` sulla prima riga dell'ordine, o con una sottoquery per ordine — scegli la forma più leggibile e spiega il perché in un commento). Solo ordini che contano come vendita (`ORDER_COUNTS_AS_SALE`).
2. `profit` diventa `NET_CONTRIBUTION_SUM - ORDER_LOGISTICS_SUM` in tutte le query del file dove oggi c'è `NET_CONTRIBUTION_SUM AS profit`. `logistics_cost` NULL vale 0.
3. Aggiorna `netContribution()` (versione TS) solo se esistono chiamanti che devono restare allineati al SQL; se il costo logistico è per ordine, documenta nel commento che la funzione per riga non lo include.
4. Test: un ordine con 4 righe e `logistics_cost = 10` → profitto ridotto di 10, non di 40 (verifica sul testo SQL generato o con il meccanismo di test già usato in `customers-query.test.ts`); un ordine annullato non sottrae nulla; `logistics_cost` NULL non rende NULL il profitto.

- [ ] Step 1-4 TDD come sopra; `npx vitest run app/lib/customers` PASS + tsc → Step 5 commit `feat(spedizioni): il profitto sottrae il costo logistico una volta per ordine`.

---

### Task 6: Ricalcolo in background al cambio configurazione

**Files:** Create `app/lib/shipping/recompute.server.ts` + test; Modify il sistema di code/worker esistente (`app/lib/workers/processors.server.ts` e dove i job vengono registrati/accodati — segui come è fatto un job esistente).

**Interfaces — Consumes:** `loadLogisticsConfig`, `computeLogisticsCost`, `runQueryRows`/`runQuery` da `app/lib/supabase-management.server.ts`. **Produces:** `enqueueLogisticsRecompute(shopId: string): Promise<void>` usato dai Task 7-8 dopo ogni salvataggio.

Requisiti:
1. Il job legge gli ordini dal DB merchant a pagine (es. 500 per volta, per `shopify_order_id`), calcola `logistics_cost` in TS con la configurazione caricata una volta, e scrive con un `UPDATE ... FROM (VALUES ...)` per pagina. Valori numerici validati prima di finire nell'SQL (niente interpolazione di stringhe arbitrarie).
2. Più salvataggi ravvicinati → un solo ricalcolo in coda per negozio (deduplica come fanno i job esistenti).
3. Database merchant in pausa o tabella `orders` assente → il job termina senza errore rumoroso (stesso comportamento degli altri job).
4. Test: pagina con 3 ordini → un solo UPDATE con 3 valori corretti; seconda chiamata ravvicinata non accoda un secondo job; tabella assente → nessuna eccezione.

- [ ] TDD → `npx vitest run app/lib/shipping app/lib/workers` PASS + tsc → commit `feat(spedizioni): ricalcolo dei costi quando cambiano le tariffe`.

---

### Task 7: Pagina Spedizioni — menu, tabella zone, modale tariffe

**Files:** Create `app/routes/spedizioni.tsx`, `app/components/Shipping/ShippingZonesTable.tsx`, `app/components/Shipping/EditZoneModal.tsx`, `app/components/Shipping/BracketsEditor.tsx`, `app/components/Shipping/brackets.ts` (+ `brackets.test.ts`); Modify `app/root.tsx` (voce menu), `app/lib/i18n/it.ts`, `app/lib/i18n/en.ts`.

Requisiti:
1. Menu: `<Link to="/spedizioni">{menu.shipping}</Link>` dopo Clienti, dentro il blocco `setupComplete`. La rotta, come le altre, rimanda alla home se la configurazione non è completa (copia il controllo usato da `customers.tsx`).
2. Loader: zone con tariffe. Action con intent: `sync-zones` (chiama `syncShippingZones`), `save-zone-rates` (valida lato server con `validateBrackets`, sostituisce le tariffe della zona in una transazione Prisma, poi `enqueueLogisticsRecompute`).
3. Tabella (Polaris `IndexTable` o `DataTable`): Zona, Paesi (primi 3 + "e altri N"), Tipo tariffa, Costo indicativo (`€2,00/kg`, `€5,00 – €15,00`, `—`), pulsante Modifica. Stato vuoto con azione "Importa zone da Shopify". Importazione dal pulsante primario della pagina, esito in Toast.
4. Modale: scelta Lineare/Fasce (`ChoiceList`), `TextField` €/kg oppure `BracketsEditor`. `brackets.ts` contiene `validateBrackets(brackets: RateBracket[]): string | null` (chiave i18n dell'errore o null) con regole: prima fascia da 0; fasce contigue senza buchi né sovrapposizioni; solo l'ultima senza limite; costi ≥ 0. Test unitari per ogni regola.
5. Tutti i testi in i18n IT + EN; copy orientato al merchant ("Quanto ti costa spedire in questa zona").

- [ ] TDD su `brackets.ts` → implementa pagina → `npx vitest run app/components/Shipping` PASS + tsc → prova manuale con `npm run dev` (import zone, tariffa lineare, tariffa a fasce, riapertura della modale con i valori salvati) → commit `feat(spedizioni): pagina Spedizioni con zone e tariffe`.

---

### Task 8: Packaging, peso di default, costo rientro

**Files:** Create `app/components/Shipping/PackagingCard.tsx`, `app/components/Shipping/packaging.ts` (+ test); Modify `app/routes/spedizioni.tsx`, i18n IT/EN.

Requisiti:
1. Card nella colonna laterale di `/spedizioni`: categorie di imballo (nome + costo, aggiungi/rimuovi), regole per peso (peso massimo kg o "tutto il resto" + categoria, in ordine), peso di default per articolo (kg), costo di rientro per ordine reso (€). Un pulsante Salva.
2. `packaging.ts`: `validatePackaging(input)` — nomi categoria non vuoti e unici, costi ≥ 0, regole che puntano a categorie esistenti, al massimo una regola "tutto il resto" e solo in fondo. Test per ogni regola.
3. Action `save-packaging`: valida lato server, upsert `PackagingConfig`, poi `enqueueLogisticsRecompute`. Esito in Toast.
4. Testi i18n IT + EN; testo di aiuto del peso di default: si usa per gli ordini i cui prodotti non hanno un peso su Shopify.

- [ ] TDD su `packaging.ts` → implementa → test + tsc → prova manuale → commit `feat(spedizioni): packaging, peso di default e costo dei resi`.

---

### Task 9: Avviso "ordini senza peso" in dashboard

**Files:** Create `app/components/Dashboard/WeightMissingBanner.tsx`, `app/lib/shipping/weight-alert.server.ts` (+ test); Modify `app/routes/_index.tsx`, i18n IT/EN.

Requisiti:
1. Conteggio sul **DB merchant** con `runQueryRows`: ordini spediti e non annullati con `total_weight_grams` NULL o 0. Se `defaultWeightPerItem` è configurato l'avviso non compare (il costo è già coperto). Errori o DB in pausa → conteggio 0, niente avviso.
2. Banner Polaris `tone="info"`, chiudibile; la chiusura scrive `ShippingAlertDismissal` (intent `dismiss-weight-alert` nell'action della dashboard). Tabella assente → risposta "chiuso", come `birthdateNoticeDismissedFor`.
3. Testo: quanti ordini non hanno un peso e che basta indicare un peso medio per articolo; link a `/spedizioni`.
4. Test del modulo server: con default configurato → nessun avviso; conteggio > 0 e non chiuso → avviso; chiuso → nessun avviso; errore → nessun avviso.

- [ ] TDD → implementa → test + tsc → commit `feat(spedizioni): avviso in dashboard per gli ordini senza peso`.

---

### Task 10: E2E

**Files:** Create il test Playwright nella cartella E2E esistente del progetto (usa la stessa configurazione e gli stessi helper degli E2E già presenti, locale `it-IT`).

Scenari: la voce Spedizioni compare nel menu; `/spedizioni` mostra lo stato vuoto o la tabella; apertura della modale, passaggio a Fasce, errore di validazione visibile con fasce non contigue; salvataggio della card packaging con esito positivo. Se l'ambiente E2E non può raggiungere Shopify per l'import delle zone, copri solo ciò che non richiede la rete e dichiaralo nel report.

- [ ] Scrivi → esegui con il comando E2E del progetto → commit `test(spedizioni): percorso end-to-end della pagina Spedizioni`.

---

## Dopo l'esecuzione (azioni dell'utente)

1. Applicare la migrazione owner `20260923120000_shipping_costs` su Live e Test.
2. `shopify app deploy` per gli scope `read_shipping` e `read_returns`.
3. Aprire l'app su coreward-demo: lo schema merchant v12 si applica da solo.
