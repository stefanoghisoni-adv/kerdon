# Shipping Costs Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shipping cost tracking (zones, rates, packaging) and integrate into profit calculation

**Architecture:** 3-table normalized schema on DB owner for configuration, 5-column extension on merchant orders for operational data, sync from Shopify zones + order fields, calculate costs at runtime and integrate into net contribution

**Tech Stack:** Remix, Prisma, Shopify GraphQL API, Polaris UI, Vitest

**Spec:** `docs/superpowers/specs/2026-09-23-shipping-costs-design.md`

## Global Constraints

- Node.js 24 LTS
- Remix framework
- Shopify GraphQL API (Admin API 2024-10 or later)
- Polaris components only (no custom div/CSS)
- Copy: merchant benefits only, no internal implementation details
- Tests: Vitest framework
- i18n: IT + EN texts for all UI strings
- Commits: frequent, one deliverable per commit

---

## Task 1: Schema Database e Tipi Base

**Files:**
- Create: `app/lib/shipping/types.ts`
- Modify: `prisma/schema.prisma`
- SQL: Manual execution on DB owner (provided in step 3)

**Interfaces:**
- Produces:
  - TypeScript types: `Zone`, `ShippingRate`, `PackagingConfig`, `ShippingCostBreakdown`
  - Prisma models: `ShippingZone`, `ShippingRate`, `PackagingConfig`

- [ ] **Step 1: Crea file tipi TypeScript**

```typescript
// app/lib/shipping/types.ts

export type RateType = 'linear' | 'brackets';

export interface Zone {
  id: string;
  shopId: string;
  zoneName: string;
  countries: string[];
  rateType: RateType;
  syncedAt: Date;
  rates: ShippingRate[];
}

export interface ShippingRate {
  id: string;
  zoneId: string;
  weightFrom: number | null;  // NULL if linear
  weightTo: number | null;    // NULL if linear
  costPerKg: number;
}

export interface PackagingCategory {
  name: string;
  cost: number;
}

export interface FallbackRule {
  weight_max: number | null;  // NULL = catch-all
  category: string;
}

export interface PackagingConfig {
  shopId: string;
  categories: PackagingCategory[];
  fallbackRules: FallbackRule[];
  defaultWeightPerItem: number | null;
  returnCost: number | null;
}

export interface ShippingCostBreakdown {
  shipping: number;
  packaging: number;
  return: number;
  total: number;
}

export interface OrderShippingData {
  shipping_country_code: string | null;
  total_weight: number | null;
  packaging_category: string | null;
  returned_at: Date | null;
}
```

- [ ] **Step 2: Aggiungi model Prisma**

```prisma
// prisma/schema.prisma

// Aggiungi dopo gli altri model

model ShippingZone {
  id        String   @id @default(uuid())
  shopId    String   @map("shop_id")
  zoneName  String   @map("zone_name")
  countries String[]
  rateType  String   @map("rate_type")
  syncedAt  DateTime @default(now()) @map("synced_at")
  
  rates ShippingRate[]
  
  @@unique([shopId, zoneName], map: "shipping_zones_shop_id_zone_name_key")
  @@index([shopId], map: "idx_shipping_zones_shop")
  @@map("shipping_zones")
}

model ShippingRate {
  id         String   @id @default(uuid())
  zoneId     String   @map("zone_id")
  weightFrom Decimal? @map("weight_from") @db.Decimal(10, 3)
  weightTo   Decimal? @map("weight_to") @db.Decimal(10, 3)
  costPerKg  Decimal  @map("cost_per_kg") @db.Decimal(10, 2)
  createdAt  DateTime @default(now()) @map("created_at")
  
  zone ShippingZone @relation(fields: [zoneId], references: [id], onDelete: Cascade)
  
  @@index([zoneId], map: "idx_shipping_rates_zone")
  @@map("shipping_rates")
}

model PackagingConfig {
  shopId               String   @id @map("shop_id")
  categories           Json
  fallbackRules        Json     @map("fallback_rules")
  defaultWeightPerItem Decimal? @map("default_weight_per_item") @db.Decimal(10, 3)
  returnCost           Decimal? @map("return_cost") @db.Decimal(10, 2)
  updatedAt            DateTime @default(now()) @map("updated_at")
  
  @@map("packaging_config")
}
```

- [ ] **Step 3: Crea SQL per DB owner**

Salva in `docs/migrations/2026-09-23-shipping-tables-owner.sql`:

```sql
-- Execute manually on DB owner (Postgres)

CREATE TABLE shipping_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  countries TEXT[] NOT NULL,
  rate_type TEXT NOT NULL CHECK (rate_type IN ('linear', 'brackets')),
  synced_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_id, zone_name)
);
CREATE INDEX idx_shipping_zones_shop ON shipping_zones(shop_id);

CREATE TABLE shipping_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id UUID NOT NULL REFERENCES shipping_zones ON DELETE CASCADE,
  weight_from NUMERIC(10,3),
  weight_to NUMERIC(10,3),
  cost_per_kg NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  CHECK (
    (weight_from IS NULL AND weight_to IS NULL) OR  -- linear
    (weight_from IS NOT NULL)                       -- brackets
  )
);
CREATE INDEX idx_shipping_rates_zone ON shipping_rates(zone_id);

CREATE TABLE packaging_config (
  shop_id TEXT PRIMARY KEY,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  fallback_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_weight_per_item NUMERIC(10,3),
  return_cost NUMERIC(10,2),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

- [ ] **Step 4: Genera Prisma client**

Run: `npx prisma generate`  
Expected: Client generato con nuovi model

- [ ] **Step 5: Commit**

```bash
git add app/lib/shipping/types.ts prisma/schema.prisma docs/migrations/2026-09-23-shipping-tables-owner.sql
git commit -m "feat(shipping): add database schema and TypeScript types

- 3 new Prisma models: ShippingZone, ShippingRate, PackagingConfig
- TypeScript interfaces for shipping cost calculation
- SQL migration script for DB owner (manual execution required)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM"
```

---

## Task 2: Sync Shipping Zones da Shopify

**Files:**
- Create: `app/lib/shipping/sync-zones.server.ts`
- Create: `app/lib/shipping/sync-zones.server.test.ts`

**Interfaces:**
- Produces:
  - `syncShippingZones(shopId: string): Promise<{ added: number; updated: number }>`

- [ ] **Step 1: Scrivi test che fallisce**

```typescript
// app/lib/shipping/sync-zones.server.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '~/db.server';

// Mock Shopify API
vi.mock('~/lib/shopify-api.server', () => ({
  shopifyGraphQL: vi.fn()
}));

import { shopifyGraphQL } from '~/lib/shopify-api.server';
import { syncShippingZones } from './sync-zones.server';

const SHOP_ID = 'test-shop';

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.shippingZone.deleteMany({ where: { shopId: SHOP_ID } });
});

describe('syncShippingZones', () => {
  it('zona nuova: insert con rateType linear default', async () => {
    vi.mocked(shopifyGraphQL).mockResolvedValue({
      shop: {
        shippingZones: {
          nodes: [
            {
              id: 'gid://shopify/DeliveryZone/1',
              name: 'Italia',
              countries: [{ code: { countryCode: 'IT' } }]
            }
          ]
        }
      }
    });
    
    const result = await syncShippingZones(SHOP_ID);
    
    expect(result).toEqual({ added: 1, updated: 0 });
    
    const zone = await prisma.shippingZone.findFirst({ 
      where: { shopId: SHOP_ID } 
    });
    expect(zone).toMatchObject({
      zoneName: 'Italia',
      countries: ['IT'],
      rateType: 'linear'
    });
  });
  
  it('zona esistente: update solo countries e syncedAt', async () => {
    // Setup: zona già presente
    const existing = await prisma.shippingZone.create({
      data: {
        shopId: SHOP_ID,
        zoneName: 'UE',
        countries: ['FR', 'DE'],
        rateType: 'brackets'
      }
    });
    
    const oldSyncedAt = existing.syncedAt;
    
    // Shopify ritorna paesi aggiornati
    vi.mocked(shopifyGraphQL).mockResolvedValue({
      shop: {
        shippingZones: {
          nodes: [{
            id: 'gid://shopify/DeliveryZone/2',
            name: 'UE',
            countries: [
              { code: { countryCode: 'FR' } },
              { code: { countryCode: 'BE' } }
            ]
          }]
        }
      }
    });
    
    const result = await syncShippingZones(SHOP_ID);
    
    expect(result).toEqual({ added: 0, updated: 1 });
    
    const updated = await prisma.shippingZone.findFirst({
      where: { shopId: SHOP_ID, zoneName: 'UE' }
    });
    expect(updated?.countries).toEqual(['FR', 'BE']); // aggiornati
    expect(updated?.rateType).toBe('brackets');      // invariato
    expect(updated?.syncedAt.getTime()).toBeGreaterThan(oldSyncedAt.getTime());
  });
  
  it('zone multiple: mix insert/update', async () => {
    await prisma.shippingZone.create({
      data: {
        shopId: SHOP_ID,
        zoneName: 'Italia',
        countries: ['IT'],
        rateType: 'linear'
      }
    });
    
    vi.mocked(shopifyGraphQL).mockResolvedValue({
      shop: {
        shippingZones: {
          nodes: [
            { 
              id: 'gid://shopify/DeliveryZone/1',
              name: 'Italia', 
              countries: [{ code: { countryCode: 'IT' } }] 
            },
            { 
              id: 'gid://shopify/DeliveryZone/2',
              name: 'Mondo', 
              countries: [{ code: { countryCode: 'US' } }] 
            }
          ]
        }
      }
    });
    
    const result = await syncShippingZones(SHOP_ID);
    expect(result).toEqual({ added: 1, updated: 1 });
  });
});
```

- [ ] **Step 2: Run test per verificare fallimento**

Run: `npm test sync-zones.server.test.ts`  
Expected: FAIL "Cannot find module './sync-zones.server'"

- [ ] **Step 3: Implementa sync zone**

```typescript
// app/lib/shipping/sync-zones.server.ts
import { prisma } from '~/db.server';
import { shopifyGraphQL } from '~/lib/shopify-api.server';

const ZONES_QUERY = `
  query ShippingZones {
    shop {
      shippingZones {
        nodes {
          id
          name
          countries {
            code {
              countryCode
            }
          }
        }
      }
    }
  }
`;

interface ShopifyZone {
  id: string;
  name: string;
  countries: Array<{
    code: {
      countryCode: string;
    };
  }>;
}

interface SyncResult {
  added: number;
  updated: number;
}

export async function syncShippingZones(shopId: string): Promise<SyncResult> {
  const response = await shopifyGraphQL(shopId, ZONES_QUERY);
  
  const zones: ShopifyZone[] = response.shop?.shippingZones?.nodes || [];
  
  let added = 0;
  let updated = 0;
  
  for (const zone of zones) {
    const countries = zone.countries.map(c => c.code.countryCode);
    
    const result = await prisma.shippingZone.upsert({
      where: {
        shopId_zoneName: {
          shopId,
          zoneName: zone.name
        }
      },
      create: {
        shopId,
        zoneName: zone.name,
        countries,
        rateType: 'linear' // default
      },
      update: {
        countries,
        syncedAt: new Date()
      }
    });
    
    // Determina se created o updated
    const existing = await prisma.shippingZone.findUnique({
      where: {
        shopId_zoneName: { shopId, zoneName: zone.name }
      },
      select: { syncedAt: true }
    });
    
    // Se syncedAt è appena ora, è un update; altrimenti è create
    const isUpdate = existing && 
      Math.abs(existing.syncedAt.getTime() - Date.now()) < 1000;
    
    if (isUpdate) {
      updated++;
    } else {
      added++;
    }
  }
  
  return { added, updated };
}
```

- [ ] **Step 4: Run test per verificare successo**

Run: `npm test sync-zones.server.test.ts`  
Expected: PASS (tutti i test passano)

- [ ] **Step 5: Commit**

```bash
git add app/lib/shipping/sync-zones.server.ts app/lib/shipping/sync-zones.server.test.ts
git commit -m "feat(shipping): implement Shopify zones sync

- Query GraphQL per shipping zones
- Upsert logic: insert nuove, update paesi esistenti
- Test coverage: insert, update, mix

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM"
```

---

## Task 3: Migrazione Merchant + Sync Order Data

**Files:**
- Modify: `app/lib/supabase-schema.ts:165-183` (ORDERS_COLUMNS)
- Modify: `app/lib/supabase/merchant-migrations.ts:329` (LATEST_SCHEMA_VERSION)
- Modify: `app/lib/shopify-api.server.ts:262-272` (orderNodeFields)
- Modify: `app/lib/shopify-api.server.ts:~1392` (mapOrderWithAllLines)
- Create: `app/lib/shipping/order-helpers.ts`
- Create: `app/lib/shipping/order-helpers.test.ts`

**Interfaces:**
- Consumes: `PackagingConfig` type from Task 1
- Produces:
  - `determineFulfillmentStatus(order: GqlOrder): string | null`
  - `calculateTotalWeight(lineItems: GqlLineItem[], defaultPerItem?: number): number | null`
  - `determinePackagingCategory(metafield?: string, weight?: number | null, rules?: FallbackRule[]): string | null`

- [ ] **Step 1: Aggiungi colonne a schema**

```typescript
// app/lib/supabase-schema.ts

// Modifica ORDERS_COLUMNS (riga ~165):
const ORDERS_COLUMNS: Column[] = [
  { name: 'id', type: 'UUID', constraints: 'PRIMARY KEY DEFAULT gen_random_uuid()' },
  { name: 'shopify_order_id', type: 'BIGINT', constraints: 'UNIQUE NOT NULL' },
  { name: 'order_number', type: 'TEXT' },
  { name: 'shopify_customer_id', type: 'BIGINT' },
  { name: 'customer_first_name', type: 'TEXT' },
  { name: 'customer_last_name', type: 'TEXT' },
  { name: 'currency', type: 'TEXT' },
  { name: 'total_price', type: 'NUMERIC(10, 2)' },
  { name: 'financial_status', type: 'TEXT' },
  { name: 'cancelled_at', type: 'TIMESTAMP' },
  { name: 'placed_at', type: 'TIMESTAMP' },
  { name: 'updated_at', type: 'TIMESTAMP' },
  { name: 'synced_at', type: 'TIMESTAMP DEFAULT NOW()' },
  // ◄── AGGIUNGI QUESTE 5 RIGHE:
  { name: 'fulfillment_status', type: 'TEXT' },
  { name: 'shipping_country_code', type: 'TEXT' },
  { name: 'total_weight', type: 'NUMERIC(10, 3)' },
  { name: 'returned_at', type: 'TIMESTAMP' },
  { name: 'packaging_category', type: 'TEXT' },
];
```

- [ ] **Step 2: Bump versione schema**

```typescript
// app/lib/supabase/merchant-migrations.ts

// Riga 329, cambia da 11 a 12:
export const LATEST_SCHEMA_VERSION = 12;
```

- [ ] **Step 3: Scrivi test helpers**

```typescript
// app/lib/shipping/order-helpers.test.ts
import { describe, it, expect } from 'vitest';
import {
  determineFulfillmentStatus,
  calculateTotalWeight,
  determinePackagingCategory
} from './order-helpers';

describe('determineFulfillmentStatus', () => {
  it('ha tracking number → fulfilled', () => {
    const order = {
      fulfillments: [{ trackingInfo: { number: 'ABC123' } }],
      displayFulfillmentStatus: 'UNFULFILLED'
    };
    expect(determineFulfillmentStatus(order)).toBe('fulfilled');
  });
  
  it('nessun tracking → usa displayFulfillmentStatus', () => {
    const order = {
      fulfillments: [],
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED'
    };
    expect(determineFulfillmentStatus(order)).toBe('PARTIALLY_FULFILLED');
  });
  
  it('nessun fulfillment → null', () => {
    const order = {
      fulfillments: null,
      displayFulfillmentStatus: null
    };
    expect(determineFulfillmentStatus(order)).toBeNull();
  });
});

describe('calculateTotalWeight', () => {
  it('somma pesi variant: (2kg × 1) + (0.5kg × 3) = 3.5kg', () => {
    const items = [
      { variant: { weight: 2, weightUnit: 'KILOGRAMS' }, quantity: 1 },
      { variant: { weight: 500, weightUnit: 'GRAMS' }, quantity: 3 }
    ];
    expect(calculateTotalWeight(items)).toBe(3.5);
  });
  
  it('conversione grammi: 1500g × 2 = 3kg', () => {
    const items = [
      { variant: { weight: 1500, weightUnit: 'GRAMS' }, quantity: 2 }
    ];
    expect(calculateTotalWeight(items)).toBe(3);
  });
  
  it('peso mancante con default: (null × 2) + (1kg × 1) = 1.4kg', () => {
    const items = [
      { variant: { weight: null }, quantity: 2 },
      { variant: { weight: 1, weightUnit: 'KILOGRAMS' }, quantity: 1 }
    ];
    expect(calculateTotalWeight(items, 0.2)).toBe(1.4);
  });
  
  it('tutti pesi mancanti senza default → null', () => {
    const items = [
      { variant: { weight: null }, quantity: 2 }
    ];
    expect(calculateTotalWeight(items)).toBeNull();
  });
});

describe('determinePackagingCategory', () => {
  const rules = [
    { weight_max: 1, category: 'Busta' },
    { weight_max: 5, category: 'Box S' },
    { weight_max: null, category: 'Box L' }
  ];
  
  it('metafield presente → usa quello', () => {
    expect(determinePackagingCategory('Custom', 10, rules)).toBe('Custom');
  });
  
  it('applica regole: 0.8kg → Busta', () => {
    expect(determinePackagingCategory(undefined, 0.8, rules)).toBe('Busta');
  });
  
  it('applica regole: 3kg → Box S', () => {
    expect(determinePackagingCategory(undefined, 3, rules)).toBe('Box S');
  });
  
  it('applica regole: 10kg → Box L (catch-all)', () => {
    expect(determinePackagingCategory(undefined, 10, rules)).toBe('Box L');
  });
  
  it('nessun peso → null', () => {
    expect(determinePackagingCategory(undefined, null, rules)).toBeNull();
  });
});
```

- [ ] **Step 4: Run test per fallimento**

Run: `npm test order-helpers.test.ts`  
Expected: FAIL "Cannot find module"

- [ ] **Step 5: Implementa helpers**

```typescript
// app/lib/shipping/order-helpers.ts
import type { FallbackRule } from './types';

interface GqlFulfillment {
  trackingInfo?: {
    number?: string;
  } | null;
}

interface GqlOrder {
  fulfillments?: GqlFulfillment[] | null;
  displayFulfillmentStatus?: string | null;
}

interface GqlVariant {
  weight?: number | null;
  weightUnit?: 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES';
}

interface GqlLineItem {
  variant?: GqlVariant | null;
  quantity: number;
}

export function determineFulfillmentStatus(order: GqlOrder): string | null {
  // Se ha tracking number → fulfilled
  const hasTracking = order.fulfillments?.some(f => f.trackingInfo?.number);
  if (hasTracking) return 'fulfilled';
  
  return order.displayFulfillmentStatus || null;
}

export function calculateTotalWeight(
  lineItems: GqlLineItem[],
  defaultPerItem?: number
): number | null {
  let total = 0;
  let hasMissing = false;
  
  for (const item of lineItems) {
    const variant = item.variant;
    
    if (variant?.weight != null) {
      // Converti a kg
      let weightKg = variant.weight;
      
      if (variant.weightUnit === 'GRAMS') {
        weightKg = variant.weight / 1000;
      } else if (variant.weightUnit === 'POUNDS') {
        weightKg = variant.weight * 0.453592;
      } else if (variant.weightUnit === 'OUNCES') {
        weightKg = variant.weight * 0.0283495;
      }
      
      total += weightKg * item.quantity;
    } else {
      hasMissing = true;
      if (defaultPerItem) {
        total += defaultPerItem * item.quantity;
      }
    }
  }
  
  // Se tutti mancanti e nessun default → NULL
  if (hasMissing && !defaultPerItem && total === 0) {
    return null;
  }
  
  return total;
}

export function determinePackagingCategory(
  metafieldValue: string | undefined,
  totalWeight: number | null | undefined,
  fallbackRules: FallbackRule[] | undefined
): string | null {
  // 1. Metafield ha priorità
  if (metafieldValue) return metafieldValue;
  
  // 2. Applica fallback rules su peso
  if (totalWeight != null && fallbackRules) {
    for (const rule of fallbackRules) {
      if (rule.weight_max === null || totalWeight <= rule.weight_max) {
        return rule.category;
      }
    }
  }
  
  // 3. Nessun match
  return null;
}
```

- [ ] **Step 6: Run test per successo**

Run: `npm test order-helpers.test.ts`  
Expected: PASS

- [ ] **Step 7: Estendi GraphQL query**

```typescript
// app/lib/shopify-api.server.ts

// Modifica orderNodeFields (riga ~262):
function orderNodeFields(lineItemsFirst: number): string {
  return `
    id name createdAt updatedAt cancelledAt
    displayFinancialStatus
    displayFulfillmentStatus
    fulfillments { 
      trackingInfo { number } 
    }
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    customer { id firstName lastName }
    shippingAddress { 
      countryCodeV2 
    }
    totalWeight
    refunds { 
      createdAt 
    }
    metafield(namespace: "custom", key: "packaging_category") { 
      value 
    }
    lineItems(first: ${lineItemsFirst}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title quantity currentQuantity
        product { id }
        variant { 
          id 
          weight 
          weightUnit 
        }
        priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
        discountedUnitPriceSet { shopMoney { amount } }
        originalUnitPriceSet { shopMoney { amount } }
        totalDiscountSet { shopMoney { amount } }
      }
    }
  `;
}
```

- [ ] **Step 8: Modifica mapping ordini**

```typescript
// app/lib/shopify-api.server.ts

// Trova la funzione mapOrderWithAllLines (riga ~1392) e aggiungi:
import {
  determineFulfillmentStatus,
  calculateTotalWeight,
  determinePackagingCategory
} from './shipping/order-helpers';

// All'interno di mapOrderWithAllLines, dopo gli altri campi:
const orderRow: OrderRow = {
  // ... campi esistenti ...
  
  // ◄── AGGIUNGI QUESTI:
  fulfillment_status: determineFulfillmentStatus(order),
  shipping_country_code: order.shippingAddress?.countryCodeV2 || null,
  total_weight: calculateTotalWeight(
    order.lineItems.nodes,
    packagingConfig?.defaultWeightPerItem
  ),
  returned_at: order.refunds?.[0]?.createdAt 
    ? new Date(order.refunds[0].createdAt) 
    : null,
  packaging_category: determinePackagingCategory(
    order.metafield?.value,
    calculateTotalWeight(order.lineItems.nodes, packagingConfig?.defaultWeightPerItem),
    packagingConfig?.fallbackRules
  )
};
```

Nota: `packagingConfig` dovrà essere passato come parametro a `mapOrderWithAllLines` da dove viene chiamato (nel loader sync).

- [ ] **Step 9: Commit**

```bash
git add app/lib/supabase-schema.ts app/lib/supabase/merchant-migrations.ts app/lib/shopify-api.server.ts app/lib/shipping/order-helpers.ts app/lib/shipping/order-helpers.test.ts
git commit -m "feat(shipping): extend orders with shipping data fields

- Add 5 columns to orders: fulfillment_status, shipping_country_code, total_weight, returned_at, packaging_category
- Bump schema version to 12
- Extend GraphQL query with fulfillment, shipping, weight, refunds
- Helpers: fulfillment status, weight calculation, packaging fallback
- Test coverage for all helpers

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM"
```

---

## Task 4: Calcolo Costi Spedizione

**Files:**
- Create: `app/lib/shipping/calculate-cost.server.ts`
- Create: `app/lib/shipping/calculate-cost.server.test.ts`
- Create: `app/lib/shipping/get-config.server.ts`

**Interfaces:**
- Consumes: `Zone`, `PackagingConfig`, `ShippingCostBreakdown`, `OrderShippingData` from Task 1
- Produces:
  - `calculateShippingCost(shopId: string, order: OrderShippingData): Promise<ShippingCostBreakdown>`
  - `getShippingConfig(shopId: string): Promise<ShippingConfigComplete | null>` (cached)

- [ ] **Step 1: Scrivi test calcolo costi**

```typescript
// app/lib/shipping/calculate-cost.server.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '~/db.server';
import { calculateShippingCost } from './calculate-cost.server';

const SHOP_ID = 'test-shop-calc';

async function setupConfig() {
  // Zona IT linear €2/kg
  const zoneIT = await prisma.shippingZone.create({
    data: {
      shopId: SHOP_ID,
      zoneName: 'Italia',
      countries: ['IT'],
      rateType: 'linear'
    }
  });
  
  await prisma.shippingRate.create({
    data: {
      zoneId: zoneIT.id,
      weightFrom: null,
      weightTo: null,
      costPerKg: 2
    }
  });
  
  // Zona UE brackets
  const zoneEU = await prisma.shippingZone.create({
    data: {
      shopId: SHOP_ID,
      zoneName: 'UE',
      countries: ['FR', 'DE', 'BE'],
      rateType: 'brackets'
    }
  });
  
  await prisma.shippingRate.createMany({
    data: [
      { zoneId: zoneEU.id, weightFrom: 0, weightTo: 1, costPerKg: 5 },
      { zoneId: zoneEU.id, weightFrom: 1, weightTo: 5, costPerKg: 8 },
      { zoneId: zoneEU.id, weightFrom: 5, weightTo: null, costPerKg: 15 }
    ]
  });
  
  // Packaging
  await prisma.packagingConfig.create({
    data: {
      shopId: SHOP_ID,
      categories: [
        { name: 'Busta', cost: 1.5 },
        { name: 'Box', cost: 3 }
      ],
      fallbackRules: [],
      returnCost: 5
    }
  });
}

beforeEach(async () => {
  await prisma.shippingRate.deleteMany();
  await prisma.shippingZone.deleteMany({ where: { shopId: SHOP_ID } });
  await prisma.packagingConfig.deleteMany({ where: { shopId: SHOP_ID } });
});

describe('calculateShippingCost', () => {
  it('tariffa lineare: 3kg × €2/kg = €6', async () => {
    await setupConfig();
    
    const cost = await calculateShippingCost(SHOP_ID, {
      shipping_country_code: 'IT',
      total_weight: 3,
      packaging_category: null,
      returned_at: null
    });
    
    expect(cost).toEqual({
      shipping: 6,
      packaging: 0,
      return: 0,
      total: 6
    });
  });
  
  it('tariffa a fasce: 4kg in UE = €8 (fascia 1-5kg)', async () => {
    await setupConfig();
    
    const cost = await calculateShippingCost(SHOP_ID, {
      shipping_country_code: 'FR',
      total_weight: 4,
      packaging_category: null,
      returned_at: null
    });
    
    expect(cost).toEqual({
      shipping: 8,
      packaging: 0,
      return: 0,
      total: 8
    });
  });
  
  it('packaging + spedizione + rientro: somma', async () => {
    await setupConfig();
    
    const cost = await calculateShippingCost(SHOP_ID, {
      shipping_country_code: 'IT',
      total_weight: 2,              // €4 (2kg × €2)
      packaging_category: 'Box',    // €3
      returned_at: new Date()       // €5
    });
    
    expect(cost).toEqual({
      shipping: 4,
      packaging: 3,
      return: 5,
      total: 12
    });
  });
  
  it('paese non in zona: costo 0', async () => {
    await setupConfig();
    
    const cost = await calculateShippingCost(SHOP_ID, {
      shipping_country_code: 'ZZ',  // non esiste
      total_weight: 5,
      packaging_category: null,
      returned_at: null
    });
    
    expect(cost.total).toBe(0);
  });
  
  it('peso NULL: costo spedizione 0', async () => {
    await setupConfig();
    
    const cost = await calculateShippingCost(SHOP_ID, {
      shipping_country_code: 'IT',
      total_weight: null,
      packaging_category: null,
      returned_at: null
    });
    
    expect(cost.shipping).toBe(0);
  });
  
  it('config non esistente: tutto 0', async () => {
    const cost = await calculateShippingCost('shop-senza-config', {
      shipping_country_code: 'IT',
      total_weight: 5,
      packaging_category: null,
      returned_at: null
    });
    
    expect(cost.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run test per fallimento**

Run: `npm test calculate-cost.server.test.ts`  
Expected: FAIL "Cannot find module"

- [ ] **Step 3: Implementa get-config (con cache)**

```typescript
// app/lib/shipping/get-config.server.ts
import { LRUCache } from 'lru-cache';
import { prisma } from '~/db.server';
import type { Zone, PackagingConfig } from './types';

interface ShippingConfigComplete {
  zones: Zone[];
  packaging: PackagingConfig | null;
}

const configCache = new LRUCache<string, ShippingConfigComplete>({
  max: 100,
  ttl: 5 * 60 * 1000 // 5 minuti
});

export async function getShippingConfig(
  shopId: string
): Promise<ShippingConfigComplete | null> {
  // Check cache
  const cached = configCache.get(shopId);
  if (cached) return cached;
  
  // Load from DB
  const zones = await prisma.shippingZone.findMany({
    where: { shopId },
    include: { rates: true }
  });
  
  const packaging = await prisma.packagingConfig.findUnique({
    where: { shopId }
  });
  
  if (zones.length === 0 && !packaging) {
    return null; // Nessuna config
  }
  
  const config: ShippingConfigComplete = {
    zones: zones.map(z => ({
      ...z,
      rates: z.rates.map(r => ({
        ...r,
        weightFrom: r.weightFrom ? Number(r.weightFrom) : null,
        weightTo: r.weightTo ? Number(r.weightTo) : null,
        costPerKg: Number(r.costPerKg)
      }))
    })),
    packaging: packaging ? {
      ...packaging,
      defaultWeightPerItem: packaging.defaultWeightPerItem 
        ? Number(packaging.defaultWeightPerItem) 
        : null,
      returnCost: packaging.returnCost 
        ? Number(packaging.returnCost) 
        : null
    } : null
  };
  
  configCache.set(shopId, config);
  return config;
}

export function invalidateConfigCache(shopId: string) {
  configCache.delete(shopId);
}
```

- [ ] **Step 4: Implementa calcolo costi**

```typescript
// app/lib/shipping/calculate-cost.server.ts
import type { 
  ShippingCostBreakdown, 
  OrderShippingData,
  Zone,
  ShippingRate
} from './types';
import { getShippingConfig } from './get-config.server';

export async function calculateShippingCost(
  shopId: string,
  order: OrderShippingData
): Promise<ShippingCostBreakdown> {
  const config = await getShippingConfig(shopId);
  
  if (!config) {
    return { shipping: 0, packaging: 0, return: 0, total: 0 };
  }
  
  let shipping = 0;
  let packaging = 0;
  let returnCost = 0;
  
  // 1. Costo spedizione (peso × zona)
  if (order.shipping_country_code && order.total_weight) {
    const zone = findZoneByCountry(
      config.zones, 
      order.shipping_country_code
    );
    
    if (zone) {
      shipping = zone.rateType === 'linear'
        ? calculateLinearCost(zone, order.total_weight)
        : calculateBracketCost(zone, order.total_weight);
    }
  }
  
  // 2. Costo packaging
  if (order.packaging_category && config.packaging) {
    const cat = config.packaging.categories.find(
      c => c.name === order.packaging_category
    );
    if (cat) packaging = cat.cost;
  }
  
  // 3. Costo rientro
  if (order.returned_at && config.packaging?.returnCost) {
    returnCost = config.packaging.returnCost;
  }
  
  return {
    shipping,
    packaging,
    return: returnCost,
    total: shipping + packaging + returnCost
  };
}

function findZoneByCountry(
  zones: Zone[], 
  countryCode: string
): Zone | null {
  return zones.find(z => z.countries.includes(countryCode)) || null;
}

function calculateLinearCost(zone: Zone, weight: number): number {
  // Linear: primo rate ha cost_per_kg
  return zone.rates[0].costPerKg * weight;
}

function calculateBracketCost(zone: Zone, weight: number): number {
  const bracket = zone.rates.find(r => 
    weight >= (r.weightFrom ?? 0) && 
    (r.weightTo === null || weight < r.weightTo)
  );
  
  return bracket?.costPerKg ?? 0;
}
```

- [ ] **Step 5: Run test per successo**

Run: `npm test calculate-cost.server.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/lib/shipping/calculate-cost.server.ts app/lib/shipping/calculate-cost.server.test.ts app/lib/shipping/get-config.server.ts
git commit -m "feat(shipping): implement cost calculation engine

- LRU cache for shipping config (5min TTL)
- Calculate cost: linear rates, bracket rates, packaging, returns
- Find zone by country
- Test coverage: all rate types, edge cases, missing data

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM"
```

---

## Task 5: Integrazione Calcolo Profitto

**Files:**
- Modify: `app/lib/customers/net-contribution.ts`
- Modify: `app/lib/customers/net-contribution.test.ts`

**Interfaces:**
- Consumes: `calculateShippingCost` from Task 4
- Produces: Extended `NetContribution` type with `shippingCost` field

- [ ] **Step 1: Aggiungi test integrazione**

```typescript
// app/lib/customers/net-contribution.test.ts

// Aggiungi all'inizio:
import { prisma } from '~/db.server';

// Aggiungi alla fine:
describe('calculateNetContribution con shipping costs', () => {
  const SHOP_ID = 'test-shop-contrib';
  const CUSTOMER_ID = 'test-customer';
  
  beforeEach(async () => {
    // Setup: zona IT €2/kg, packaging Box €3
    const zone = await prisma.shippingZone.create({
      data: {
        shopId: SHOP_ID,
        zoneName: 'Italia',
        countries: ['IT'],
        rateType: 'linear'
      }
    });
    
    await prisma.shippingRate.create({
      data: {
        zoneId: zone.id,
        costPerKg: 2
      }
    });
    
    await prisma.packagingConfig.create({
      data: {
        shopId: SHOP_ID,
        categories: [{ name: 'Box', cost: 3 }],
        fallbackRules: [],
        returnCost: 5
      }
    });
  });
  
  afterEach(async () => {
    await prisma.shippingRate.deleteMany();
    await prisma.shippingZone.deleteMany({ where: { shopId: SHOP_ID } });
    await prisma.packagingConfig.deleteMany({ where: { shopId: SHOP_ID } });
  });
  
  it('integra costi spedizione nel profitto', async () => {
    const orders = [{
      id: 'ord-1',
      total_price: 100,
      cancelled_at: null,
      shipping_country_code: 'IT',
      total_weight: 2,              // €4 shipping (2kg × €2)
      packaging_category: 'Box',    // €3 packaging
      returned_at: null,
      lines: [
        { unit_cost_at_sale: 20, quantity: 2 } // €40 product cost
      ]
    }];
    
    const contrib = await calculateNetContribution(SHOP_ID, CUSTOMER_ID, orders);
    
    expect(contrib).toMatchObject({
      revenue: 100,
      productCost: 40,
      shippingCost: 7,  // €4 + €3
      profit: 53,       // €100 - €40 - €7
      margin: 53
    });
  });
  
  it('ordine con reso: aggiunge costo rientro', async () => {
    const orders = [{
      id: 'ord-2',
      total_price: 50,
      cancelled_at: null,
      shipping_country_code: 'IT',
      total_weight: 1,              // €2 shipping
      packaging_category: null,
      returned_at: new Date(),      // €5 return
      lines: [
        { unit_cost_at_sale: 10, quantity: 1 }
      ]
    }];
    
    const contrib = await calculateNetContribution(SHOP_ID, CUSTOMER_ID, orders);
    
    expect(contrib.shippingCost).toBe(7); // €2 + €5
    expect(contrib.profit).toBe(33);      // €50 - €10 - €7
  });
  
  it('ordine annullato: non conta costi spedizione', async () => {
    const orders = [{
      id: 'ord-3',
      total_price: 100,
      cancelled_at: new Date(),     // ◄── annullato
      shipping_country_code: 'IT',
      total_weight: 5,
      packaging_category: 'Box',
      returned_at: null,
      lines: []
    }];
    
    const contrib = await calculateNetContribution(SHOP_ID, CUSTOMER_ID, orders);
    
    expect(contrib.shippingCost).toBe(0); // ordine skip
  });
});
```

- [ ] **Step 2: Run test per fallimento**

Run: `npm test net-contribution.test.ts`  
Expected: FAIL "Property 'shippingCost' does not exist"

- [ ] **Step 3: Modifica tipo NetContribution**

```typescript
// app/lib/customers/net-contribution.ts

export interface NetContribution {
  revenue: number;
  productCost: number;
  shippingCost: number; // ◄── AGGIUNGI
  profit: number;
  margin: number;
}
```

- [ ] **Step 4: Integra calcolo spedizione**

```typescript
// app/lib/customers/net-contribution.ts

// Aggiungi import:
import { calculateShippingCost } from '~/lib/shipping/calculate-cost.server';

// Modifica calculateNetContribution:
export async function calculateNetContribution(
  shopId: string,
  customerId: string,
  orders: OrderWithLines[]
): Promise<NetContribution> {
  let totalRevenue = 0;
  let totalProductCost = 0;
  let totalShippingCost = 0; // ◄── AGGIUNGI
  
  for (const order of orders) {
    // Skip ordini annullati
    if (order.cancelled_at) continue;
    
    totalRevenue += order.total_price;
    
    // Costo prodotti
    for (const line of order.lines) {
      const unitCost = line.unit_cost_at_sale ?? 0;
      totalProductCost += unitCost * line.quantity;
    }
    
    // ◄── AGGIUNGI: Costo spedizione
    const shippingCost = await calculateShippingCost(shopId, {
      shipping_country_code: order.shipping_country_code,
      total_weight: order.total_weight,
      packaging_category: order.packaging_category,
      returned_at: order.returned_at
    });
    totalShippingCost += shippingCost.total;
  }
  
  const profit = totalRevenue - totalProductCost - totalShippingCost;
  
  return {
    revenue: totalRevenue,
    productCost: totalProductCost,
    shippingCost: totalShippingCost, // ◄── AGGIUNGI
    profit,
    margin: totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0
  };
}
```

- [ ] **Step 5: Run test per successo**

Run: `npm test net-contribution.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/lib/customers/net-contribution.ts app/lib/customers/net-contribution.test.ts
git commit -m "feat(shipping): integrate shipping costs into profit calculation

- Add shippingCost field to NetContribution
- Calculate shipping cost per order in loop
- Skip shipping costs for cancelled orders
- Test coverage: profit with shipping, returns, cancellations

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM"
```

---

## Task 6: UI Base - Route e Tabella Zone

**Files:**
- Create: `app/routes/spedizioni.tsx`
- Create: `app/components/Shipping/ShippingZonesTable.tsx`
- Modify: `app/components/Navigation.tsx`

**Interfaces:**
- Consumes: `syncShippingZones` from Task 2
- Produces: `/spedizioni` route with zones table

- [ ] **Step 1: Aggiungi link navigazione**

```tsx
// app/components/Navigation.tsx

// Trova l'array di nav items e aggiungi:
const navItems = [
  { label: 'Dashboard', url: '/' },
  { label: 'Prodotti', url: '/products' },
  { label: 'Clienti', url: '/customers' },
  { label: 'Spedizioni', url: '/spedizioni' }, // ◄── AGGIUNGI
  { label: 'Impostazioni', url: '/settings/supabase' }
];
```

- [ ] **Step 2: Crea route base**

```tsx
// app/routes/spedizioni.tsx
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from '@remix-run/node';
import { useLoaderData, useFetcher } from '@remix-run/react';
import { Page, Layout, Card, EmptyState, Button, Toast, Frame } from '@shopify/polaris';
import { useState } from 'react';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { syncShippingZones } from '~/lib/shipping/sync-zones.server';
import { ShippingZonesTable } from '~/components/Shipping/ShippingZonesTable';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  
  const zones = await prisma.shippingZone.findMany({
    where: { shopId },
    include: { rates: true },
    orderBy: { zoneName: 'asc' }
  });
  
  return json({ zones });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  
  const formData = await request.formData();
  const intent = formData.get('intent');
  
  if (intent === 'sync-zones') {
    const result = await syncShippingZones(shopId);
    return json({ 
      success: true, 
      message: `${result.added} zone aggiunte, ${result.updated} aggiornate` 
    });
  }
  
  return json({ success: false, message: 'Intent non riconosciuto' });
}

export default function SpedizioniPage() {
  const { zones } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [toastActive, setToastActive] = useState(false);
  
  const handleSyncZones = () => {
    fetcher.submit({ intent: 'sync-zones' }, { method: 'post' });
  };
  
  // Show toast on success
  if (fetcher.data?.success && !toastActive) {
    setToastActive(true);
  }
  
  return (
    <Frame>
      <Page
        title="Costi di Spedizione"
        primaryAction={{
          content: 'Aggiorna zone da Shopify',
          onAction: handleSyncZones,
          loading: fetcher.state !== 'idle'
        }}
      >
        {zones.length === 0 ? (
          <Card>
            <EmptyState
              heading="Nessuna zona configurata"
              action={{
                content: 'Importa zone da Shopify',
                onAction: handleSyncZones
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                Importa le zone di spedizione configurate in Shopify per
                iniziare a gestire i costi logistici.
              </p>
            </EmptyState>
          </Card>
        ) : (
          <Layout>
            <Layout.Section>
              <Card>
                <ShippingZonesTable zones={zones} />
              </Card>
            </Layout.Section>
          </Layout>
        )}
      </Page>
      
      {toastActive && fetcher.data && (
        <Toast
          content={fetcher.data.message}
          onDismiss={() => setToastActive(false)}
        />
      )}
    </Frame>
  );
}
```

- [ ] **Step 3: Crea componente tabella**

```tsx
// app/components/Shipping/ShippingZonesTable.tsx
import { DataTable, Text, InlineStack, Button } from '@shopify/polaris';
import type { Zone } from '~/lib/shipping/types';

interface Props {
  zones: Zone[];
}

export function ShippingZonesTable({ zones }: Props) {
  const rows = zones.map(zone => {
    const countriesDisplay = zone.countries.length > 3
      ? `${zone.countries.slice(0, 3).join(', ')}...`
      : zone.countries.join(', ');
    
    const rateTypeDisplay = zone.rateType === 'linear' 
      ? 'Lineare (€/kg)' 
      : 'Fasce peso';
    
    const costDisplay = getIndicativeCost(zone);
    
    return [
      <Text as="span" fontWeight="semibold">{zone.zoneName}</Text>,
      countriesDisplay,
      rateTypeDisplay,
      costDisplay,
      <InlineStack gap="200">
        <Button size="slim">Modifica</Button>
      </InlineStack>
    ];
  });
  
  return (
    <DataTable
      columnContentTypes={['text', 'text', 'text', 'text', 'text']}
      headings={[
        'Zona',
        'Paesi',
        'Tipo tariffa',
        'Costo indicativo',
        'Azioni'
      ]}
      rows={rows}
    />
  );
}

function getIndicativeCost(zone: Zone): string {
  if (zone.rates.length === 0) {
    return '—';
  }
  
  if (zone.rateType === 'linear') {
    return `€${zone.rates[0].costPerKg.toFixed(2)}/kg`;
  }
  
  // Brackets: mostra range
  const costs = zone.rates.map(r => r.costPerKg);
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  return `€${min.toFixed(2)} - €${max.toFixed(2)}`;
}
```

- [ ] **Step 4: Test manuale**

1. Avvia app: `npm run dev`
2. Naviga a `/spedizioni`
3. Verifica empty state
4. Click "Importa zone da Shopify"
5. Verifica tabella popolata con zone
6. Verifica toast "X zone aggiunte, Y aggiornate"

- [ ] **Step 5: Commit**

```bash
git add app/routes/spedizioni.tsx app/components/Shipping/ShippingZonesTable.tsx app/components/Navigation.tsx
git commit -m "feat(shipping): add /spedizioni route with zones table

- New route with sync action
- ShippingZonesTable component: display zones, countries, rate type
- Empty state for first visit
- Toast notification on sync
- Navigation link added

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM"
```

---

## Task 7: UI Modal Configurazione Tariffa

**Files:**
- Create: `app/components/Shipping/EditZoneModal.tsx`
- Create: `app/components/Shipping/BracketsEditor.tsx`
- Modify: `app/routes/spedizioni.tsx` (add modal + action)

**Interfaces:**
- Consumes: Zone type, invalidateConfigCache from Task 4
- Produces: Modal UI for editing zone rates

- [ ] **Step 1: Crea BracketsEditor**

```tsx
// app/components/Shipping/BracketsEditor.tsx
import { BlockStack, InlineStack, TextField, Button, InlineError } from '@shopify/polaris';
import { DeleteIcon } from '@shopify/polaris-icons';
import type { ShippingRate } from '~/lib/shipping/types';

interface Bracket {
  weightFrom: number;
  weightTo: number | null;
  cost: number;
}

interface Props {
  brackets: Bracket[];
  onChange: (brackets: Bracket[]) => void;
}

export function BracketsEditor({ brackets, onChange }: Props) {
  const addBracket = () => {
    const lastBracket = brackets[brackets.length - 1];
    const newFrom = lastBracket.weightTo ?? lastBracket.weightFrom + 1;
    
    onChange([
      ...brackets.slice(0, -1), // Rimuovi ultimo (aveva to: null)
      { ...lastBracket, weightTo: newFrom }, // Chiudi precedente
      { weightFrom: newFrom, weightTo: null, cost: 0 } // Nuovo catch-all
    ]);
  };
  
  const removeBracket = (idx: number) => {
    if (brackets.length === 1) return; // Almeno una fascia
    
    const newBrackets = brackets.filter((_, i) => i !== idx);
    // Ultimo deve avere weightTo: null
    newBrackets[newBrackets.length - 1].weightTo = null;
    onChange(newBrackets);
  };
  
  const updateBracket = (idx: number, field: keyof Bracket, value: any) => {
    const updated = [...brackets];
    updated[idx] = { ...updated[idx], [field]: value };
    onChange(updated);
  };
  
  const validationError = validateBrackets(brackets);
  
  return (
    <BlockStack gap="400">
      {brackets.map((bracket, idx) => (
        <InlineStack key={idx} gap="200" blockAlign="center">
          <TextField
            label="Da (kg)"
            type="number"
            value={String(bracket.weightFrom)}
            onChange={(val) => updateBracket(idx, 'weightFrom', Number(val))}
            autoComplete="off"
            min="0"
            step="0.1"
          />
          <TextField
            label="A (kg)"
            type="number"
            value={bracket.weightTo === null ? '' : String(bracket.weightTo)}
            onChange={(val) => updateBracket(idx, 'weightTo', val ? Number(val) : null)}
            placeholder="∞"
            autoComplete="off"
            disabled={idx === brackets.length - 1} // Ultimo sempre infinito
            min="0"
            step="0.1"
          />
          <TextField
            label="Costo (€)"
            type="number"
            value={String(bracket.cost)}
            onChange={(val) => updateBracket(idx, 'cost', Number(val))}
            suffix="€"
            autoComplete="off"
            min="0"
            step="0.01"
          />
          <Button
            icon={DeleteIcon}
            onClick={() => removeBracket(idx)}
            disabled={brackets.length === 1}
            accessibilityLabel="Rimuovi fascia"
          />
        </InlineStack>
      ))}
      
      <Button onClick={addBracket}>Aggiungi fascia</Button>
      
      {validationError && <InlineError message={validationError} fieldID="" />}
    </BlockStack>
  );
}

function validateBrackets(brackets: Bracket[]): string | null {
  // Prima fascia deve partire da 0
  if (brackets[0].weightFrom !== 0) {
    return 'La prima fascia deve partire da 0 kg';
  }
  
  // Nessun gap tra fasce
  for (let i = 0; i < brackets.length - 1; i++) {
    const current = brackets[i];
    const next = brackets[i + 1];
    
    if (current.weightTo === null) {
      return `La fascia ${i + 1} non può avere limite superiore infinito (solo l'ultima)`;
    }
    
    if (current.weightTo !== next.weightFrom) {
      return `Gap tra fascia ${i + 1} e ${i + 2}: ${current.weightTo}kg → ${next.weightFrom}kg`;
    }
  }
  
  // Ultima fascia deve essere infinita
  const last = brackets[brackets.length - 1];
  if (last.weightTo !== null) {
    return 'L\'ultima fascia deve coprire fino a infinito (campo "A" vuoto)';
  }
  
  return null;
}
```

- [ ] **Step 2: Crea EditZoneModal**

```tsx
// app/components/Shipping/EditZoneModal.tsx
import { Modal, FormLayout, ChoiceList, TextField, Text, TextContainer } from '@shopify/polaris';
import { useState, useEffect } from 'react';
import { useFetcher } from '@remix-run/react';
import { BracketsEditor } from './BracketsEditor';
import type { Zone } from '~/lib/shipping/types';

interface Props {
  zone: Zone | null;
  onClose: () => void;
}

export function EditZoneModal({ zone, onClose }: Props) {
  const fetcher = useFetcher();
  const [rateType, setRateType] = useState<'linear' | 'brackets'>(zone?.rateType || 'linear');
  const [costPerKg, setCostPerKg] = useState('');
  const [brackets, setBrackets] = useState<any[]>([]);
  
  useEffect(() => {
    if (!zone) return;
    
    setRateType(zone.rateType);
    
    if (zone.rateType === 'linear' && zone.rates[0]) {
      setCostPerKg(String(zone.rates[0].costPerKg));
    } else if (zone.rateType === 'brackets') {
      setBrackets(zone.rates.map(r => ({
        weightFrom: r.weightFrom ?? 0,
        weightTo: r.weightTo,
        cost: r.costPerKg
      })));
    }
  }, [zone]);
  
  const handleSave = () => {
    if (!zone) return;
    
    const formData = new FormData();
    formData.set('intent', 'save-zone-rates');
    formData.set('zoneId', zone.id);
    formData.set('rateType', rateType);
    
    if (rateType === 'linear') {
      formData.set('costPerKg', costPerKg);
    } else {
      formData.set('brackets', JSON.stringify(brackets));
    }
    
    fetcher.submit(formData, { method: 'post' });
  };
  
  // Close on success
  useEffect(() => {
    if (fetcher.data?.success) {
      onClose();
    }
  }, [fetcher.data]);
  
  return (
    <Modal
      open={!!zone}
      onClose={onClose}
      title={zone ? `Tariffa spedizione: ${zone.zoneName}` : ''}
      primaryAction={{
        content: 'Salva',
        onAction: handleSave,
        loading: fetcher.state !== 'idle'
      }}
      secondaryActions={[
        {
          content: 'Annulla',
          onAction: onClose
        }
      ]}
    >
      {zone && (
        <Modal.Section>
          <FormLayout>
            <TextContainer>
              <Text as="p" variant="bodyMd">
                Paesi: {zone.countries.join(', ')}
              </Text>
            </TextContainer>
            
            <ChoiceList
              title="Tipo tariffa"
              choices={[
                { label: 'Lineare (€ per kg)', value: 'linear' },
                { label: 'Fasce di peso', value: 'brackets' }
              ]}
              selected={[rateType]}
              onChange={([value]) => setRateType(value as any)}
            />
            
            {rateType === 'linear' && (
              <TextField
                label="Costo per kg (€)"
                type="number"
                value={costPerKg}
                onChange={setCostPerKg}
                suffix="€/kg"
                autoComplete="off"
                min="0"
                step="0.01"
              />
            )}
            
            {rateType === 'brackets' && (
              <BracketsEditor 
                brackets={brackets}
                onChange={setBrackets}
              />
            )}
          </FormLayout>
        </Modal.Section>
      )}
    </Modal>
  );
}
```

- [ ] **Step 3: Integra modal in route**

```tsx
// app/routes/spedizioni.tsx

// Aggiungi import:
import { EditZoneModal } from '~/components/Shipping/EditZoneModal';
import { invalidateConfigCache } from '~/lib/shipping/get-config.server';

// Modifica action per gestire save-zone-rates:
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  
  const formData = await request.formData();
  const intent = formData.get('intent');
  
  if (intent === 'sync-zones') {
    // ... esistente
  }
  
  if (intent === 'save-zone-rates') {
    const zoneId = formData.get('zoneId') as string;
    const rateType = formData.get('rateType') as 'linear' | 'brackets';
    
    // Delete existing rates
    await prisma.shippingRate.deleteMany({ where: { zoneId } });
    
    // Update zone rateType
    await prisma.shippingZone.update({
      where: { id: zoneId },
      data: { rateType }
    });
    
    if (rateType === 'linear') {
      const costPerKg = Number(formData.get('costPerKg'));
      await prisma.shippingRate.create({
        data: {
          zoneId,
          weightFrom: null,
          weightTo: null,
          costPerKg
        }
      });
    } else {
      const brackets = JSON.parse(formData.get('brackets') as string);
      await prisma.shippingRate.createMany({
        data: brackets.map((b: any) => ({
          zoneId,
          weightFrom: b.weightFrom,
          weightTo: b.weightTo,
          costPerKg: b.cost
        }))
      });
    }
    
    // Invalidate cache
    invalidateConfigCache(shopId);
    
    return json({ success: true, message: 'Tariffa salvata' });
  }
  
  return json({ success: false, message: 'Intent non riconosciuto' });
}

// Nel componente, aggiungi stato modal:
export default function SpedizioniPage() {
  const { zones } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [toastActive, setToastActive] = useState(false);
  const [editingZone, setEditingZone] = useState<Zone | null>(null); // ◄── AGGIUNGI
  
  // ... resto
  
  return (
    <Frame>
      <Page /* ... */>
        {/* ... */}
        {zones.length > 0 && (
          <Layout>
            <Layout.Section>
              <Card>
                <ShippingZonesTable 
                  zones={zones} 
                  onEditZone={setEditingZone} // ◄── PASSA CALLBACK
                />
              </Card>
            </Layout.Section>
          </Layout>
        )}
      </Page>
      
      <EditZoneModal // ◄── AGGIUNGI
        zone={editingZone}
        onClose={() => setEditingZone(null)}
      />
      
      {/* Toast */}
    </Frame>
  );
}
```

- [ ] **Step 4: Aggiorna tabella per aprire modal**

```tsx
// app/components/Shipping/ShippingZonesTable.tsx

interface Props {
  zones: Zone[];
  onEditZone: (zone: Zone) => void; // ◄── AGGIUNGI
}

export function ShippingZonesTable({ zones, onEditZone }: Props) {
  const rows = zones.map(zone => {
    // ...
    
    return [
      // ... colonne esistenti
      <InlineStack gap="200">
        <Button size="slim" onClick={() => onEditZone(zone)}>Modifica</Button>
      </InlineStack>
    ];
  });
  
  // ...
}
```

- [ ] **Step 5: Test manuale**

1. Naviga `/spedizioni`
2. Click "Modifica" su una zona
3. Verifica modal aperto con dati zona
4. Cambia tipo da linear a brackets
5. Aggiungi 2 fasce
6. Salva
7. Riapri modal → verifica fasce salvate

- [ ] **Step 6: Commit**

```bash
git add app/components/Shipping/EditZoneModal.tsx app/components/Shipping/BracketsEditor.tsx app/routes/spedizioni.tsx app/components/Shipping/ShippingZonesTable.tsx
git commit -m "feat(shipping): add zone rate configuration modal

- EditZoneModal: switch linear/brackets, form validation
- BracketsEditor: dynamic bracket list with add/remove
- Validation: no gaps, first starts at 0, last infinite
- Save action: delete old rates, insert new, invalidate cache
- Test: manual verification of modal flow

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM"
```

---

## Task 8: UI Packaging Configuration

**Files:**
- Create: `app/components/Shipping/PackagingCard.tsx`
- Modify: `app/routes/spedizioni.tsx` (add card + action)

**Interfaces:**
- Consumes: PackagingConfig type
- Produces: UI for packaging categories, fallback rules, defaults

- [ ] **Step 1: Crea PackagingCard**

```tsx
// app/components/Shipping/PackagingCard.tsx
import { 
  Card, 
  BlockStack, 
  InlineStack, 
  TextField, 
  Button, 
  Text,
  Select,
  Divider
} from '@shopify/polaris';
import { DeleteIcon } from '@shopify/polaris-icons';
import { useState, useEffect } from 'react';
import { useFetcher } from '@remix-run/react';
import type { PackagingConfig } from '~/lib/shipping/types';

interface Props {
  config: PackagingConfig | null;
}

export function PackagingCard({ config }: Props) {
  const fetcher = useFetcher();
  
  const [categories, setCategories] = useState(config?.categories || [
    { name: '', cost: 0 }
  ]);
  
  const [fallbackRules, setFallbackRules] = useState(config?.fallbackRules || []);
  
  const [defaultWeightPerItem, setDefaultWeightPerItem] = useState(
    config?.defaultWeightPerItem?.toString() || ''
  );
  
  const [returnCost, setReturnCost] = useState(
    config?.returnCost?.toString() || ''
  );
  
  const addCategory = () => {
    setCategories([...categories, { name: '', cost: 0 }]);
  };
  
  const removeCategory = (idx: number) => {
    setCategories(categories.filter((_, i) => i !== idx));
  };
  
  const updateCategory = (idx: number, field: 'name' | 'cost', value: any) => {
    const updated = [...categories];
    updated[idx] = { ...updated[idx], [field]: value };
    setCategories(updated);
  };
  
  const addRule = () => {
    setFallbackRules([...fallbackRules, { weight_max: 1, category: categories[0]?.name || '' }]);
  };
  
  const removeRule = (idx: number) => {
    setFallbackRules(fallbackRules.filter((_, i) => i !== idx));
  };
  
  const updateRule = (idx: number, field: string, value: any) => {
    const updated = [...fallbackRules];
    updated[idx] = { ...updated[idx], [field]: value };
    setFallbackRules(updated);
  };
  
  const handleSave = () => {
    const formData = new FormData();
    formData.set('intent', 'save-packaging-config');
    formData.set('categories', JSON.stringify(categories.filter(c => c.name)));
    formData.set('fallbackRules', JSON.stringify(fallbackRules));
    formData.set('defaultWeightPerItem', defaultWeightPerItem || '');
    formData.set('returnCost', returnCost || '');
    
    fetcher.submit(formData, { method: 'post' });
  };
  
  const categoryOptions = categories
    .filter(c => c.name)
    .map(c => ({ label: c.name, value: c.name }));
  
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Packaging e rientri
        </Text>
        
        {/* Categorie packaging */}
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Categorie imballo
          </Text>
          
          {categories.map((cat, idx) => (
            <InlineStack key={idx} gap="200" blockAlign="center">
              <TextField
                label="Nome"
                value={cat.name}
                onChange={(val) => updateCategory(idx, 'name', val)}
                autoComplete="off"
                labelHidden
                placeholder="es. Busta, Scatola S"
              />
              <TextField
                label="Costo"
                type="number"
                value={String(cat.cost)}
                onChange={(val) => updateCategory(idx, 'cost', Number(val))}
                suffix="€"
                autoComplete="off"
                labelHidden
                min="0"
                step="0.01"
              />
              <Button
                icon={DeleteIcon}
                onClick={() => removeCategory(idx)}
                disabled={categories.length === 1}
                accessibilityLabel="Rimuovi categoria"
              />
            </InlineStack>
          ))}
          
          <Button onClick={addCategory}>Aggiungi categoria</Button>
        </BlockStack>
        
        <Divider />
        
        {/* Regole fallback */}
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Regole fallback (per peso)
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Se Shopify non fornisce la categoria, applica queste regole in base al peso totale
          </Text>
          
          {fallbackRules.map((rule, idx) => (
            <InlineStack key={idx} gap="200" blockAlign="center">
              <TextField
                label="Peso max (kg)"
                type="number"
                value={rule.weight_max === null ? '' : String(rule.weight_max)}
                onChange={(val) => updateRule(idx, 'weight_max', val ? Number(val) : null)}
                placeholder="∞"
                autoComplete="off"
                labelHidden
                min="0"
                step="0.1"
              />
              <Select
                label="Categoria"
                options={categoryOptions}
                value={rule.category}
                onChange={(val) => updateRule(idx, 'category', val)}
                labelHidden
              />
              <Button
                icon={DeleteIcon}
                onClick={() => removeRule(idx)}
                accessibilityLabel="Rimuovi regola"
              />
            </InlineStack>
          ))}
          
          <Button onClick={addRule} disabled={categories.length === 0}>
            Aggiungi regola
          </Button>
        </BlockStack>
        
        <Divider />
        
        {/* Peso default */}
        <TextField
          label="Peso default per articolo (kg)"
          type="number"
          value={defaultWeightPerItem}
          onChange={setDefaultWeightPerItem}
          helpText="Usato quando il prodotto non ha peso configurato in Shopify"
          suffix="kg/articolo"
          autoComplete="off"
          min="0"
          step="0.01"
        />
        
        {/* Costo rientro */}
        <TextField
          label="Costo rientro/reso (€)"
          type="number"
          value={returnCost}
          onChange={setReturnCost}
          helpText="Costo aggiuntivo quando un ordine viene restituito"
          suffix="€"
          autoComplete="off"
          min="0"
          step="0.01"
        />
        
        <Button 
          onClick={handleSave} 
          loading={fetcher.state !== 'idle'}
          variant="primary"
        >
          Salva configurazione
        </Button>
      </BlockStack>
    </Card>
  );
}
```

- [ ] **Step 2: Integra card in route**

```tsx
// app/routes/spedizioni.tsx

// Aggiungi import:
import { PackagingCard } from '~/components/Shipping/PackagingCard';

// Modifica loader per includere packaging:
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  
  const zones = await prisma.shippingZone.findMany({
    where: { shopId },
    include: { rates: true },
    orderBy: { zoneName: 'asc' }
  });
  
  const packaging = await prisma.packagingConfig.findUnique({
    where: { shopId }
  });
  
  return json({ zones, packaging });
}

// Aggiungi action per save-packaging-config:
if (intent === 'save-packaging-config') {
  const categories = JSON.parse(formData.get('categories') as string);
  const fallbackRules = JSON.parse(formData.get('fallbackRules') as string);
  const defaultWeightPerItem = formData.get('defaultWeightPerItem') as string;
  const returnCost = formData.get('returnCost') as string;
  
  await prisma.packagingConfig.upsert({
    where: { shopId },
    create: {
      shopId,
      categories,
      fallbackRules,
      defaultWeightPerItem: defaultWeightPerItem ? Number(defaultWeightPerItem) : null,
      returnCost: returnCost ? Number(returnCost) : null
    },
    update: {
      categories,
      fallbackRules,
      defaultWeightPerItem: defaultWeightPerItem ? Number(defaultWeightPerItem) : null,
      returnCost: returnCost ? Number(returnCost) : null,
      updatedAt: new Date()
    }
  });
  
  invalidateConfigCache(shopId);
  
  return json({ success: true, message: 'Configurazione salvata' });
}

// Nel componente, aggiungi packaging card:
export default function SpedizioniPage() {
  const { zones, packaging } = useLoaderData<typeof loader>();
  
  // ...
  
  return (
    <Frame>
      <Page /* ... */>
        {zones.length > 0 && (
          <Layout>
            <Layout.Section>
              <Card>
                <ShippingZonesTable 
                  zones={zones} 
                  onEditZone={setEditingZone}
                />
              </Card>
            </Layout.Section>
            
            <Layout.Section secondary> {/* ◄── AGGIUNGI */}
              <PackagingCard config={packaging} />
            </Layout.Section>
          </Layout>
        )}
      </Page>
      
      {/* ... */}
    </Frame>
  );
}
```

- [ ] **Step 3: Test manuale**

1. Naviga `/spedizioni`
2. Verifica card packaging a destra
3. Aggiungi categorie: Busta €1.5, Box S €2.5, Box L €4
4. Aggiungi regole: <1kg → Busta, <5kg → Box S, resto → Box L
5. Imposta peso default 0.3 kg
6. Imposta costo rientro €5
7. Salva
8. Ricarica pagina → verifica valori salvati

- [ ] **Step 4: Commit**

```bash
git add app/components/Shipping/PackagingCard.tsx app/routes/spedizioni.tsx
git commit -m "feat(shipping): add packaging configuration card

- PackagingCard: categories, fallback rules, defaults, return cost
- Dynamic add/remove categories and rules
- Save action with upsert logic
- Secondary layout column in /spedizioni
- Test: manual verification of save/load flow

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM"
```

---

## Task 9: Alert Dashboard Peso Mancante

**Files:**
- Create: `app/components/Dashboard/WeightMissingBanner.tsx`
- Modify: `app/routes/_index.tsx` (add banner + dismissal)
- Create SQL: `docs/migrations/2026-09-23-shipping-alert-dismissals.sql`

**Interfaces:**
- Produces: Banner with link to /spedizioni, dismissible

- [ ] **Step 1: Crea SQL dismissal table**

```sql
-- docs/migrations/2026-09-23-shipping-alert-dismissals.sql
-- Execute manually on DB owner

CREATE TABLE shipping_alert_dismissals (
  shop_id TEXT PRIMARY KEY,
  dismissed_at TIMESTAMP DEFAULT NOW()
);
```

- [ ] **Step 2: Aggiungi Prisma model**

```prisma
// prisma/schema.prisma

model ShippingAlertDismissal {
  shopId      String   @id @map("shop_id")
  dismissedAt DateTime @default(now()) @map("dismissed_at")
  
  @@map("shipping_alert_dismissals")
}
```

Run: `npx prisma generate`

- [ ] **Step 3: Crea WeightMissingBanner**

```tsx
// app/components/Dashboard/WeightMissingBanner.tsx
import { Banner, InlineStack, Text, Link } from '@shopify/polaris';
import { useFetcher } from '@remix-run/react';

interface Props {
  ordersWithoutWeight: number;
}

export function WeightMissingBanner({ ordersWithoutWeight }: Props) {
  const fetcher = useFetcher();
  
  const handleDismiss = () => {
    fetcher.submit(
      { intent: 'dismiss-weight-alert' },
      { method: 'post' }
    );
  };
  
  return (
    <Banner
      tone="info"
      onDismiss={handleDismiss}
    >
      <InlineStack gap="200" blockAlign="center">
        <Text as="p">
          {ordersWithoutWeight} {ordersWithoutWeight === 1 ? 'ordine' : 'ordini'} senza peso configurato.
          I costi di spedizione potrebbero essere imprecisi.
        </Text>
        <Link url="/spedizioni">Configura peso di default</Link>
      </InlineStack>
    </Banner>
  );
}
```

- [ ] **Step 4: Integra in dashboard**

```tsx
// app/routes/_index.tsx

// Aggiungi import:
import { WeightMissingBanner } from '~/components/Dashboard/WeightMissingBanner';

// Modifica loader per contare ordini senza peso:
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  
  // ... existing stats ...
  
  // Count orders without weight
  const ordersWithoutWeight = await prisma.$queryRaw`
    SELECT COUNT(*)::int as count
    FROM orders
    WHERE total_weight IS NULL
      AND cancelled_at IS NULL
  `;
  
  // Check if alert dismissed
  const alertDismissed = await prisma.shippingAlertDismissal.findUnique({
    where: { shopId }
  });
  
  return json({
    // ... existing data ...
    ordersWithoutWeight: ordersWithoutWeight[0]?.count || 0,
    weightAlertDismissed: !!alertDismissed
  });
}

// Aggiungi action per dismissal:
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  
  const formData = await request.formData();
  const intent = formData.get('intent');
  
  if (intent === 'dismiss-weight-alert') {
    await prisma.shippingAlertDismissal.upsert({
      where: { shopId },
      create: { shopId },
      update: { dismissedAt: new Date() }
    });
    
    return json({ success: true });
  }
  
  // ... other intents ...
}

// Nel componente, mostra banner:
export default function Index() {
  const { 
    // ... existing
    ordersWithoutWeight,
    weightAlertDismissed
  } = useLoaderData<typeof loader>();
  
  return (
    <Page title="Dashboard">
      <BlockStack gap="400">
        {ordersWithoutWeight > 0 && !weightAlertDismissed && (
          <WeightMissingBanner ordersWithoutWeight={ordersWithoutWeight} />
        )}
        
        {/* ... resto dashboard ... */}
      </BlockStack>
    </Page>
  );
}
```

- [ ] **Step 5: Test manuale**

1. Crea ordine senza peso prodotti in Shopify
2. Sync
3. Naviga dashboard → verifica banner presente
4. Click "Chiudi" (X) → banner scompare
5. Ricarica pagina → banner non ricompare
6. Naviga `/spedizioni` → configura peso default
7. Re-sync ordini
8. Verifica contatore aggiornato

- [ ] **Step 6: Commit**

```bash
git add app/components/Dashboard/WeightMissingBanner.tsx app/routes/_index.tsx prisma/schema.prisma docs/migrations/2026-09-23-shipping-alert-dismissals.sql
git commit -m "feat(shipping): add weight missing alert banner on dashboard

- WeightMissingBanner component with dismissal
- Count orders without total_weight
- ShippingAlertDismissal table for persistence
- Link to /spedizioni for configuration
- Action to dismiss banner

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM"
```

---

## Task 10: E2E Testing

**Files:**
- Create: `tests/e2e/shipping-flow.spec.ts`

**Interfaces:**
- Tests complete shipping flow end-to-end

- [ ] **Step 1: Crea E2E test**

```typescript
// tests/e2e/shipping-flow.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Shipping costs flow', () => {
  test.beforeEach(async ({ page }) => {
    // Login (assume auth già configurato nei test)
    await page.goto('/');
  });
  
  test('configurazione completa e verifica profitto', async ({ page }) => {
    // 1. Naviga /spedizioni
    await page.click('nav >> text=Spedizioni');
    await expect(page).toHaveURL('/spedizioni');
    
    // 2. Sync zone da Shopify
    await page.click('button:has-text("Aggiorna zone da Shopify")');
    await expect(page.locator('text=zone aggiunte')).toBeVisible({ timeout: 10000 });
    
    // 3. Verifica tabella popolata
    await expect(page.locator('table >> text=Italia')).toBeVisible();
    
    // 4. Configura tariffa zona Italia
    const italiaRow = page.locator('table >> tr:has-text("Italia")');
    await italiaRow.locator('button:has-text("Modifica")').click();
    
    await expect(page.locator('role=dialog')).toBeVisible();
    await expect(page.locator('text=Tariffa spedizione: Italia')).toBeVisible();
    
    // 5. Imposta linear €3/kg
    await page.click('text=Lineare (€ per kg)');
    await page.fill('input[type="number"]:near(:text("Costo per kg"))', '3');
    await page.click('button:has-text("Salva")');
    
    // 6. Verifica toast successo
    await expect(page.locator('text=Tariffa salvata')).toBeVisible();
    
    // 7. Configura packaging
    const packagingCard = page.locator('text=Packaging e rientri').locator('..');
    await packagingCard.locator('input').first().fill('Busta');
    await packagingCard.locator('input[type="number"]').first().fill('2');
    await packagingCard.locator('button:has-text("Salva configurazione")').click();
    
    await expect(page.locator('text=Configurazione salvata')).toBeVisible();
    
    // 8. Naviga /customers
    await page.click('nav >> text=Clienti');
    
    // 9. Apri dettaglio primo cliente (assume almeno un ordine)
    await page.click('table >> tr >> td >> a >> nth=0');
    
    // 10. Verifica profitto include shipping cost
    await expect(page.locator('text=Costi spedizione:')).toBeVisible();
    await expect(page.locator('text=Profitto:')).toBeVisible();
  });
  
  test('alert peso mancante → configura default', async ({ page }) => {
    // Assume ordini senza peso già presenti
    await page.goto('/');
    
    // 1. Verifica alert presente
    const alert = page.locator('text=ordini senza peso');
    if (await alert.isVisible()) {
      // 2. Click link
      await page.click('text=Configura peso di default');
      await expect(page).toHaveURL('/spedizioni');
      
      // 3. Imposta default
      await page.fill('input[label*="Peso default"]', '0.5');
      await page.click('button:has-text("Salva configurazione")');
      
      // 4. Torna dashboard
      await page.click('nav >> text=Dashboard');
      
      // 5. Dismissione alert (non verifichiamo scomparsa, dipende da re-sync)
      const alertAfter = page.locator('text=ordini senza peso');
      if (await alertAfter.isVisible()) {
        await page.click('button[aria-label*="Chiudi"]');
        await expect(alertAfter).not.toBeVisible();
      }
    }
  });
  
  test('edit zone: cambio da linear a brackets', async ({ page }) => {
    await page.goto('/spedizioni');
    
    // Sync se necessario
    if (await page.locator('text=Nessuna zona configurata').isVisible()) {
      await page.click('button:has-text("Importa zone da Shopify")');
      await page.waitForTimeout(2000);
    }
    
    // Apri modal prima zona
    await page.click('table >> tr >> button:has-text("Modifica") >> nth=0');
    
    // Switch a brackets
    await page.click('text=Fasce di peso');
    
    // Aggiungi fasce
    await page.fill('input[label="Da (kg)"] >> nth=0', '0');
    await page.fill('input[label="A (kg)"] >> nth=0', '1');
    await page.fill('input[label="Costo (€)"] >> nth=0', '5');
    
    await page.click('button:has-text("Aggiungi fascia")');
    
    await page.fill('input[label="Da (kg)"] >> nth=1', '1');
    await page.fill('input[label="Costo (€)"] >> nth=1', '8');
    
    // Salva
    await page.click('button:has-text("Salva")');
    
    // Riapri e verifica
    await page.click('table >> tr >> button:has-text("Modifica") >> nth=0');
    await expect(page.locator('text=Fasce di peso')).toBeChecked();
    await expect(page.locator('input[value="5"]')).toBeVisible();
    await expect(page.locator('input[value="8"]')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run E2E tests**

Run: `npm run test:e2e`  
Expected: PASS (tutti i test passano)

Nota: potrebbero servire aggiustamenti ai selettori a seconda del rendering Polaris effettivo.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/shipping-flow.spec.ts
git commit -m "test(shipping): add end-to-end test coverage

- Complete flow: sync zones, configure rates, packaging, verify profit
- Weight alert flow: dismiss and configure default
- Zone editing: switch linear to brackets with validation
- Playwright tests with Polaris selectors

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013ULomqcXBq2u3QJ4s7cEhM"
```

---

## Final Steps

- [ ] **Step 1: Execute SQL migrations on DB owner**

1. Connect to production DB owner (Postgres)
2. Run `docs/migrations/2026-09-23-shipping-tables-owner.sql`
3. Run `docs/migrations/2026-09-23-shipping-alert-dismissals.sql`
4. Verify tables created: `\dt shipping_*`

- [ ] **Step 2: Deploy to production**

```bash
npm run build
# Deploy via Shopify CLI or Vercel
```

- [ ] **Step 3: Manual smoke test on production**

1. Login to merchant account
2. Navigate /spedizioni
3. Sync zones
4. Configure one zone
5. Add packaging config
6. Create test order
7. Verify profit calculation includes shipping cost

- [ ] **Step 4: Monitor errors**

Check Sentry/logs for:
- `[shipping]` errors in first 24h
- Performance: `shipping_cost_calculation_duration_ms` metric
- Database: query performance on shipping_zones/rates

---

**Implementation Complete!**

This plan produces a fully functional shipping costs management system with:
- ✅ Database schema (3 tables owner, 5 columns merchant)
- ✅ Shopify zones sync
- ✅ Order data enrichment (fulfillment, weight, country, returns, packaging)
- ✅ Cost calculation engine (linear + brackets rates, packaging, returns)
- ✅ Profit integration
- ✅ Complete UI (/spedizioni with zones table, modal, packaging card)
- ✅ Dashboard alert for missing weight
- ✅ E2E test coverage

**Estimated implementation time:** 5-6 days (one task per day average)

**Next step after implementation:** LTP predictive model (uses shipping costs as input)
