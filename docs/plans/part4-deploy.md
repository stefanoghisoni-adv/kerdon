# Shopify-Supabase Sync App Implementation Plan - Part 4: Deployment

> **⚠️ DOCUMENTO STORICO — non ricopiare gli scope da qui.**
> La riga `SHOPIFY_SCOPES` di questo piano contiene `read_cost` e
> `read_metafields`, che non esistono più fra gli scope dell'app, e non contiene
> quelli aggiunti dopo (inventario in scrittura, pubblicazioni, temi, ordini). La
> fonte di verità è `scopes` in `shopify.app.toml`; `.env.example` e il README ne
> ripetono la riga.

> **⚠️ MODIFICA ARCHITETTURALE: worker → cron**
> Vincolo di progetto: **costi ZERO**. Il worker BullMQ long-running (Part 2, `worker.ts`/`Dockerfile.worker`) non è deployabile gratuitamente ed è sostituito in produzione da **route Remix triggerate da cron**: Vercel Cron (giro giornaliero di sicurezza) + GitHub Actions schedule (giro ogni 30 minuti). A ogni giro la route `api/cron/sync` (Task 17) drena i job BullMQ accodati dalla UI ed esegue i periodic check dei negozi in scadenza, riusando senza modifiche i processor di Part 2. Ogni riferimento a Railway/piani a pagamento è stato rimosso.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completare flusso OAuth, integrazione billing e configurazione di deployment in produzione a costo zero

**This document:** Part 4 of 4 - OAuth, Billing API, Deployment (Final)

**Prerequisites:** Part 1 completata (✅ 7/7 task, commit 07db8a4..c6d794b), Part 2 e Part 3 completate

**Tech Stack:** Shopify OAuth, Shopify Billing API (GraphQL), Vercel Free, Supabase Free, Upstash Free, GitHub Actions

## Global Constraints

Vincoli validi per ogni task di questo documento (ogni task li eredita implicitamente):

- Node.js >= 18, TypeScript strict mode, Shopify API version `2024-01`
- Vincolo di progetto: **costi ZERO** — stack: **Vercel Free** (app Remix + cron giornaliero), **Supabase Free** (PostgreSQL per i metadata dell'app, `DATABASE_URL`), **Upstash Free** (Redis per la coda BullMQ, `REDIS_URL` in formato `rediss://`), **GitHub Actions** (CI + trigger cron ogni 30 min)
- Le route dei webhook sono quelle già implementate in Part 1: `/webhooks/products/create|update|delete`, `/webhooks/gdpr/data-request`, `/webhooks/gdpr/customers-redact`, `/webhooks/gdpr/shop-redact`
- Gestione errori nelle route cron: mai far fallire l'intera invocazione per un singolo negozio/job — `try/catch` per elemento, `console.error`, accumulo dell'errore nella risposta JSON e prosecuzione; i processor di Part 2 creano già il `SyncJob` con `status: 'failed'`
- **Nomi già implementati in Part 1 — usare esattamente questi:**
  - Prisma (singleton `prisma` da `app/db.server.ts`): `Shop.shopDomain`, `Shop.accessToken`, `Shop.scopes`, `Shop.currentPlan` (String), `SupabaseConfig.tableNameProducts`, `SupabaseConfig.tableNameCustomers`, `Plan.planName`, `Plan.priceMonthly`/`Plan.priceYearly` (0, 29/290, 99/990, 299/2990), `Plan.maxSyncFrequencyHours`
  - Funzioni: `encrypt(plaintext)`/`decrypt(ciphertext)` in `app/utils/crypto.server.ts` (`ENCRYPTION_SECRET` = 64 caratteri hex), `createSupabaseClient(config)` in `app/lib/supabase.server.ts`, `verifyWebhook(body, hmacHeader)` in `app/lib/webhooks/verify.server.ts`
  - Da Part 2: `processPeriodicSyncCheck(shopId)`, `processInitialBulkSync(shopId, job)`, `processManualSync(shopId, job)` in `app/lib/workers/processors.server.ts`; `syncQueue` in `app/lib/queue/queues.server.ts`

---

## Phase 7: Shopify App Integration

### Task 15: OAuth Installation Flow

**Files:**
- Modify: `app/shopify.server.ts` (from Remix template)
- Create: `app/routes/auth.callback.tsx`
- Create: `app/routes/auth.$.tsx` (catch-all for OAuth)
- Modify: `shopify.app.toml`

**Interfaces:**
- Consumes: Shopify App credentials (API key, secret)
- Produces: OAuth flow with shop installation, token storage, webhook registration

- [ ] **Step 1: Configure Shopify app credentials**

Add to `.env`:

```bash
SHOPIFY_API_KEY=your_api_key_from_partner_dashboard
SHOPIFY_API_SECRET=your_api_secret_from_partner_dashboard
```

Update `shopify.app.toml` (from template). Le URI dei webhook devono coincidere con le route già create in Part 1 (una subscription per topic):

```toml
name = "Supabase Sync"
client_id = "YOUR_API_KEY"
application_url = "https://your-app.vercel.app"
embedded = true

[access_scopes]
scopes = "read_products,write_products,read_inventory,read_cost,read_customers,write_customers,read_metafields"

[auth]
redirect_urls = [
  "https://your-app.vercel.app/auth/callback"
]

[webhooks]
api_version = "2024-01"

[[webhooks.subscriptions]]
topics = ["products/create"]
uri = "/webhooks/products/create"

[[webhooks.subscriptions]]
topics = ["products/update"]
uri = "/webhooks/products/update"

[[webhooks.subscriptions]]
topics = ["products/delete"]
uri = "/webhooks/products/delete"

[[webhooks.subscriptions]]
compliance_topics = ["customers/data_request"]
uri = "/webhooks/gdpr/data-request"

[[webhooks.subscriptions]]
compliance_topics = ["customers/redact"]
uri = "/webhooks/gdpr/customers-redact"

[[webhooks.subscriptions]]
compliance_topics = ["shop/redact"]
uri = "/webhooks/gdpr/shop-redact"
```

- [ ] **Step 2: Implement installation callback**

Create `app/routes/auth.callback.tsx`:

```tsx
import type { LoaderFunctionArgs } from '@remix-run/node';
import { redirect } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { encrypt } from '~/utils/crypto.server';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);

  const shopDomain = session.shop;
  const accessToken = session.accessToken;
  const scopes = session.scope;

  // Save or update shop in database
  await prisma.shop.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      accessToken: encrypt(accessToken),
      scopes,
      currentPlan: 'free',
      isInTrial: true,
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      installedAt: new Date(),
    },
    update: {
      accessToken: encrypt(accessToken),
      scopes,
      uninstalledAt: null, // Re-installation
    },
  });

  // Register webhooks
  await registerWebhooks(admin.graphql);

  // Redirect to app
  return redirect('/');
}

async function registerWebhooks(graphql: any) {
  const webhooks = [
    { topic: 'PRODUCTS_CREATE', address: `${process.env.SHOPIFY_APP_URL}/webhooks/products/create` },
    { topic: 'PRODUCTS_UPDATE', address: `${process.env.SHOPIFY_APP_URL}/webhooks/products/update` },
    { topic: 'PRODUCTS_DELETE', address: `${process.env.SHOPIFY_APP_URL}/webhooks/products/delete` },
    { topic: 'CUSTOMERS_CREATE', address: `${process.env.SHOPIFY_APP_URL}/webhooks/customers/create` },
    { topic: 'CUSTOMERS_UPDATE', address: `${process.env.SHOPIFY_APP_URL}/webhooks/customers/update` },
    { topic: 'CUSTOMERS_DELETE', address: `${process.env.SHOPIFY_APP_URL}/webhooks/customers/delete` },
  ];

  for (const webhook of webhooks) {
    const mutation = `
      mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          userErrors {
            field
            message
          }
          webhookSubscription {
            id
          }
        }
      }
    `;

    await graphql(mutation, {
      variables: {
        topic: webhook.topic,
        webhookSubscription: {
          callbackUrl: webhook.address,
          format: 'JSON',
        },
      },
    });
  }
}
```

Nota: i webhook GDPR (`customers/data_request`, `customers/redact`, `shop/redact`) non si registrano via API — Shopify li invia alle `compliance_topics` URI dichiarate in `shopify.app.toml`.

> **ATTENZIONE — gap noto:** le route `/webhooks/customers/create|update|delete` non esistono ancora (non sono in Part 1 né pianificate in Part 2-3). Finché non vengono implementate (insieme a un transformer `transformCustomer` e alla pagina Customers rimandata in Part 3), Shopify riceverà 404 su questi topic. Registrale comunque solo quando i handler esistono, oppure commenta le tre righe `CUSTOMERS_*` fino ad allora.

- [ ] **Step 3: Commit OAuth flow**

```bash
git add app/routes/auth.* shopify.app.toml .env.example
git commit -m "feat: implement Shopify OAuth installation flow with webhook registration

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 16: Billing API Integration

**Files:**
- Create: `app/lib/billing.server.ts`
- Create: `app/routes/billing.upgrade.tsx`
- Create: `app/routes/billing.confirm.tsx`

**Interfaces:**
- Consumes: Shopify Billing API, Plan model
- Produces: `createRecurringCharge()`, charge confirmation handler

- [ ] **Step 1: Implement billing utilities**

Create `app/lib/billing.server.ts` (prezzi allineati al seed di Part 1: pro 29/290, business 99/990, enterprise 299/2990):

```typescript
import type { AdminApiContext } from '@shopify/shopify-app-remix/server';

export async function createRecurringCharge(
  graphql: AdminApiContext['graphql'],
  planType: 'pro' | 'business' | 'enterprise',
  billingCycle: 'monthly' | 'yearly'
) {
  const prices = {
    pro: { monthly: 29, yearly: 290 },
    business: { monthly: 99, yearly: 990 },
    enterprise: { monthly: 299, yearly: 2990 },
  };

  const price = prices[planType][billingCycle];
  const planName = planType.charAt(0).toUpperCase() + planType.slice(1);

  const mutation = `
    mutation appSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $trialDays: Int, $test: Boolean) {
      appSubscriptionCreate(
        name: $name
        lineItems: $lineItems
        returnUrl: $returnUrl
        trialDays: $trialDays
        test: $test
      ) {
        appSubscription {
          id
        }
        confirmationUrl
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await graphql(mutation, {
    variables: {
      name: `${planName} Plan (${billingCycle})`,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: price, currencyCode: 'USD' },
              interval: billingCycle === 'monthly' ? 'EVERY_30_DAYS' : 'ANNUAL',
            },
          },
        },
      ],
      returnUrl: `${process.env.SHOPIFY_APP_URL}/billing/confirm`,
      trialDays: 7,
      test: process.env.NODE_ENV !== 'production',
    },
  });

  const result = await response.json();

  if (result.data.appSubscriptionCreate.userErrors.length > 0) {
    throw new Error(result.data.appSubscriptionCreate.userErrors[0].message);
  }

  return {
    chargeId: result.data.appSubscriptionCreate.appSubscription.id,
    confirmationUrl: result.data.appSubscriptionCreate.confirmationUrl,
  };
}

export async function getSubscription(graphql: AdminApiContext['graphql']) {
  const query = `
    query {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          trialDays
          createdAt
          currentPeriodEnd
          lineItems {
            plan {
              pricingDetails {
                ... on AppRecurringPricing {
                  price {
                    amount
                    currencyCode
                  }
                  interval
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await graphql(query);
  const result = await response.json();

  return result.data.currentAppInstallation.activeSubscriptions[0] || null;
}
```

- [ ] **Step 2: Create upgrade route**

Create `app/routes/billing.upgrade.tsx`:

```tsx
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { createRecurringCharge } from '~/lib/billing.server';
import { prisma } from '~/db.server';

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const formData = await request.formData();
  const planType = formData.get('planType') as 'pro' | 'business' | 'enterprise';
  const billingCycle = formData.get('billingCycle') as 'monthly' | 'yearly';

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
  });

  if (!shop) {
    return json({ error: 'Shop not found' }, { status: 404 });
  }

  try {
    const { chargeId, confirmationUrl } = await createRecurringCharge(
      admin.graphql,
      planType,
      billingCycle
    );

    // Save pending charge
    await prisma.billingCharge.create({
      data: {
        shopId: shop.id,
        planType,
        billingCycle,
        status: 'pending',
        confirmationUrl,
      },
    });

    return json({ confirmationUrl });

  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Create confirmation callback**

Create `app/routes/billing.confirm.tsx`:

```tsx
import type { LoaderFunctionArgs } from '@remix-run/node';
import { redirect } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { getSubscription } from '~/lib/billing.server';
import { prisma } from '~/db.server';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const chargeId = url.searchParams.get('charge_id');

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
  });

  if (!shop) {
    return redirect('/');
  }

  // Get subscription details
  const subscription = await getSubscription(admin.graphql);

  if (subscription && subscription.status === 'ACTIVE') {
    // Update shop plan
    const planType = subscription.name.toLowerCase().includes('pro') ? 'pro' :
                     subscription.name.toLowerCase().includes('business') ? 'business' :
                     subscription.name.toLowerCase().includes('enterprise') ? 'enterprise' : 'free';

    await prisma.shop.update({
      where: { shopDomain },
      data: {
        currentPlan: planType,
        planStartedAt: new Date(),
      },
    });

    // Update charge status
    await prisma.billingCharge.updateMany({
      where: {
        shopId: shop.id,
        status: 'pending',
      },
      data: {
        status: 'active',
        activatedAt: new Date(),
      },
    });
  }

  return redirect('/billing');
}
```

- [ ] **Step 4: Commit billing integration**

```bash
git add app/lib/billing.server.ts app/routes/billing.*
git commit -m "feat: integrate Shopify Billing API for subscription management

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Phase 8: Deployment a costo zero (Vercel + Supabase + Upstash)

### Task 17: Route cron di sync (sostituisce il worker long-running)

**Files:**
- Create: `app/routes/api.cron.sync.tsx`
- Create: `.github/workflows/sync-cron.yml`
- Modify: `.env.example` (CRON_SECRET, se non già presente da Part 2)

**Interfaces:**
- Consumes: `syncQueue` (Part 2), `processPeriodicSyncCheck`/`processInitialBulkSync`/`processManualSync` (Part 2), Prisma Shop/Plan/SyncJob
- Produces: endpoint GET `/api/cron/sync` protetto da `CRON_SECRET` che (1) drena i job BullMQ in attesa e (2) esegue i periodic check dei negozi in scadenza

**Perché:** su Vercel Free non esistono processi long-running, quindi nessun `Worker` BullMQ può consumare la coda. La coda su Upstash resta il punto di accodamento dei job dalla UI ("Sync Now" di Part 3); questa route, invocata da cron, li processa inline e calcola direttamente i negozi dovuti per il periodic check (sostituisce anche i repeatable job del Task 12 di Part 2, che restano solo per lo sviluppo locale).

**Limiti noti dello stack gratuito (documentati, accettati):**
- Vercel Cron su piano Free esegue al massimo 1 volta al giorno → il giro ogni 30 minuti è delegato a GitHub Actions (gratuito)
- La frequenza effettiva minima dei periodic check è ~30 min (adeguata anche al piano Enterprise della spec)
- Durata massima della funzione su Vercel Free: 60s (300s con Fluid Compute attivo). Il periodic check è incrementale (`updated_at_min`), quindi i giri sono brevi; un initial bulk sync di cataloghi molto grandi può non completare in un giro e va rilanciato (il job resta in coda finché il processor non lo completa)

- [ ] **Step 1: Implement cron sync route**

Create `app/routes/api.cron.sync.tsx`:

```tsx
import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import { syncQueue } from '~/lib/queue/queues.server';
import {
  processPeriodicSyncCheck,
  processInitialBulkSync,
  processManualSync,
} from '~/lib/workers/processors.server';

export async function loader({ request }: LoaderFunctionArgs) {
  // Vercel Cron e GitHub Actions invocano in GET con Authorization: Bearer CRON_SECRET
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = { drained: 0, periodicChecks: 0, errors: [] as string[] };

  // 1. Drena i job accodati dalla UI (manual-sync, initial-bulk-sync)
  const pendingJobs = await syncQueue.getJobs(['waiting', 'delayed'], 0, 20);

  for (const job of pendingJobs) {
    try {
      if (job.data.type === 'manual-sync') {
        await processManualSync(job.data.shopId, job);
      } else if (job.data.type === 'initial-bulk-sync') {
        await processInitialBulkSync(job.data.shopId, job);
      }
      await job.remove();
      results.drained++;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Cron drain error for job ${job.id}:`, error);
      results.errors.push(`job ${job.id}: ${message}`);
      // Il processor ha già creato il SyncJob 'failed': rimuovi il job e prosegui
      await job.remove();
    }
  }

  // 2. Periodic check per i negozi in scadenza secondo il piano
  const shops = await prisma.shop.findMany({
    where: {
      uninstalledAt: null,
      supabaseConfig: { syncEnabled: true },
    },
    include: { supabaseConfig: true },
  });

  for (const shop of shops) {
    try {
      const plan = await prisma.plan.findUnique({
        where: { planName: shop.currentPlan },
      });
      if (!plan) continue;

      const lastCheck = await prisma.syncJob.findFirst({
        where: { shopId: shop.id, jobType: 'periodic_check', status: 'completed' },
        orderBy: { completedAt: 'desc' },
      });

      const intervalMs = plan.maxSyncFrequencyHours * 3600 * 1000;
      const due =
        !lastCheck?.completedAt ||
        Date.now() - lastCheck.completedAt.getTime() >= intervalMs;

      if (due) {
        await processPeriodicSyncCheck(shop.id);
        results.periodicChecks++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Cron periodic check error for shop ${shop.shopDomain}:`, error);
      results.errors.push(`shop ${shop.shopDomain}: ${message}`);
      // Prosegui col negozio successivo: il SyncJob 'failed' è già stato creato dal processor
    }
  }

  return json({ ok: true, ...results });
}
```

- [ ] **Step 2: Create GitHub Actions cron trigger (ogni 30 minuti)**

Create `.github/workflows/sync-cron.yml`:

```yaml
name: Sync Cron Trigger

on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch:

jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: Call /api/cron/sync
        run: |
          curl --fail-with-body -sS "$APP_URL/api/cron/sync" \
            -H "Authorization: Bearer $CRON_SECRET"
        env:
          APP_URL: ${{ vars.APP_URL }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
```

Configura nel repo GitHub: variabile `APP_URL` (es. `https://your-app.vercel.app`) e secret `CRON_SECRET` (stesso valore dell'env var su Vercel).

- [ ] **Step 3: Verify CRON_SECRET in .env.example**

`.env.example` deve contenere (aggiunto in Part 2, Task 12 — verifica):

```bash
# Cron
CRON_SECRET=generate_random_secret_here
```

- [ ] **Step 4: Commit cron route**

```bash
git add app/routes/api.cron.sync.tsx .github/workflows/sync-cron.yml .env.example
git commit -m "feat: replace long-running worker with cron-triggered sync route (zero-cost stack)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 18: Configurazione Vercel, CI e guida deployment

**Files:**
- Create: `vercel.json`
- Create: `.github/workflows/ci.yml`
- Create: `README.md` (deployment guide)

**Interfaces:**
- Consumes: Remix build output, environment variables
- Produces: deployment production-ready al 100% gratuito (Vercel Free + Supabase Free + Upstash Free)

- [ ] **Step 1: Create Vercel configuration**

Create `vercel.json` (cron giornaliero di sicurezza alle 03:00 UTC — su piano Free Vercel Cron consente al massimo 1 esecuzione al giorno; il giro ogni 30 min è gestito da GitHub Actions, Task 17):

```json
{
  "buildCommand": "npm run build",
  "devCommand": "npm run dev",
  "installCommand": "npm install",
  "framework": "remix",
  "crons": [
    {
      "path": "/api/cron/sync",
      "schedule": "0 3 * * *"
    }
  ]
}
```

Le environment variables NON vanno in `vercel.json`: si impostano dal dashboard Vercel (Project → Settings → Environment Variables), elenco completo allo Step 3.

- [ ] **Step 2: Create CI workflow**

Create `.github/workflows/ci.yml` (solo test e typecheck: `package.json` non ha uno script `lint`). Il deploy NON passa da GitHub Actions: si usa l'integrazione Git di Vercel (gratuita, deploy automatico a ogni push su `main`):

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test -- --run

      - name: Type check
        run: npm run typecheck
```

- [ ] **Step 3: Create deployment README**

Create `README.md`:

```markdown
# Shopify-Supabase Sync App

Shopify app che sincronizza prodotti e clienti verso database Supabase dei merchant.
Stack di produzione 100% gratuito: Vercel Free + Supabase Free + Upstash Free + GitHub Actions.

## Guida al deployment (costo zero)

### Prerequisiti

1. **Shopify Partner Account** — crea l'app nel Partner Dashboard, annota API Key e API Secret
2. **Vercel** (piano Free) — importa il repository GitHub
3. **Supabase** (piano Free) — progetto dedicato ai metadata dell'app; annota la connection string PostgreSQL (`DATABASE_URL`, usa il connection pooler in modalità transaction)
4. **Upstash** (piano Free) — database Redis per la coda BullMQ; annota l'URL `rediss://` (`REDIS_URL`)
5. **GitHub** — repository per CI e trigger cron

### Step 1: Deploy dell'app su Vercel

1. Push del codice su GitHub
2. Importa il progetto in Vercel (framework: Remix) — l'integrazione Git fa il deploy automatico a ogni push su `main`
3. Aggiungi le environment variables (Project → Settings → Environment Variables):
   ```
   SHOPIFY_API_KEY=xxx
   SHOPIFY_API_SECRET=xxx
   SHOPIFY_SCOPES=read_products,write_products,read_inventory,read_cost,read_customers,write_customers,read_metafields
   SHOPIFY_APP_URL=https://your-app.vercel.app
   SHOPIFY_API_VERSION=2024-01
   DATABASE_URL=postgresql://...   (Supabase Free, pooler transaction mode)
   REDIS_URL=rediss://...          (Upstash Free)
   ENCRYPTION_SECRET=(64 caratteri hex — vedi Step 4)
   SESSION_SECRET=(stringa random)
   CRON_SECRET=(stringa random)
   SHOPIFY_BILLING_REQUIRED=true
   ```
4. Redeploy per applicare le variabili

### Step 2: Cron

- **Vercel Cron** (giro giornaliero di sicurezza): configurato da `vercel.json`, nessuna azione manuale
- **GitHub Actions** (giro ogni 30 minuti): nel repo GitHub imposta la variabile `APP_URL` e il secret `CRON_SECRET` (Settings → Secrets and variables → Actions); il workflow `sync-cron.yml` chiama `/api/cron/sync`

### Step 3: Configurazione app Shopify

Nel Partner Dashboard:
- App URL: `https://your-app.vercel.app`
- Allowed redirection URLs: `https://your-app.vercel.app/auth/callback`
- GDPR webhooks: dichiarati in `shopify.app.toml` (compliance topics)

Testa l'installazione su un development store.

### Step 4: Migrazioni e seed

```bash
# Genera ENCRYPTION_SECRET (64 caratteri hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Migrazioni sul database Supabase (metadata app)
npx prisma migrate deploy

# Seed dei piani (free/pro/business/enterprise)
npm run db:seed
```

### Step 5: Verifica

1. Installa l'app su uno store di test
2. Configura le credenziali Supabase del merchant
3. Lancia il primo sync ("Sync Now") e attendi il giro cron (max 30 min) o invoca manualmente:
   `curl https://your-app.vercel.app/api/cron/sync -H "Authorization: Bearer $CRON_SECRET"`
4. Verifica i webhook (crea/modifica un prodotto nello store di test)
5. Controlla i log delle funzioni su Vercel e la Sync History nell'app

## Limiti dello stack gratuito

- Vercel Cron: max 1 esecuzione/giorno → giro ogni 30 min via GitHub Actions
- Durata funzioni Vercel Free: 60s (300s con Fluid Compute) → bulk sync di cataloghi molto grandi ripartito su più giri cron
- Supabase Free: il progetto si sospende dopo 7 giorni di inattività (il traffico dell'app lo tiene attivo)
- Upstash Free: 10k comandi/giorno — sufficiente per accodamento/drenaggio job

## Production Checklist

- [ ] Environment variables impostate su Vercel
- [ ] `prisma migrate deploy` eseguito e piani seedati
- [ ] Vercel Cron attivo (`vercel.json`) e workflow GitHub Actions abilitato
- [ ] Webhook registrati (verifica con un update prodotto)
- [ ] Endpoint GDPR testati dal Partner Dashboard
- [ ] Billing testato in test mode
- [ ] Error tracking (Sentry free tier, opzionale)
```

- [ ] **Step 4: Generate encryption secret**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copia l'output nella variabile `ENCRYPTION_SECRET` (locale e su Vercel).

- [ ] **Step 5: Commit deployment config**

```bash
git add vercel.json .github/ README.md
git commit -m "feat: add zero-cost deployment config (Vercel Free + Supabase Free + Upstash Free)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Final Summary - All Parts Complete

**Part 1: Foundation** ✅ ESEGUITO (commit 07db8a4..c6d794b)
- Remix + TypeScript + template Shopify, schema Prisma completo, crittografia AES-256-GCM, transformer prodotti, webhook handler (prodotti + GDPR)

**Part 2: Background Workers**
- Coda BullMQ su Redis, client Shopify REST con rate limiting, bulk sync iniziale, periodic check con delta detection, scheduler (solo sviluppo locale)

**Part 3: User Interface**
- Dashboard con stats e activity log, pagina configurazione Supabase, test connection + creazione tabelle; Field Mapping/Sync History/Customers/Billing rimandate (requisiti nel Summary di Part 3)

**Part 4: OAuth, Billing e Deployment (questo documento)**
- Flusso OAuth con registrazione webhook, integrazione Shopify Billing API
- **MODIFICA ARCHITETTURALE:** worker long-running sostituito da route cron `/api/cron/sync` (Vercel Cron giornaliero + GitHub Actions ogni 30 min)
- Stack di produzione a costo zero: Vercel Free + Supabase Free + Upstash Free
- CI GitHub Actions (test + typecheck), deploy via integrazione Git di Vercel

## Prossime azioni

1. Eseguire Part 2 → Part 3 → Part 4 con `superpowers:subagent-driven-development` (consigliato) o `superpowers:executing-plans`
2. Pianificare le pagine UI rimandate (vedi Summary di Part 3) prima della submission allo App Store
