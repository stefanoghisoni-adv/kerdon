# Shopify-Supabase Product & Customer Sync App - Design Specification

> **⚠️ DOCUMENTO STORICO — le parti su scope, permessi e dati NON sono più valide.**
> Questa specifica descrive l'app come era stata progettata a luglio 2026. Gli
> scope elencati qui (`read_cost`, `read_metafields`, gli scope clienti concessi
> "dinamicamente all'upgrade") non esistono più: la fonte di verità è `scopes` in
> `shopify.app.toml`, e oggi sono `read_products, write_products, read_inventory,
> write_inventory, read_customers, write_customers, read_publications,
> read_themes, read_orders, read_all_orders`, tutti concessi all'installazione.
> Per cosa l'app tratta e scrive davvero, l'unico riferimento aggiornato è
> `docs/legal/` (privacy policy, DPA, dichiarazione dei dati protetti). Non
> ricopiare da qui.

**Data:** 2026-07-11 (rev. 2026-07-12)
**Autore:** Stefano Ghisoni
**Stato:** Approvata — Part 1 del piano di implementazione già eseguita (commit 07db8a4..c6d794b)
**Versione documento:** 2.0 — riordinata, deduplicata, deployment aggiornato al vincolo di costi zero

---

## 1. Contesto e obiettivi

App Shopify embedded che sincronizza prodotti, varianti e clienti (questi ultimi solo da piano Pro in su) dagli store Shopify verso database Supabase **di proprietà del merchant**. La sincronizzazione è unidirezionale (Shopify → Supabase), guidata dai webhook in tempo reale con verifiche periodiche di consistenza come backup.

**Funzionalità chiave:**
- UI embedded nell'admin Shopify (Remix + Polaris)
- Tabella `products` unificata: prodotti e varianti in un'unica tabella
- Sync clienti da piano Pro+
- Campi custom come colonne reali (`ALTER TABLE`) sul database del merchant
- Sync via webhook + verifica periodica di consistenza
- Delete strategy: hard delete
- Billing a 4 piani (Free, Pro, Business, Enterprise) via Shopify Billing API
- Credenziali cifrate (AES-256-GCM)

**Vincolo di progetto (rev. 2.0): costi di infrastruttura ZERO.** Stack di produzione: Vercel Free (app + cron), Supabase Free (PostgreSQL per i metadata dell'app), Upstash Free (Redis per la coda BullMQ), GitHub Actions (CI + trigger cron). Dettagli in §12.

### Metriche di successo

| KPI tecnici | Target | KPI business | Target |
|---|---|---|---|
| Tempo elaborazione webhook (p95) | <500ms | Install → primo sync | >70% |
| Success rate job di sync | >99% | Upgrade Free → Pro in 30gg | >15% |
| Uptime | 99,9% | Churn mensile | <5% |
| Tempo al primo sync dall'install | <5 min | Ticket support / 100 install | <10 |

### Fuori scope (versione iniziale)

Sync bidirezionale, collections, ordini, GraphQL subscriptions, inventario multi-location, metafields clienti, pricing rules, ottimizzazione immagini/CDN, dashboard analytics, webhook replay viewer, API per terze parti, notifiche Slack.

---

## 2. Architettura

```
┌─────────────────┐
│  Shopify Store  │
└────────┬────────┘
         │ Webhooks (eventi prodotti/clienti)
         ▼
┌─────────────────────────────────────┐
│   Remix App su Vercel Free          │
│  ┌──────────────┐  ┌──────────────┐ │
│  │  Frontend    │  │  Backend     │ │
│  │  (Polaris)   │  │  (Loaders/   │ │
│  │              │  │   Actions)   │ │
│  └──────────────┘  └──────┬───────┘ │
│  ┌────────────────────────▼───────┐ │
│  │  Webhook Handlers              │ │
│  ├────────────────────────────────┤ │
│  │  Route cron /api/cron/sync     │◄── Vercel Cron (1×/giorno)
│  │  (drena coda + periodic check) │◄── GitHub Actions (ogni 30 min)
│  └────────────────────────┬───────┘ │
└───────────────────────────┼─────────┘
         ┌──────────────────┼───────────────────┐
         ▼                  ▼                   ▼
┌─────────────────┐  ┌──────────────┐  ┌─────────────────┐
│  PostgreSQL     │  │  Redis       │  │  Supabase       │
│  Supabase Free  │  │  Upstash Free│  │  (del merchant) │
│  (metadata app) │  │  (coda       │  │                 │
│  - config       │  │   BullMQ)    │  │  - products     │
│  - chiavi       │  │              │  │  - customers    │
│    cifrate      │  │              │  │  - colonne      │
│  - sync log     │  │              │  │    custom       │
│  - billing      │  │              │  │                 │
└─────────────────┘  └──────────────┘  └─────────────────┘
```

**Nota architetturale (stack a costo zero):** su Vercel Free non esistono processi long-running, quindi non c'è un worker BullMQ attivo in produzione. La coda su Upstash accumula i job lanciati dalla UI ("Sync Now", bulk iniziale); una route cron li drena ed esegue i periodic check a ogni giro (§12). Il worker BullMQ classico resta utilizzabile solo in sviluppo locale.

### Flussi dati

1. **Sync real-time (primario):** webhook Shopify → handler → upsert su Supabase
2. **Verifica periodica (backup):** route cron → Shopify REST API (`updated_at_min`) → confronto → correzione delta su Supabase
3. **Sync manuale:** "Sync Now" nella dashboard → job in coda → drenato dal giro cron successivo
4. **Sync iniziale:** import bulk una tantum alla prima configurazione

### Stack tecnologico

| Componente | Scelta | Costo |
|---|---|---|
| Framework | Remix (template ufficiale Shopify) + TypeScript | — |
| UI | Shopify Polaris React ^13 | — |
| Database app | PostgreSQL su **Supabase Free** | $0 |
| Coda job | BullMQ su Redis **Upstash Free** | $0 |
| ORM | Prisma | — |
| Database merchant | Supabase (progetto del merchant) | a carico del merchant |
| Hosting + cron | **Vercel Free** + GitHub Actions | $0 |

---

## 3. Modello dati — PostgreSQL (metadata app)

Sette tabelle. Lo schema è già implementato in `prisma/schema.prisma` (Part 1); di seguito il DDL di riferimento.

### `shops`
Store installati e token OAuth.

```sql
CREATE TABLE shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_domain TEXT UNIQUE NOT NULL, -- es. "my-store.myshopify.com"
  access_token TEXT NOT NULL, -- token OAuth cifrato
  scopes TEXT NOT NULL,
  current_plan TEXT NOT NULL DEFAULT 'free', -- 'free' | 'pro' | 'business' | 'enterprise'
  active_charge_id UUID REFERENCES billing_charges(id),
  trial_ends_at TIMESTAMP,
  is_in_trial BOOLEAN DEFAULT true,
  plan_started_at TIMESTAMP,
  billing_cycle TEXT, -- 'monthly' | 'yearly'
  installed_at TIMESTAMP DEFAULT NOW(),
  uninstalled_at TIMESTAMP
);

CREATE INDEX idx_shops_domain ON shops(shop_domain);
```

### `supabase_configs`
Connessione al Supabase del merchant (1:1 con shops).

```sql
CREATE TABLE supabase_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
  supabase_url TEXT NOT NULL, -- es. "https://xxx.supabase.co"
  supabase_public_key TEXT NOT NULL, -- anon key, cifrata
  supabase_service_role_key TEXT NOT NULL, -- service_role key, cifrata
  table_name_products TEXT DEFAULT 'products',
  table_name_customers TEXT DEFAULT 'customers',
  sync_enabled BOOLEAN DEFAULT false,
  sync_interval_hours INTEGER DEFAULT 24,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_id)
);
```

### `plans`
Definizione piani e limiti, con seed.

```sql
CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_name TEXT UNIQUE NOT NULL,
  price_monthly DECIMAL(10, 2),
  price_yearly DECIMAL(10, 2),
  max_products INTEGER, -- NULL = illimitati
  max_customers INTEGER, -- NULL = illimitati
  max_sync_frequency_hours INTEGER,
  custom_fields_limit INTEGER, -- NULL = illimitati
  support_level TEXT, -- 'community' | 'email' | 'priority' | 'dedicated'
  customers_sync_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO plans (plan_name, price_monthly, price_yearly, max_products, max_customers, max_sync_frequency_hours, custom_fields_limit, support_level, customers_sync_enabled) VALUES
  ('free', 0, 0, 100, 0, 24, 3, 'community', false),
  ('pro', 29, 290, 1000, 5000, 6, 10, 'email', true),
  ('business', 99, 990, 10000, 50000, 1, 50, 'priority', true),
  ('enterprise', 299, 2990, NULL, NULL, 0.5, NULL, 'dedicated', true);
```

> Nota di implementazione: nello schema Prisma di Part 1 `maxSyncFrequencyHours` è `Int`, ma il valore Enterprise è 0.5 (30 minuti). Va risolto prima di seedare Enterprise: o il campo diventa `Decimal`/minuti interi, o Enterprise usa 1h.

### `billing_charges`
Recurring Application Charges di Shopify.

```sql
CREATE TABLE billing_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
  shopify_charge_id BIGINT UNIQUE,
  plan_type TEXT NOT NULL,
  price DECIMAL(10, 2),
  billing_cycle TEXT,
  status TEXT NOT NULL, -- 'pending' | 'active' | 'declined' | 'cancelled' | 'expired'
  trial_days INTEGER DEFAULT 7,
  trial_ends_at TIMESTAMP,
  confirmation_url TEXT,
  activated_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_billing_shop ON billing_charges(shop_id);
```

### `sync_jobs`
Log di tutte le operazioni di sincronizzazione.

```sql
CREATE TABLE sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL, -- 'initial_bulk' | 'webhook' | 'periodic_check' | 'manual'
  status TEXT NOT NULL, -- 'pending' | 'running' | 'completed' | 'failed'
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  products_synced INTEGER DEFAULT 0,
  variants_synced INTEGER DEFAULT 0,
  customers_synced INTEGER DEFAULT 0,
  errors JSONB
);

CREATE INDEX idx_sync_jobs_shop ON sync_jobs(shop_id);
CREATE INDEX idx_sync_jobs_status ON sync_jobs(status);
CREATE INDEX idx_sync_jobs_started ON sync_jobs(started_at DESC);
```

### `custom_fields`
Campi custom configurati dal merchant.

```sql
CREATE TABLE custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL, -- snake_case obbligatorio
  field_type TEXT NOT NULL, -- 'text' | 'number' | 'boolean' | 'date'
  applies_to TEXT NOT NULL, -- 'product' | 'customer'
  default_value TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_id, field_name, applies_to)
);
```

### `field_mappings`
Quali campi Shopify opzionali sincronizzare.

```sql
CREATE TABLE field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID REFERENCES shops(id) ON DELETE CASCADE,
  shopify_field TEXT NOT NULL, -- 'metafields', 'images', 'fulfillment_service', ...
  enabled BOOLEAN DEFAULT false,
  sync_to_column TEXT,
  applies_to TEXT NOT NULL, -- 'product' | 'customer'
  UNIQUE(shop_id, shopify_field)
);
```

### Strategia di crittografia

Tutti i campi sensibili (`access_token`, `supabase_public_key`, `supabase_service_role_key`) sono cifrati con **AES-256-GCM**. Implementazione già in Part 1 (`app/utils/crypto.server.ts`):

- Chiave: env var `ENCRYPTION_SECRET`, esattamente 64 caratteri hex (256 bit)
- Formato ciphertext: `iv:tag:ciphertext` (tutti hex; IV 16 byte random per ogni cifratura)
- API: `encrypt(plaintext)` / `decrypt(ciphertext)`

**Perché:** la service role key di Supabase dà accesso completo al database del merchant. Se il database dell'app venisse compromesso, le chiavi cifrate impediscono l'accesso diretto ai dati dei merchant.

---

## 4. Modello dati — Supabase (database del merchant)

Tabelle create automaticamente nel progetto Supabase del merchant tramite il bottone "Create Tables" (§6.2). Questo è **l'unico** DDL di riferimento (usato anche dall'endpoint `api/supabase/create-tables`).

### `products` — tabella unificata prodotti + varianti

```sql
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ID Shopify
  shopify_product_id BIGINT NOT NULL,
  shopify_variant_id BIGINT UNIQUE, -- NULL se il prodotto non ha varianti
  is_variant BOOLEAN DEFAULT true,

  -- Dati a livello prodotto (duplicati su ogni riga variante)
  product_title TEXT NOT NULL,
  product_description TEXT,
  vendor TEXT,
  product_type TEXT,
  handle TEXT,
  product_status TEXT, -- 'active' | 'draft' | 'archived'
  tags TEXT[],
  product_published_at TIMESTAMP,

  -- Dati a livello variante
  variant_title TEXT, -- NULL se senza varianti
  sku TEXT,
  barcode TEXT,
  price NUMERIC(10, 2) NOT NULL,
  compare_at_price NUMERIC(10, 2),
  cost_per_item NUMERIC(10, 2), -- richiede lo scope read_cost
  position INTEGER,
  inventory_quantity INTEGER,
  weight NUMERIC(10, 3),
  weight_unit TEXT, -- 'kg' | 'g' | 'lb' | 'oz'
  requires_shipping BOOLEAN,
  taxable BOOLEAN,
  image_url TEXT,
  option1 TEXT, -- es. "Red"
  option2 TEXT, -- es. "M"
  option3 TEXT,

  -- Campi opzionali (abilitati via field_mappings)
  metafields JSONB,
  fulfillment_service TEXT,
  inventory_management TEXT,
  inventory_policy TEXT,
  image_urls TEXT[],

  -- Metadata di sync
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  synced_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_products_variant
  ON products(shopify_variant_id)
  WHERE shopify_variant_id IS NOT NULL;

CREATE INDEX idx_products_product_id ON products(shopify_product_id);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_status ON products(product_status);
CREATE INDEX idx_products_updated ON products(updated_at DESC);
```

**Regola prodotti/varianti** (implementata in `app/lib/transformers/product.server.ts`, Part 1):
- Un prodotto "ha varianti" se `variants.length > 1`, **oppure** se ha un'unica variante con `title !== 'Default Title'` (Shopify crea sempre almeno una variante fittizia)
- Con varianti → N righe (una per variante), `is_variant = true`, dati prodotto duplicati
- Senza varianti → 1 riga, `is_variant = false`, `shopify_variant_id = NULL`; prezzi/SKU/peso presi dall'unica variante di default
- Identificazione per upsert: `shopify_variant_id` se presente, altrimenti `shopify_product_id`
- Trasformazioni: `tags` da stringa CSV a `TEXT[]` (trim + filtro vuoti), prezzi con `parseFloat`, `image_url` risolta dall'`image_id` della variante sulle `product.images`

### `customers` — disponibile da Pro+

```sql
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_customer_id BIGINT UNIQUE NOT NULL,

  email TEXT, -- può essere NULL
  phone TEXT, -- formato E.164: +39...
  first_name TEXT,
  last_name TEXT,

  accepts_marketing BOOLEAN,
  marketing_opt_in_level TEXT, -- 'single_opt_in' | 'confirmed_opt_in' | 'unknown'

  total_spent NUMERIC(10, 2),
  orders_count INTEGER,
  customer_state TEXT, -- 'disabled' | 'invited' | 'enabled' | 'declined'

  tags TEXT[],
  note TEXT,
  verified_email BOOLEAN,
  tax_exempt BOOLEAN,

  created_at TIMESTAMP, -- data creazione su Shopify
  updated_at TIMESTAMP, -- ultimo update su Shopify
  synced_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_customers_shopify_id ON customers(shopify_customer_id);
CREATE INDEX idx_customers_email ON customers(email) WHERE email IS NOT NULL;
CREATE INDEX idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_customers_updated ON customers(updated_at DESC);
```

### Campi custom = colonne reali

Quando il merchant crea un campo custom, l'app:

1. Inserisce la definizione in `custom_fields` (database app):
   ```sql
   INSERT INTO custom_fields (shop_id, field_name, field_type, applies_to)
   VALUES ('shop-uuid', 'margine_percentuale', 'number', 'product');
   ```
2. Esegue sul Supabase del merchant (mapping tipi: text→TEXT, number→NUMERIC, boolean→BOOLEAN, date→DATE):
   ```sql
   ALTER TABLE products ADD COLUMN margine_percentuale NUMERIC;
   ```
3. Gestisce gli errori: colonna già esistente → messaggio all'utente senza duplicare la definizione; errore SQL → rollback dell'insert in `custom_fields`
4. Il merchant può poi popolare la colonna via dashboard Supabase, SQL (`UPDATE products SET margine_percentuale = (price - cost_per_item) / price * 100;`) o API

**Perché colonne reali e non JSONB:** query SQL native, indicizzabilità e performance ottimali per la generazione di feed; JSONB è più lento in WHERE e aggregazioni.

---

## 5. Sincronizzazione

### 5.1 Webhook registrati

| Piano | Topic |
|---|---|
| Tutti | `products/create`, `products/update`, `products/delete` |
| Pro+ | `customers/create`, `customers/update`, `customers/delete` |
| Obbligatori (approvazione app) | `customers/data_request`, `customers/redact`, `shop/redact` (§10) |

Route implementate (Part 1): `/webhooks/products/create|update|delete`, `/webhooks/gdpr/data-request`, `/webhooks/gdpr/customers-redact`, `/webhooks/gdpr/shop-redact`.

### 5.2 Flusso webhook

1. Shopify invia POST alla route del topic
2. Verifica HMAC (`X-Shopify-Hmac-Sha256`) con `verifyWebhook(body, hmacHeader)` — firma non valida → 401
3. Estrazione shop domain da `X-Shopify-Shop-Domain` — assente → 400
4. Load config shop da PostgreSQL; shop non configurato o `sync_enabled = false` → log e **200 comunque**
5. Decrittazione chiavi Supabase e creazione client (`createSupabaseClient(config)`)
6. Trasformazione payload (`transformProduct(product)`) e UPSERT su Supabase (`onConflict: 'shopify_variant_id'`)
7. Log in `sync_jobs` (`job_type: 'webhook'`, `status: 'completed'`, contatori)
8. Risposta 200 entro 5 secondi

### 5.3 Gestione errori webhook (comportamento esatto, come implementato in Part 1)

Se l'upsert su Supabase fallisce:
1. `console.error` con il dettaglio dell'errore
2. Creazione `SyncJob` con `status: 'failed'` e `errors: { message, code }`
3. **Risposta 200 a Shopify comunque** — un 4xx/5xx innescherebbe i retry automatici di Shopify e rischi di duplicazione
4. Recupero: il retry avviene internamente via coda BullMQ con backoff 1 min → 5 min → 15 min (3 tentativi); in ogni caso il periodic check successivo (§5.4) riallinea i dati
5. Se tutti i retry falliscono: job marcato definitivamente failed, email al merchant, banner rosso in dashboard con bottone "Retry Now"

Anche le eccezioni impreviste (parse JSON, ecc.) rispondono 200 dopo `console.error`.

### 5.4 Verifica periodica (backup dei webhook)

Frequenza per piano: Free 24h, Pro 6h, Business 1h, Enterprise 30 min. In produzione è la route cron a stabilire quali negozi sono "in scadenza" (§12); il confronto per negozio è:

```typescript
async function periodicSyncCheck(shopId: string) {
  // 1. Prodotti Shopify aggiornati dall'ultimo check (updated_at_min, pagine da 250)
  // 2. Per ogni prodotto: righe correnti da Supabase per shopify_product_id
  // 3. Delta:
  //    - varianti mancanti  → INSERT
  //    - varianti obsolete  → UPDATE (upsert su shopify_variant_id)
  //    - varianti orfane    → DELETE (esistono su Supabase ma non più su Shopify)
  // 4. SyncJob 'periodic_check' con contatori; timestamp di riferimento =
  //    completedAt dell'ultimo periodic_check completato
}
```

**Perché:** i webhook possono andare persi (rete, downtime dell'app). Il check periodico garantisce consistenza finale.

### 5.5 Sync bulk iniziale

Lanciato alla prima configurazione o dal primo "Sync Now": pagine da 250 prodotti (cursor pagination `page_info`), trasformazione, upsert su Supabase a blocchi da 1000 righe, aggiornamento progressivo dei contatori nel `SyncJob`. Il frontend fa polling di `GET /api/sync/status/:jobId` ogni 2 secondi per la progress bar.

### 5.6 Rate limit Shopify

- REST Admin API: 2 req/s (bucket 40); Shopify Plus 4 req/s (bucket 80)
- Header `X-Shopify-Shop-Api-Call-Limit: 32/40` — il client (Part 2) rallenta di 500ms quando l'utilizzo supera il 90%
- Webhook in ingresso: nessun limite pratico; consegna at-least-once garantita
- Per cataloghi molto grandi valutare in futuro le GraphQL bulk operations

### 5.7 Delete strategy: hard delete

Su `products/delete`:

```typescript
await supabase.from('products').delete().eq('shopify_product_id', product.id);
```

Tutte le righe varianti cadono con lo stesso `shopify_product_id`. Nessun soft delete, nessun flag archivio.

**Perché:** schema più semplice, nessuna ambiguità "cancellato ma presente". Se il merchant vuole storicità, abilita il Point-in-Time Recovery sul proprio Supabase (documentarlo nell'onboarding: le cancellazioni sono permanenti).

---

## 6. Interfaccia utente (app embedded)

### Navigazione

- 🏠 Dashboard
- ⚙️ Settings → Supabase Configuration, Field Mapping
- 📊 Sync History
- 👥 Customers (🔒 Pro+)
- 💳 Billing & Plans

### 6.1 Dashboard (`/`)

```
┌────────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────┐ │
│  │ ⚠️ You're using 89/100 products (Free plan)      │ │
│  │    Upgrade to Pro to sync up to 1,000 products   │ │
│  │    [View Plans →]                            [✕] │ │
│  └──────────────────────────────────────────────────┘ │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐     │
│  │ ✅ Connected│ │ 327 Products│ │ 1,245 Vars  │     │
│  │  Supabase  │ │  Synced     │ │  Synced     │     │
│  └─────────────┘ └─────────────┘ └─────────────┘     │
│  Last sync: 2 hours ago (automatic)                   │
│  [🔄 Sync Now]                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Recent Activity (ultimi 10 job, badge di stato)  │ │
│  │ ❌ Periodic check  Failed  5h ago → [Retry]      │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

- Banner utilizzo piano: appare da >80% di utilizzo, dismissibile, tono `critical` da ≥95%
- "Sync Now" disabilitato se Supabase non è configurato

### 6.2 Supabase Configuration (`/settings/supabase`)

Campi: Project URL, Public Key (anon), Service Role Key (con avviso "chiave con accesso completo, la cifriamo prima di salvarla"), nome tabella prodotti (default `products`), nome tabella clienti (default `customers`, 🔒 Pro+), toggle sync automatico, intervallo di sync (opzioni bloccate per piano: 24h / 6h Pro / 1h Business / 30min Enterprise).

Azioni:
- **Test Connection** — valida le credenziali prima del salvataggio (toast di esito)
- **Save Configuration** — cifra le chiavi e fa upsert su `supabase_configs`
- **Create Tables in Supabase** — esegue il DDL di §4 sul progetto del merchant

### 6.3 Field Mapping (`/settings/fields`)

- Checkbox per i campi base opzionali: metafields, fulfillment service, inventory management, tutte le immagini (array); `cost_per_item` è sempre sincronizzato
- Lista campi custom con contatore `usati/limite piano`; a limite raggiunto il bottone "+ Add Custom Field" è disabilitato con card di upsell verso il piano superiore
- Modal creazione campo: nome (snake_case, unico), tipo (Text/Number/Boolean/Date), applica a (Products / Customers 🔒 Pro+), default opzionale. Alla creazione: spinner "Creating column in Supabase...", poi toast di conferma
- Eliminazione con conferma esplicita: "la colonna e i suoi dati verranno rimossi permanentemente dal tuo database Supabase"

### 6.4 Sync History (`/sync/history`)

DataTable con colonne Data/Ora, Tipo, Stato, Prodotti, Durata; filtri per stato, tipo e periodo; paginazione; export CSV. Click su un job fallito apre il dettaglio con l'errore JSONB, le cause probabili (progetto Supabase in pausa, rete, credenziali) e il bottone "Retry Now".

### 6.5 Customers (`/customers`)

- **Free:** paywall con confronto piani (Pro fino a 5.000 clienti, Business fino a 50.000) e CTA "Upgrade to Pro ($29/mo)"; sotto, anteprima disabilitata dell'interfaccia
- **Pro+:** toggle "Enable customer sync", contatore `sincronizzati/limite piano`, bottone "Sync Customers Now", tabella clienti recenti con ricerca e filtro per tag

### 6.6 Billing & Plans (`/billing`)

- **Free:** tabella comparativa 4 piani (prezzi, limiti prodotti/clienti/campi custom, intervallo sync, supporto) con bottoni Upgrade ([Contact] per Enterprise) e giorni di trial residui
- **Piano a pagamento attivo:** card piano corrente con prossimo addebito, meter di utilizzo (prodotti, clienti, campi custom), suggerimento upgrade, [Change Plan] [View Billing History] [Cancel Subscription]

Flusso upgrade: click → `POST /api/billing/upgrade` crea la charge → redirect alla confirmation URL di Shopify → il merchant approva → Shopify torna su `/billing/confirm` → l'app attiva la charge, aggiorna `shops.current_plan`, registra i webhook clienti (se Pro+) → toast "Upgraded to Pro! Customer sync is now available."

### Componenti Polaris

`Page`, `Layout`, `Card`, `Banner`, `Button`, `FormLayout`, `TextField`, `Select`, `Checkbox`, `Badge`, `DataTable`, `Modal`, `Toast`, `ProgressBar`, `Icon`, `SkeletonPage`. Lock icon (`LockMinor`) con tooltip "Upgrade to [Plan] to unlock" → click porta a `/billing` col piano preselezionato. Badge stato: success=Done, critical=Failed, info=Running, warning=Pending.

---

## 7. Sicurezza

**Crittografia** — AES-256-GCM per tutte le credenziali (dettagli in §3); `ENCRYPTION_SECRET` solo in env var, mai nel codice; rotazione della chiave ogni 90 giorni.

**Verifica HMAC webhook** — implementata in Part 1 (`app/lib/webhooks/verify.server.ts`):

```typescript
export function verifyWebhook(body: string, hmacHeader: string): boolean {
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(body, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(hash));
  // try/catch → false su lunghezze diverse
}
```

**Validazione input** — schemi Zod su tutti gli input API; sanitizzazione HTML nelle descrizioni prodotto; le URL Supabase devono essere `https://*.supabase.co`.

**CORS** — ristretto ai domini admin Shopify (`https://*.myshopify.com`).

**Rate limiting applicativo** — sync manuale: max 1/minuto per negozio; endpoint webhook: limite globale 10k/min.

**Backup** — PostgreSQL app: backup giornalieri automatici di Supabase Free (7 giorni di retention). Supabase del merchant: responsabilità del merchant (suggerire PITR nell'onboarding). Log di sync: retention 90 giorni con job di pulizia settimanale.

---

## 8. OAuth scopes e permessi

**Scope base (tutti i piani):** `read_products`, `write_products` (registrazione webhook), `read_inventory`, `read_cost` (**critico** per `cost_per_item`).
**Scope Pro+ (aggiunti dinamicamente all'upgrade):** `read_customers`, `write_customers`.
**Opzionale (se metafields abilitati):** `read_metafields`.
I webhook GDPR non richiedono scope: vanno solo gestiti (§10).

**Flusso installazione:** install → OAuth con scope base → approvazione → token cifrato in `shops.access_token`, scope concessi in `shops.scopes` (stringa CSV).

**Flusso upgrade a Pro:** verifica se `read_customers` è già concesso; se no, redirect OAuth con i soli scope aggiuntivi (Shopify mostra solo i NUOVI permessi) → token aggiornato → registrazione webhook clienti.

**Perché scope dinamici:** chiedere subito gli scope clienti anche agli utenti Free crea attrito e riduce il tasso di installazione.

---

## 9. Billing e piani

### Confronto piani

| Feature | Free | Pro | Business | Enterprise |
|---------|------|-----|----------|------------|
| **Prezzo** | $0 | $29/mese<br>$290/anno | $99/mese<br>$990/anno | $299/mese<br>$2990/anno |
| **Prodotti** | 100 | 1.000 | 10.000 | Illimitati |
| **Clienti** | ❌ | 5.000 | 50.000 | Illimitati |
| **Campi custom** | 3 | 10 | 50 | Illimitati |
| **Intervallo sync** | 24h | 6h | 1h | 30min |
| **Supporto** | Community | Email | Priority | Dedicated |
| **Trial** | 7 giorni | 7 giorni | 7 giorni | Custom |

Billing tramite Shopify Billing API (`appSubscriptionCreate`, GraphQL) con `trialDays: 7` e `test: true` fuori produzione. Flusso upgrade in §6.6.

### Enforcement dei limiti

Controlli **a livello API, prima delle operazioni sul database**; meter di utilizzo in dashboard e prompt di upgrade da >80%.

```typescript
async function canSync(shopId: string, entityType: 'product' | 'customer'): Promise<boolean> {
  const shop = await getShop(shopId);
  const plan = await getPlan(shop.current_plan);

  if (entityType === 'customer' && !plan.customers_sync_enabled) {
    throw new Error('Customer sync requires Pro plan or higher');
  }

  const count = await countEntities(shopId, entityType); // conteggio su Supabase
  const limit = entityType === 'product' ? plan.max_products : plan.max_customers;

  if (limit && count >= limit) {
    throw new Error(`Plan limit reached: ${count}/${limit} ${entityType}s. Upgrade to sync more.`);
  }
  return true;
}
```

Stesso pattern per la creazione di campi custom (`custom_fields_limit`). L'intervallo del sync periodico deriva da `plan.max_sync_frequency_hours` (in produzione applicato dalla route cron, §12).

---

## 10. GDPR

I tre webhook obbligatori per l'approvazione dell'app (handler già implementati in Part 1, route in §5.1). Risposta richiesta entro 30 giorni; testare dal Partner Dashboard prima della submission; documentare le policy di retention nella privacy policy.

**`customers/data_request`** — richiesta dati di un cliente: recupero della riga da `customers` sul Supabase del merchant (`shopify_customer_id`) e invio via email al merchant (requisito Shopify), poi 200.

**`customers/redact`** — diritto all'oblio:

```typescript
await supabase.from('customers').delete().eq('shopify_customer_id', customer.id);
// + log dell'azione di redaction, poi 200
```

**`shop/redact`** — disinstallazione con richiesta di cancellazione:

```typescript
await db.shops.delete({ where: { shop_domain } });
// CASCADE su supabase_configs, sync_jobs, custom_fields, field_mappings, billing_charges.
// NON toccare il Supabase del merchant: sono dati suoi.
```

---

## 11. Strategia di test

- **Unit:** transformer dei payload webhook, crittografia, enforcement limiti piano, generatore migrazioni schema. Coverage minima 80% sulla logica di sync (vitest)
- **Integrazione:** flusso completo webhook → app → Supabase; OAuth con shop di test; creazione/attivazione charge; creazione campo custom (`ALTER TABLE`)
- **E2E (Playwright):** onboarding (install → config → primo sync), upgrade Free → Pro con attivazione sync clienti, recovery da errore (sync fallito → retry → successo)
- **Load:** endpoint webhook 1000 req/s, bulk sync 10.000 prodotti, 100 negozi in sync concorrente

---

## 12. Deployment — stack a costo ZERO

> **Vincolo di progetto (rev. 2.0):** nessun costo di infrastruttura. Railway, Fly.io e ogni piano a pagamento sono esclusi.

### Stack

| Servizio | Ruolo | Piano | Limiti rilevanti |
|---|---|---|---|
| **Vercel** | App Remix (serverless) + cron giornaliero | Free | cron max 1×/giorno; funzioni 60s (300s con Fluid Compute) |
| **Supabase** | PostgreSQL metadata app (`DATABASE_URL`) | Free | pausa dopo 7 giorni di inattività (il traffico la evita) |
| **Upstash** | Redis per coda BullMQ (`REDIS_URL`, `rediss://`) | Free | 10k comandi/giorno |
| **GitHub Actions** | CI + trigger cron ogni 30 min | Free | — |

### Architettura di esecuzione: worker → cron

**MODIFICA ARCHITETTURALE rispetto alla v1:** niente worker BullMQ long-running in produzione (impossibile su serverless gratuito). Al suo posto:

1. La UI accoda i job (`manual-sync`, `initial-bulk-sync`) su BullMQ/Upstash
2. La route `GET /api/cron/sync` (protetta da header `Authorization: Bearer CRON_SECRET`), a ogni invocazione:
   - **drena** i job in attesa dalla coda eseguendo i processor inline
   - calcola i negozi **in scadenza** per il periodic check (confronto tra `plan.max_sync_frequency_hours` e il `completedAt` dell'ultimo `periodic_check` completato) ed esegue `processPeriodicSyncCheck`
   - errori per singolo negozio/job: `console.error` + prosecuzione (il `SyncJob` failed è già tracciato dai processor)
3. Trigger: **Vercel Cron** 1×/giorno alle 03:00 UTC (giro di sicurezza, da `vercel.json`) + **GitHub Actions** `schedule: */30 * * * *` che chiama l'endpoint con il secret
4. Il worker classico (`worker.ts` + `npm run worker`) resta per lo sviluppo locale

Conseguenze accettate: frequenza minima effettiva dei check ~30 min; bulk sync di cataloghi enormi ripartiti su più giri cron; i "Sync Now" vengono processati entro il giro successivo (max 30 min).

### Environment variables

```bash
# Shopify
SHOPIFY_API_KEY=xxx
SHOPIFY_API_SECRET=xxx
SHOPIFY_SCOPES=read_products,write_products,read_inventory,read_cost,read_customers,write_customers,read_metafields
SHOPIFY_APP_URL=https://your-app.vercel.app
SHOPIFY_API_VERSION=2024-01

# Database app (Supabase Free, connection pooler in transaction mode)
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Coda (Upstash Free)
REDIS_URL=rediss://default:pass@host:6379

# Sicurezza
ENCRYPTION_SECRET=<64 caratteri hex = 256 bit>
SESSION_SECRET=<stringa random>
CRON_SECRET=<stringa random>

# Billing
SHOPIFY_BILLING_REQUIRED=true

# Monitoring (opzionale, free tier)
SENTRY_DSN=https://...
```

Le variabili si impostano nel dashboard Vercel; `CRON_SECRET` va replicato nei secret del repo GitHub per il workflow di trigger.

### Migrazioni

```bash
npx prisma migrate dev --name init   # sviluppo
npx prisma generate
npx prisma migrate deploy            # produzione (database Supabase Free)
npm run db:seed                      # seed piani
```

### CI/CD

- **CI (GitHub Actions):** `npm ci` → `npm test -- --run` → `npm run typecheck` su push/PR verso `main` (nessuno script `lint` in package.json)
- **CD:** integrazione Git di Vercel — deploy automatico gratuito a ogni push su `main`; nessuna action di deploy dedicata

### Monitoring

- **Errori:** Sentry (free tier) + error boundary Remix; errori webhook in `sync_jobs.errors`
- **Log:** log funzioni Vercel (JSON strutturato); ricerca per shop_domain, job_id, tipo errore
- **Metriche:** tempi di risposta webhook (p50/p95/p99), success rate job, latenza Supabase, profondità coda
- **Alert:** error rate webhook >5%, coda >100 job, pool connessioni esaurito, errori Supabase >10/min

---

## Appendice A: endpoint API

**Pubblici (Shopify):**
- `POST /webhooks/products/create|update|delete`
- `POST /webhooks/customers/create|update|delete` (Pro+)
- `POST /webhooks/gdpr/data-request`, `/webhooks/gdpr/customers-redact`, `/webhooks/gdpr/shop-redact`

**Cron (protetto da CRON_SECRET):**
- `GET /api/cron/sync` — drena la coda + periodic check dei negozi in scadenza

**App (autenticati via `authenticate.admin`):**
- `GET /` — dashboard
- `GET /settings/supabase`, `POST /api/supabase/test-connection`, `POST /api/supabase/create-tables`, `POST /api/supabase/save-config`
- `GET /settings/fields`, `POST /api/fields/create`, `DELETE /api/fields/:id`
- `GET /sync/history`, `POST /api/sync/manual`, `GET /api/sync/status/:jobId`
- `GET /billing`, `POST /api/billing/upgrade`, `POST /api/billing/confirm`
- `GET /customers`, `POST /api/customers/sync`

---

## Conclusione

Questa specifica è il blueprint completo dell'app: architettura serverless a costo zero, sync webhook-driven con verifica periodica via cron, tabella prodotti unificata, campi custom come colonne reali, billing a 4 piani e conformità GDPR.

**Stato di avanzamento:**
1. ✅ Part 1 — Foundation (schema, crittografia, transformer, webhook handler) — eseguita
2. ⬜ Part 2 — Workers/processor (BullMQ, client Shopify, bulk e periodic sync)
3. ⬜ Part 3 — UI (dashboard, configurazione Supabase; altre pagine da pianificare)
4. ⬜ Part 4 — OAuth, billing, deployment a costo zero (route cron)

---

**Versione documento:** 2.0
**Ultimo aggiornamento:** 2026-07-12
**Stato:** ✅ Riferimento per l'implementazione (Part 2-4)
