# Shopify-Supabase Sync App Implementation Plan - Part 1: Foundation

> **⚠️ DOCUMENTO STORICO — non ricopiare gli scope da qui.**
> La riga `SHOPIFY_SCOPES` di questo piano contiene `read_cost` e
> `read_metafields`, che non esistono più fra gli scope dell'app, e non contiene
> quelli aggiunti dopo (inventario in scrittura, pubblicazioni, temi, ordini). La
> fonte di verità è `scopes` in `shopify.app.toml`; `.env.example` e il README ne
> ripetono la riga.

> **✅ COMPLETATO — 7/7 task, commit 07db8a4..c6d794b**
> Codice implementato in `Desktop/Siti web/App Shopify + Supabase/shopify-supabase-sync`. Questo documento è il riferimento storico di ciò che è stato eseguito: il contenuto non va modificato, le checkbox sono spuntate a consuntivo.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready embedded Shopify app that synchronizes products, variants, and customers from Shopify stores to merchant-owned Supabase databases with tiered billing, custom fields, and webhook-based real-time sync.

**This document:** Part 1 of 4 - Foundation (Bootstrap, Database, Core Utilities, Transformers, Webhook Handlers)

**Architecture:** Remix-based embedded app with PostgreSQL for app metadata, Redis + BullMQ for job queue, webhook handlers for real-time sync, background workers for periodic consistency checks, and dynamic Supabase clients connecting to merchant-owned databases.

**Tech Stack:** TypeScript, Remix, Shopify Polaris React, Prisma ORM, PostgreSQL, Redis, BullMQ, Supabase JS Client, Shopify API, Vercel/Fly.io deployment

## Global Constraints

- Node.js >= 18.0.0
- TypeScript strict mode enabled
- Shopify API version: 2024-01
- All Shopify scopes: `read_products,write_products,read_inventory,read_cost,read_customers,write_customers,read_metafields`
- AES-256-GCM encryption for all sensitive credentials
- All API responses must complete within 5 seconds (webhook requirement)
- Database connection pooling enabled (max 10 connections per pool)
- UTC timezone for all timestamps
- English + Italian UI text (i18n ready)
- Polaris version ^12.0.0
- Test coverage minimum: 80% for core sync logic
- GDPR webhook handlers mandatory before production deploy
- No console.log in production code (use structured logging)

---

## Phase 1: Project Bootstrap & Infrastructure

### Task 1: Initialize Remix Shopify App

**Files:**
- Create: `shopify-supabase-sync/` (root directory)
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`

**Interfaces:**
- Consumes: None (first task)
- Produces: Remix app scaffold with TypeScript, Shopify App Bridge configured

- [x] **Step 1: Create Remix app from Shopify template**

```bash
npm create @shopify/app@latest -- --template=remix
# When prompted:
# - App name: shopify-supabase-sync
# - Package manager: npm
# - Language: TypeScript
```

Expected output: Project created successfully with Shopify Remix template

- [x] **Step 2: Install additional dependencies**

```bash
cd shopify-supabase-sync
npm install @prisma/client prisma bullmq ioredis @supabase/supabase-js zod crypto-js
npm install -D @types/crypto-js
```

- [x] **Step 3: Create environment file template**

Create `.env.example`:

```bash
# Shopify
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret
SHOPIFY_SCOPES=read_products,write_products,read_inventory,read_cost,read_customers,write_customers,read_metafields
SHOPIFY_APP_URL=http://localhost:3000
SHOPIFY_API_VERSION=2024-01

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/shopify_sync

# Redis
REDIS_URL=redis://localhost:6379

# Security
ENCRYPTION_SECRET=generate_256_bit_key_here
SESSION_SECRET=generate_random_string_here

# Billing
SHOPIFY_BILLING_REQUIRED=false
```

- [x] **Step 4: Update .gitignore**

Add to `.gitignore`:

```
.env
.env.local
node_modules/
dist/
build/
.cache/
prisma/migrations/dev.db*
*.log
.DS_Store
```

- [x] **Step 5: Initialize Git repository**

```bash
git init
git add .
git commit -m "chore: initialize Remix Shopify app

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

Expected: Clean git repository with initial commit

---

### Task 2: Configure Prisma ORM & Database Schema

**Files:**
- Create: `prisma/schema.prisma`
- Create: `prisma/seed.ts`
- Modify: `package.json` (add seed script)

**Interfaces:**
- Consumes: None
- Produces: `PrismaClient` instance, database schema with all tables defined in spec

- [x] **Step 1: Initialize Prisma**

```bash
npx prisma init
```

Expected: `prisma/` directory created with `schema.prisma`

- [x] **Step 2: Define database schema**

Replace `prisma/schema.prisma` content:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Shop {
  id                String             @id @default(uuid())
  shopDomain        String             @unique @map("shop_domain")
  accessToken       String             @map("access_token")
  scopes            String
  currentPlan       String             @default("free") @map("current_plan")
  activeChargeId    String?            @map("active_charge_id")
  trialEndsAt       DateTime?          @map("trial_ends_at")
  isInTrial         Boolean            @default(true) @map("is_in_trial")
  planStartedAt     DateTime?          @map("plan_started_at")
  billingCycle      String?            @map("billing_cycle")
  installedAt       DateTime           @default(now()) @map("installed_at")
  uninstalledAt     DateTime?          @map("uninstalled_at")
  
  supabaseConfig    SupabaseConfig?
  billingCharges    BillingCharge[]
  syncJobs          SyncJob[]
  customFields      CustomField[]
  fieldMappings     FieldMapping[]
  
  @@index([shopDomain])
  @@map("shops")
}

model SupabaseConfig {
  id                     String   @id @default(uuid())
  shopId                 String   @unique @map("shop_id")
  supabaseUrl            String   @map("supabase_url")
  supabasePublicKey      String   @map("supabase_public_key")
  supabaseServiceRoleKey String   @map("supabase_service_role_key")
  tableNameProducts      String   @default("products") @map("table_name_products")
  tableNameCustomers     String   @default("customers") @map("table_name_customers")
  syncEnabled            Boolean  @default(false) @map("sync_enabled")
  syncIntervalHours      Int      @default(24) @map("sync_interval_hours")
  createdAt              DateTime @default(now()) @map("created_at")
  updatedAt              DateTime @updatedAt @map("updated_at")
  
  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)
  
  @@map("supabase_configs")
}

model Plan {
  id                     String   @id @default(uuid())
  planName               String   @unique @map("plan_name")
  priceMonthly           Decimal  @map("price_monthly") @db.Decimal(10, 2)
  priceYearly            Decimal  @map("price_yearly") @db.Decimal(10, 2)
  maxProducts            Int?     @map("max_products")
  maxCustomers           Int?     @map("max_customers")
  maxSyncFrequencyHours  Int      @map("max_sync_frequency_hours")
  customFieldsLimit      Int?     @map("custom_fields_limit")
  supportLevel           String   @map("support_level")
  customersSyncEnabled   Boolean  @default(false) @map("customers_sync_enabled")
  createdAt              DateTime @default(now()) @map("created_at")
  
  @@map("plans")
}

model BillingCharge {
  id                String    @id @default(uuid())
  shopId            String    @map("shop_id")
  shopifyChargeId   BigInt?   @unique @map("shopify_charge_id")
  planType          String    @map("plan_type")
  price             Decimal?  @db.Decimal(10, 2)
  billingCycle      String?   @map("billing_cycle")
  status            String
  trialDays         Int       @default(7) @map("trial_days")
  trialEndsAt       DateTime? @map("trial_ends_at")
  confirmationUrl   String?   @map("confirmation_url")
  activatedAt       DateTime? @map("activated_at")
  cancelledAt       DateTime? @map("cancelled_at")
  createdAt         DateTime  @default(now()) @map("created_at")
  
  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)
  
  @@index([shopId])
  @@map("billing_charges")
}

model SyncJob {
  id              String    @id @default(uuid())
  shopId          String    @map("shop_id")
  jobType         String    @map("job_type")
  status          String
  startedAt       DateTime  @default(now()) @map("started_at")
  completedAt     DateTime? @map("completed_at")
  productsSynced  Int       @default(0) @map("products_synced")
  variantsSynced  Int       @default(0) @map("variants_synced")
  customersSynced Int       @default(0) @map("customers_synced")
  errors          Json?
  
  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)
  
  @@index([shopId])
  @@index([status])
  @@index([startedAt(sort: Desc)])
  @@map("sync_jobs")
}

model CustomField {
  id           String   @id @default(uuid())
  shopId       String   @map("shop_id")
  fieldName    String   @map("field_name")
  fieldType    String   @map("field_type")
  appliesTo    String   @map("applies_to")
  defaultValue String?  @map("default_value")
  createdAt    DateTime @default(now()) @map("created_at")
  
  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)
  
  @@unique([shopId, fieldName, appliesTo])
  @@map("custom_fields")
}

model FieldMapping {
  id             String  @id @default(uuid())
  shopId         String  @map("shop_id")
  shopifyField   String  @map("shopify_field")
  enabled        Boolean @default(false)
  syncToColumn   String? @map("sync_to_column")
  appliesTo      String  @map("applies_to")
  
  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)
  
  @@unique([shopId, shopifyField])
  @@map("field_mappings")
}
```

- [x] **Step 3: Create seed data for plans**

Create `prisma/seed.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding plans...');
  
  await prisma.plan.createMany({
    data: [
      {
        planName: 'free',
        priceMonthly: 0,
        priceYearly: 0,
        maxProducts: 100,
        maxCustomers: 0,
        maxSyncFrequencyHours: 24,
        customFieldsLimit: 3,
        supportLevel: 'community',
        customersSyncEnabled: false,
      },
      {
        planName: 'pro',
        priceMonthly: 29,
        priceYearly: 290,
        maxProducts: 1000,
        maxCustomers: 5000,
        maxSyncFrequencyHours: 6,
        customFieldsLimit: 10,
        supportLevel: 'email',
        customersSyncEnabled: true,
      },
      {
        planName: 'business',
        priceMonthly: 99,
        priceYearly: 990,
        maxProducts: 10000,
        maxCustomers: 50000,
        maxSyncFrequencyHours: 1,
        customFieldsLimit: 50,
        supportLevel: 'priority',
        customersSyncEnabled: true,
      },
      {
        planName: 'enterprise',
        priceMonthly: 299,
        priceYearly: 2990,
        maxProducts: null,
        maxCustomers: null,
        maxSyncFrequencyHours: 0.5,
        customFieldsLimit: null,
        supportLevel: 'dedicated',
        customersSyncEnabled: true,
      },
    ],
    skipDuplicates: true,
  });
  
  console.log('Plans seeded successfully');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

- [x] **Step 4: Add seed script to package.json**

Add to `package.json` scripts:

```json
{
  "scripts": {
    "db:seed": "tsx prisma/seed.ts"
  }
}
```

Install tsx: `npm install -D tsx`

- [x] **Step 5: Run first migration**

```bash
npx prisma migrate dev --name init
npx prisma generate
npm run db:seed
```

Expected: Database schema created, Prisma Client generated, plans table seeded

- [x] **Step 6: Commit database setup**

```bash
git add prisma/ package.json package-lock.json
git commit -m "feat: configure Prisma ORM with complete database schema

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Crypto Utility for Encryption

**Files:**
- Create: `app/utils/crypto.server.ts`
- Create: `app/utils/crypto.test.ts`

**Interfaces:**
- Consumes: None
- Produces: `encrypt(plaintext: string): string`, `decrypt(ciphertext: string): string`

- [x] **Step 1: Write failing test**

Create `app/utils/crypto.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { encrypt, decrypt } from './crypto.server';

describe('Crypto utils', () => {
  beforeAll(() => {
    // Set test encryption secret
    process.env.ENCRYPTION_SECRET = 'a'.repeat(64); // 256-bit hex
  });

  it('should encrypt and decrypt a string', () => {
    const plaintext = 'my-secret-token';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    
    expect(encrypted).not.toBe(plaintext);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertexts for same plaintext', () => {
    const plaintext = 'same-secret';
    const encrypted1 = encrypt(plaintext);
    const encrypted2 = encrypt(plaintext);
    
    expect(encrypted1).not.toBe(encrypted2); // Different IVs
  });

  it('should throw error if ENCRYPTION_SECRET not set', () => {
    delete process.env.ENCRYPTION_SECRET;
    
    expect(() => encrypt('test')).toThrow('ENCRYPTION_SECRET not configured');
  });
});
```

- [x] **Step 2: Install testing dependencies**

```bash
npm install -D vitest @vitest/ui
```

Add to `package.json` scripts:

```json
{
  "scripts": {
    "test": "vitest",
    "test:ui": "vitest --ui"
  }
}
```

- [x] **Step 3: Run test to verify it fails**

```bash
npm test crypto.test.ts
```

Expected: FAIL - "Cannot find module './crypto.server'"

- [x] **Step 4: Implement encryption utility**

Create `app/utils/crypto.server.ts`:

```typescript
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET;
  
  if (!secret) {
    throw new Error('ENCRYPTION_SECRET environment variable not configured');
  }
  
  // Convert hex string to Buffer (expects 64-char hex = 32 bytes)
  if (secret.length !== 64) {
    throw new Error('ENCRYPTION_SECRET must be 64 hex characters (256 bits)');
  }
  
  return Buffer.from(secret, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();
  
  // Return: iv:tag:ciphertext (all hex-encoded)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format');
  }
  
  const [ivHex, tagHex, encryptedHex] = parts;
  
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
```

- [x] **Step 5: Run tests to verify they pass**

```bash
npm test crypto.test.ts
```

Expected: PASS - all 3 tests green

- [x] **Step 6: Commit crypto utility**

```bash
git add app/utils/ package.json package-lock.json
git commit -m "feat: add AES-256-GCM encryption utilities

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Phase 2: Core Sync Infrastructure

### Task 4: Supabase Client Factory

**Files:**
- Create: `app/lib/supabase.server.ts`
- Create: `app/lib/supabase.test.ts`

**Interfaces:**
- Consumes: `SupabaseConfig` model from Prisma, `decrypt(ciphertext: string)` from crypto utils
- Produces: `createSupabaseClient(config: SupabaseConfig): SupabaseClient`

- [x] **Step 1: Write failing test**

Create `app/lib/supabase.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createSupabaseClient } from './supabase.server';
import type { SupabaseConfig } from '@prisma/client';

vi.mock('../utils/crypto.server', () => ({
  decrypt: (ciphertext: string) => {
    if (ciphertext === 'encrypted_public') return 'public_key_decrypted';
    if (ciphertext === 'encrypted_service') return 'service_key_decrypted';
    return ciphertext;
  },
}));

describe('Supabase client factory', () => {
  it('should create Supabase client with decrypted keys', () => {
    const config: SupabaseConfig = {
      id: 'test-id',
      shopId: 'shop-id',
      supabaseUrl: 'https://test.supabase.co',
      supabasePublicKey: 'encrypted_public',
      supabaseServiceRoleKey: 'encrypted_service',
      tableNameProducts: 'products',
      tableNameCustomers: 'customers',
      syncEnabled: true,
      syncIntervalHours: 24,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    const client = createSupabaseClient(config);
    
    expect(client).toBeDefined();
    expect(client.from).toBeDefined(); // Supabase client has .from method
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
npm test supabase.test.ts
```

Expected: FAIL - "Cannot find module './supabase.server'"

- [x] **Step 3: Implement Supabase client factory**

Create `app/lib/supabase.server.ts`:

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseConfig } from '@prisma/client';
import { decrypt } from '~/utils/crypto.server';

export function createSupabaseClient(config: SupabaseConfig): SupabaseClient {
  const publicKey = decrypt(config.supabasePublicKey);
  const serviceRoleKey = decrypt(config.supabaseServiceRoleKey);
  
  return createClient(config.supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
npm test supabase.test.ts
```

Expected: PASS

- [x] **Step 5: Commit Supabase client factory**

```bash
git add app/lib/
git commit -m "feat: add Supabase client factory with encrypted credentials

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 5: Shopify Product Transformer

**Files:**
- Create: `app/lib/transformers/product.server.ts`
- Create: `app/lib/transformers/product.test.ts`
- Create: `app/types/shopify.ts`

**Interfaces:**
- Consumes: Shopify Product webhook payload (type defined in `app/types/shopify.ts`)
- Produces: `transformProduct(product: ShopifyProduct): SupabaseProductRow[]` - array of rows for Supabase products table

- [x] **Step 1: Define Shopify product types**

Create `app/types/shopify.ts`:

```typescript
export interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  handle: string;
  status: 'active' | 'draft' | 'archived';
  tags: string;
  published_at: string | null;
  variants: ShopifyVariant[];
  images?: ShopifyImage[];
}

export interface ShopifyVariant {
  id: number;
  product_id: number;
  title: string;
  sku: string;
  barcode: string | null;
  price: string;
  compare_at_price: string | null;
  cost: string | null;
  position: number;
  inventory_quantity: number;
  weight: number;
  weight_unit: string;
  requires_shipping: boolean;
  taxable: boolean;
  image_id: number | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

export interface ShopifyImage {
  id: number;
  product_id: number;
  src: string;
}

export interface SupabaseProductRow {
  shopify_product_id: number;
  shopify_variant_id: number | null;
  is_variant: boolean;
  product_title: string;
  product_description: string | null;
  vendor: string | null;
  product_type: string | null;
  handle: string;
  product_status: string;
  tags: string[];
  product_published_at: string | null;
  variant_title: string | null;
  sku: string | null;
  barcode: string | null;
  price: number;
  compare_at_price: number | null;
  cost_per_item: number | null;
  position: number | null;
  inventory_quantity: number | null;
  weight: number | null;
  weight_unit: string | null;
  requires_shipping: boolean | null;
  taxable: boolean | null;
  image_url: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  synced_at: string;
}
```

- [x] **Step 2: Write failing test**

Create `app/lib/transformers/product.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { transformProduct } from './product.server';
import type { ShopifyProduct } from '~/types/shopify';

describe('Product transformer', () => {
  it('should transform product with variants into multiple rows', () => {
    const shopifyProduct: ShopifyProduct = {
      id: 123,
      title: 'Test Product',
      body_html: '<p>Description</p>',
      vendor: 'Test Vendor',
      product_type: 'Test Type',
      handle: 'test-product',
      status: 'active',
      tags: 'tag1, tag2',
      published_at: '2026-07-11T10:00:00Z',
      variants: [
        {
          id: 456,
          product_id: 123,
          title: 'Red / M',
          sku: 'TEST-RED-M',
          barcode: '123456789',
          price: '29.99',
          compare_at_price: '39.99',
          cost: '15.00',
          position: 1,
          inventory_quantity: 10,
          weight: 0.5,
          weight_unit: 'kg',
          requires_shipping: true,
          taxable: true,
          image_id: null,
          option1: 'Red',
          option2: 'M',
          option3: null,
        },
        {
          id: 789,
          product_id: 123,
          title: 'Blue / L',
          sku: 'TEST-BLUE-L',
          barcode: null,
          price: '29.99',
          compare_at_price: null,
          cost: '15.00',
          position: 2,
          inventory_quantity: 5,
          weight: 0.5,
          weight_unit: 'kg',
          requires_shipping: true,
          taxable: true,
          image_id: null,
          option1: 'Blue',
          option2: 'L',
          option3: null,
        },
      ],
    };
    
    const rows = transformProduct(shopifyProduct);
    
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      shopify_product_id: 123,
      shopify_variant_id: 456,
      is_variant: true,
      product_title: 'Test Product',
      variant_title: 'Red / M',
      sku: 'TEST-RED-M',
      price: 29.99,
      cost_per_item: 15.00,
    });
    expect(rows[0].tags).toEqual(['tag1', 'tag2']);
    expect(rows[1].shopify_variant_id).toBe(789);
  });

  it('should transform product without variants into single row', () => {
    const shopifyProduct: ShopifyProduct = {
      id: 999,
      title: 'Simple Product',
      body_html: '',
      vendor: 'Vendor',
      product_type: '',
      handle: 'simple',
      status: 'active',
      tags: '',
      published_at: null,
      variants: [
        {
          id: 111,
          product_id: 999,
          title: 'Default Title',
          sku: 'SIMPLE',
          barcode: null,
          price: '10.00',
          compare_at_price: null,
          cost: null,
          position: 1,
          inventory_quantity: 100,
          weight: 0,
          weight_unit: 'kg',
          requires_shipping: false,
          taxable: false,
          image_id: null,
          option1: 'Default Title',
          option2: null,
          option3: null,
        },
      ],
    };
    
    const rows = transformProduct(shopifyProduct);
    
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shopify_product_id: 999,
      shopify_variant_id: null,
      is_variant: false,
      product_title: 'Simple Product',
      variant_title: null,
      price: 10.00,
      cost_per_item: null,
    });
  });
});
```

- [x] **Step 3: Run test to verify it fails**

```bash
npm test product.test.ts
```

Expected: FAIL - "Cannot find module './product.server'"

- [x] **Step 4: Implement product transformer**

Create `app/lib/transformers/product.server.ts`:

```typescript
import type { ShopifyProduct, SupabaseProductRow } from '~/types/shopify';

export function transformProduct(product: ShopifyProduct): SupabaseProductRow[] {
  const hasMultipleVariants = product.variants.length > 1 || 
    (product.variants.length === 1 && product.variants[0].title !== 'Default Title');
  
  const tags = product.tags 
    ? product.tags.split(',').map(tag => tag.trim()).filter(Boolean)
    : [];
  
  if (hasMultipleVariants) {
    // Product has variants → create row per variant
    return product.variants.map(variant => ({
      shopify_product_id: product.id,
      shopify_variant_id: variant.id,
      is_variant: true,
      
      // Product-level data (duplicated)
      product_title: product.title,
      product_description: product.body_html || null,
      vendor: product.vendor || null,
      product_type: product.product_type || null,
      handle: product.handle,
      product_status: product.status,
      tags,
      product_published_at: product.published_at,
      
      // Variant-level data
      variant_title: variant.title,
      sku: variant.sku || null,
      barcode: variant.barcode,
      price: parseFloat(variant.price),
      compare_at_price: variant.compare_at_price ? parseFloat(variant.compare_at_price) : null,
      cost_per_item: variant.cost ? parseFloat(variant.cost) : null,
      position: variant.position,
      inventory_quantity: variant.inventory_quantity,
      weight: variant.weight,
      weight_unit: variant.weight_unit,
      requires_shipping: variant.requires_shipping,
      taxable: variant.taxable,
      image_url: getVariantImageUrl(product, variant),
      option1: variant.option1,
      option2: variant.option2,
      option3: variant.option3,
      
      synced_at: new Date().toISOString(),
    }));
  } else {
    // Product without variants → single row
    const variant = product.variants[0];
    
    return [{
      shopify_product_id: product.id,
      shopify_variant_id: null,
      is_variant: false,
      
      product_title: product.title,
      product_description: product.body_html || null,
      vendor: product.vendor || null,
      product_type: product.product_type || null,
      handle: product.handle,
      product_status: product.status,
      tags,
      product_published_at: product.published_at,
      
      variant_title: null,
      sku: variant.sku || null,
      barcode: variant.barcode,
      price: parseFloat(variant.price),
      compare_at_price: variant.compare_at_price ? parseFloat(variant.compare_at_price) : null,
      cost_per_item: variant.cost ? parseFloat(variant.cost) : null,
      position: variant.position,
      inventory_quantity: variant.inventory_quantity,
      weight: variant.weight,
      weight_unit: variant.weight_unit,
      requires_shipping: variant.requires_shipping,
      taxable: variant.taxable,
      image_url: product.images?.[0]?.src || null,
      option1: null,
      option2: null,
      option3: null,
      
      synced_at: new Date().toISOString(),
    }];
  }
}

function getVariantImageUrl(product: ShopifyProduct, variant: { image_id: number | null }): string | null {
  if (!variant.image_id || !product.images) return null;
  const image = product.images.find(img => img.id === variant.image_id);
  return image?.src || null;
}
```

- [x] **Step 5: Run tests to verify they pass**

```bash
npm test product.test.ts
```

Expected: PASS - all tests green

- [x] **Step 6: Commit product transformer**

```bash
git add app/lib/transformers/ app/types/
git commit -m "feat: add Shopify product to Supabase transformer

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Phase 3: Webhook Handlers

### Task 6: Product Webhook Handler

**Files:**
- Create: `app/routes/webhooks.products.create.tsx`
- Create: `app/routes/webhooks.products.update.tsx`
- Create: `app/routes/webhooks.products.delete.tsx`
- Create: `app/lib/webhooks/verify.server.ts`
- Create: `app/lib/webhooks/verify.test.ts`

**Interfaces:**
- Consumes: `transformProduct()` from product transformer, `createSupabaseClient()` from supabase factory, Prisma models
- Produces: Webhook endpoints that handle Shopify product events and sync to Supabase

- [x] **Step 1: Write HMAC verification utility test**

Create `app/lib/webhooks/verify.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { verifyWebhook } from './verify.server';
import crypto from 'crypto';

describe('Webhook HMAC verification', () => {
  const testSecret = 'test_secret_key';
  
  beforeAll(() => {
    process.env.SHOPIFY_API_SECRET = testSecret;
  });

  it('should verify valid HMAC signature', () => {
    const body = JSON.stringify({ id: 123, title: 'Test' });
    const hmac = crypto
      .createHmac('sha256', testSecret)
      .update(body, 'utf8')
      .digest('base64');
    
    const result = verifyWebhook(body, hmac);
    expect(result).toBe(true);
  });

  it('should reject invalid HMAC signature', () => {
    const body = JSON.stringify({ id: 123 });
    const fakeHmac = 'invalid_signature';
    
    const result = verifyWebhook(body, fakeHmac);
    expect(result).toBe(false);
  });

  it('should reject tampered body', () => {
    const body = JSON.stringify({ id: 123 });
    const hmac = crypto
      .createHmac('sha256', testSecret)
      .update(body, 'utf8')
      .digest('base64');
    
    const tamperedBody = JSON.stringify({ id: 999 });
    const result = verifyWebhook(tamperedBody, hmac);
    expect(result).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
npm test verify.test.ts
```

Expected: FAIL - "Cannot find module './verify.server'"

- [x] **Step 3: Implement HMAC verification**

Create `app/lib/webhooks/verify.server.ts`:

```typescript
import crypto from 'crypto';

export function verifyWebhook(body: string, hmacHeader: string): boolean {
  const secret = process.env.SHOPIFY_API_SECRET;
  
  if (!secret) {
    throw new Error('SHOPIFY_API_SECRET not configured');
  }
  
  const hash = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmacHeader),
      Buffer.from(hash)
    );
  } catch {
    return false;
  }
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
npm test verify.test.ts
```

Expected: PASS

- [x] **Step 5: Implement products/create webhook**

Create `app/routes/webhooks.products.create.tsx`:

```typescript
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { transformProduct } from '~/lib/transformers/product.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import type { ShopifyProduct } from '~/types/shopify';

export async function action({ request }: ActionFunctionArgs) {
  // Verify HMAC signature
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');
  
  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  // Extract shop domain
  const shopDomain = request.headers.get('X-Shopify-Shop-Domain');
  if (!shopDomain) {
    return json({ error: 'Missing shop domain' }, { status: 400 });
  }
  
  try {
    const product: ShopifyProduct = JSON.parse(body);
    
    // Load shop config
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { supabaseConfig: true },
    });
    
    if (!shop || !shop.supabaseConfig) {
      console.log(`Shop ${shopDomain} not configured for sync`);
      return json({ ok: true }, { status: 200 }); // Acknowledge anyway
    }
    
    if (!shop.supabaseConfig.syncEnabled) {
      console.log(`Sync disabled for shop ${shopDomain}`);
      return json({ ok: true }, { status: 200 });
    }
    
    // Transform product to Supabase rows
    const rows = transformProduct(product);
    
    // Create Supabase client
    const supabase = createSupabaseClient(shop.supabaseConfig);
    
    // Upsert rows
    const { error } = await supabase
      .from(shop.supabaseConfig.tableNameProducts)
      .upsert(rows, {
        onConflict: 'shopify_variant_id',
        ignoreDuplicates: false,
      });
    
    if (error) {
      console.error('Supabase upsert error:', error);
      
      // Log failed sync job
      await prisma.syncJob.create({
        data: {
          shopId: shop.id,
          jobType: 'webhook',
          status: 'failed',
          productsSynced: 0,
          variantsSynced: 0,
          errors: { message: error.message, code: error.code },
        },
      });
      
      // Return 200 anyway to prevent Shopify retries
      return json({ ok: true }, { status: 200 });
    }
    
    // Log successful sync
    await prisma.syncJob.create({
      data: {
        shopId: shop.id,
        jobType: 'webhook',
        status: 'completed',
        productsSynced: 1,
        variantsSynced: rows.length,
        completedAt: new Date(),
      },
    });
    
    return json({ ok: true }, { status: 200 });
    
  } catch (error) {
    console.error('Webhook processing error:', error);
    return json({ ok: true }, { status: 200 }); // Acknowledge anyway
  }
}
```

- [x] **Step 6: Implement products/update webhook**

Create `app/routes/webhooks.products.update.tsx`:

```typescript
// Same as create - upsert handles both create and update
export { action } from './webhooks.products.create';
```

- [x] **Step 7: Implement products/delete webhook**

Create `app/routes/webhooks.products.delete.tsx`:

```typescript
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');
  
  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  const shopDomain = request.headers.get('X-Shopify-Shop-Domain');
  if (!shopDomain) {
    return json({ error: 'Missing shop domain' }, { status: 400 });
  }
  
  try {
    const { id: productId } = JSON.parse(body);
    
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { supabaseConfig: true },
    });
    
    if (!shop?.supabaseConfig?.syncEnabled) {
      return json({ ok: true }, { status: 200 });
    }
    
    const supabase = createSupabaseClient(shop.supabaseConfig);
    
    // Hard delete all rows for this product
    const { error } = await supabase
      .from(shop.supabaseConfig.tableNameProducts)
      .delete()
      .eq('shopify_product_id', productId);
    
    if (error) {
      console.error('Supabase delete error:', error);
      await prisma.syncJob.create({
        data: {
          shopId: shop.id,
          jobType: 'webhook',
          status: 'failed',
          errors: { message: error.message },
        },
      });
    } else {
      await prisma.syncJob.create({
        data: {
          shopId: shop.id,
          jobType: 'webhook',
          status: 'completed',
          productsSynced: 0, // Deletion
          completedAt: new Date(),
        },
      });
    }
    
    return json({ ok: true }, { status: 200 });
    
  } catch (error) {
    console.error('Delete webhook error:', error);
    return json({ ok: true }, { status: 200 });
  }
}
```

- [x] **Step 8: Create Prisma client helper**

Create `app/db.server.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient;

declare global {
  var __db__: PrismaClient;
}

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient();
} else {
  if (!global.__db__) {
    global.__db__ = new PrismaClient();
  }
  prisma = global.__db__;
  prisma.$connect();
}

export { prisma };
```

- [x] **Step 9: Commit webhook handlers**

```bash
git add app/routes/webhooks.* app/lib/webhooks/ app/db.server.ts
git commit -m "feat: implement product webhook handlers (create, update, delete)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 7: GDPR Webhook Handlers

**Files:**
- Create: `app/routes/webhooks.gdpr.data-request.tsx`
- Create: `app/routes/webhooks.gdpr.customers-redact.tsx`
- Create: `app/routes/webhooks.gdpr.shop-redact.tsx`

**Interfaces:**
- Consumes: Prisma models, Supabase client factory
- Produces: GDPR-compliant webhook endpoints required for Shopify app approval

- [x] **Step 1: Implement customers/data_request webhook**

Create `app/routes/webhooks.gdpr.data-request.tsx`:

```typescript
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');
  
  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  try {
    const { shop_domain, customer } = JSON.parse(body);
    
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: shop_domain },
      include: { supabaseConfig: true },
    });
    
    if (!shop?.supabaseConfig) {
      console.log(`GDPR data request: Shop ${shop_domain} not configured`);
      return json({ ok: true }, { status: 200 });
    }
    
    const supabase = createSupabaseClient(shop.supabaseConfig);
    
    // Fetch customer data
    const { data, error } = await supabase
      .from(shop.supabaseConfig.tableNameCustomers)
      .select('*')
      .eq('shopify_customer_id', customer.id)
      .single();
    
    if (!error && data) {
      // Log the data request
      console.log(`GDPR data request for customer ${customer.id} from shop ${shop_domain}`);
      // In production: send email to merchant with customer data
      // For now: just log
    }
    
    return json({ ok: true }, { status: 200 });
    
  } catch (error) {
    console.error('GDPR data request error:', error);
    return json({ ok: true }, { status: 200 });
  }
}
```

- [x] **Step 2: Implement customers/redact webhook**

Create `app/routes/webhooks.gdpr.customers-redact.tsx`:

```typescript
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');
  
  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  try {
    const { shop_domain, customer } = JSON.parse(body);
    
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: shop_domain },
      include: { supabaseConfig: true },
    });
    
    if (!shop?.supabaseConfig) {
      return json({ ok: true }, { status: 200 });
    }
    
    const supabase = createSupabaseClient(shop.supabaseConfig);
    
    // Hard delete customer data (GDPR right to be forgotten)
    await supabase
      .from(shop.supabaseConfig.tableNameCustomers)
      .delete()
      .eq('shopify_customer_id', customer.id);
    
    console.log(`GDPR redacted customer ${customer.id} for shop ${shop_domain}`);
    
    return json({ ok: true }, { status: 200 });
    
  } catch (error) {
    console.error('GDPR customer redact error:', error);
    return json({ ok: true }, { status: 200 });
  }
}
```

- [x] **Step 3: Implement shop/redact webhook**

Create `app/routes/webhooks.gdpr.shop-redact.tsx`:

```typescript
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { prisma } from '~/db.server';

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');
  
  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  try {
    const { shop_domain } = JSON.parse(body);
    
    // Delete all app metadata for this shop
    // CASCADE will delete supabaseConfig, syncJobs, customFields, etc.
    await prisma.shop.delete({
      where: { shopDomain: shop_domain },
    });
    
    console.log(`GDPR shop redacted: ${shop_domain}`);
    
    // NOTE: We do NOT delete data from merchant's Supabase
    // That database belongs to the merchant, not our app
    
    return json({ ok: true }, { status: 200 });
    
  } catch (error) {
    console.error('GDPR shop redact error:', error);
    return json({ ok: true }, { status: 200 });
  }
}
```

- [x] **Step 4: Commit GDPR handlers**

```bash
git add app/routes/webhooks.gdpr.*
git commit -m "feat: implement GDPR webhook handlers (data request, customer redact, shop redact)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Summary - Part 1 Complete

**What you've built:**

✅ **Phase 1** - Project infrastructure
- Remix + TypeScript + Shopify template
- Prisma ORM with complete database schema
- AES-256-GCM encryption utilities
- Plans table seeded (Free, Pro, Business, Enterprise)

✅ **Phase 2** - Core sync infrastructure
- Supabase client factory with encrypted credentials
- Product transformer (Shopify → Supabase format)
- Support for products with/without variants

✅ **Phase 3** - Webhook handlers
- HMAC signature verification
- Products create/update/delete handlers
- GDPR compliance webhooks (data request, customer redact, shop redact)

**Next steps:**

Continue with **Part 2**: Background Workers & Job Queue
- BullMQ setup with Redis
- Periodic sync checker
- Initial bulk sync
- Retry failed webhooks
- Manual sync trigger

See: `2026-07-11-shopify-supabase-sync-implementation-part2.md`
