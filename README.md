# Shopify Supabase Sync

Shopify embedded app che sincronizza prodotti (con varianti) e clienti da Shopify
verso il database Supabase di proprietà del merchant. Sincronizzazione
unidirezionale, via webhook + polling periodico, con credenziali cifrate.

**Stack di produzione 100% gratuito:** Vercel Free + Supabase Free + Upstash Free + GitHub Actions.

## Tech Stack

- Remix + TypeScript, Shopify App Bridge + Polaris
- `@shopify/shopify-app-remix` (embedded auth: token exchange)
- Prisma (PostgreSQL) per i metadata dell'app
- BullMQ (Redis/Upstash) come punto di accodamento dei job
- Supabase JS client verso il DB del merchant
- Crittografia AES-256-GCM per le credenziali

## Architettura sync (costo zero)

Su Vercel Free non esistono processi long-running, quindi **non** gira un worker
BullMQ persistente in produzione. La coda su Upstash resta il punto di
accodamento dei job dalla UI ("Sync Now"); la route **`/api/cron/sync`**,
invocata da cron, li drena e processa inline e calcola i negozi dovuti per il
periodic check:

- **Vercel Cron** — giro giornaliero di sicurezza (`vercel.json`)
- **GitHub Actions** — giro ogni 30 minuti (`.github/workflows/sync-cron.yml`)

Il worker long-running (`worker.ts`) resta solo per lo sviluppo locale.

## Sviluppo locale

```bash
cp .env.example .env    # compila le variabili
npm install
npx prisma generate
# Schema, piani e RLS in un colpo solo: incolla prisma/owner-bootstrap.sql
# nell'SQL Editor del progetto Supabase. Non usare `prisma db push` da solo —
# non crea i piani ne' le due foreign key sul nome del piano.
npm run dev             # shopify app dev
```

## Deploy in produzione (costo zero)

### Prerequisiti

1. **Shopify Partner Account** — app registrata nel Partner Dashboard (API Key + Secret)
2. **Vercel** (Free) — importa il repository GitHub (framework: Remix)
3. **Supabase** (Free) — progetto per i metadata dell'app (`DATABASE_URL`, pooler in transaction mode)
4. **Upstash** (Free) — Redis per la coda BullMQ (`REDIS_URL` in formato `rediss://`)
5. **GitHub** — repository per CI e trigger cron

### Step 1 — App su Vercel

1. Push del codice su GitHub (l'integrazione Git di Vercel fa deploy automatico su push a `main`)
2. Importa il progetto in Vercel e imposta le Environment Variables
   (Project → Settings → Environment Variables):

   ```
   SHOPIFY_API_KEY=xxx
   SHOPIFY_API_SECRET=xxx
   SHOPIFY_SCOPES=read_products,write_products,read_inventory,read_cost,read_customers,write_customers,read_metafields
   SHOPIFY_APP_URL=https://your-app.vercel.app
   SHOPIFY_API_VERSION=2026-07
   DATABASE_URL=postgresql://...   # Supabase Free, pooler transaction mode
   REDIS_URL=rediss://...          # Upstash Free
   ENCRYPTION_SECRET=...           # 64 caratteri hex (vedi sotto)
   SESSION_SECRET=...              # stringa random
   CRON_SECRET=...                 # stringa random (Vercel Cron la usa in automatico)
   SHOPIFY_BILLING_REQUIRED=false
   ```
3. Redeploy per applicare le variabili

Genera `ENCRYPTION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 2 — Cron

- **Vercel Cron** (giornaliero): configurato da `vercel.json`, nessuna azione manuale.
  Con l'env var `CRON_SECRET` impostata, Vercel aggiunge in automatico l'header
  `Authorization: Bearer <CRON_SECRET>`.
- **GitHub Actions** (ogni 30 min): nel repo, Settings → Secrets and variables → Actions,
  imposta la variabile `APP_URL` e il secret `CRON_SECRET` (stesso valore di Vercel).

### Step 3 — Configurazione app Shopify

Nel Partner Dashboard / `shopify.app.toml`:
- `application_url`: `https://your-app.vercel.app`
- Allowed redirection URL: `https://your-app.vercel.app/auth/callback`
- Webhook prodotti/clienti e GDPR: dichiarati in `shopify.app.toml` (app-managed)

Dopo aver aggiornato il toml, attiva la configurazione:

```bash
shopify app deploy
```

### Step 4 — Schema del DB di produzione

Incolla `prisma/owner-bootstrap.sql` nell'SQL Editor del progetto Supabase owner.
Crea le 11 tabelle, le foreign key, i 5 piani e attiva RLS ovunque.

Non c'e' una migration iniziale nel repo (la piu' vecchia e' una ALTER), quindi
`prisma migrate deploy` su un database vuoto fallisce: quel file e' la strada.

### Step 5 — Verifica

1. Installa l'app su un development store
2. Configura le credenziali Supabase del merchant e crea le tabelle ("Create Tables")
3. Lancia "Sync Now" e attendi il giro cron (max 30 min) o invoca manualmente:
   ```bash
   curl "https://your-app.vercel.app/api/cron/sync" -H "Authorization: Bearer $CRON_SECRET"
   ```
4. Crea/modifica un prodotto nello store di test e verifica il webhook
5. Controlla i log delle funzioni su Vercel

## Limiti dello stack gratuito

- Vercel Cron Free: max 1 esecuzione/giorno → giro ogni 30 min via GitHub Actions
- Durata funzioni Vercel Free: 60s (300s con Fluid Compute) → un bulk sync di
  cataloghi molto grandi può ripartire su più giri cron (il job resta in coda)
- Supabase Free: il progetto si sospende dopo ~7 giorni di inattività
- Upstash Free: ~10k comandi/giorno

## Tracciamento: l'identificativo del visitatore

Il trasporto supportato e' uno solo — un endpoint first-party del negozio, mai
il browser — ed e' descritto in [docs/tracking-integration.md](docs/tracking-integration.md):
il giro completo, cosa deve fare il container e perche' le chiamate dalla
vetrina non sono supportate.

## Manutenzione versione API Shopify

**Revisione trimestrale richiesta.** Shopify mantiene le ultime 4 versioni trimestrali
(~12 mesi). Quando una versione viene ritirata, Shopify fa fall-forward silenzioso alla
versione stabile più vecchia ancora supportata, e l'app può girare su una versione diversa
da quella per cui è scritta.

**Procedura:**

1. Ogni trimestre (gen/apr/lug/ott), verifica le [Shopify API release notes](https://shopify.dev/docs/api/usage/versioning)
2. Aggiorna `SHOPIFY_API_VERSION` in:
   - `.env.example`
   - `shopify.app.toml` (campo `api_version`)
   - `app/shopify.server.ts` (costante `ApiVersion.*`)
   - `app/lib/shopify-api.server.ts` (default nel costruttore)
   - README.md (sezione environment variables)
3. Testa con `npm run dev` e `npm test`
4. Monitoraggio: i log segnalano se la versione ricevuta (`X-Shopify-API-Version`) differisce da quella richiesta

## Stato

- ✅ OAuth (token exchange), sync prodotti+varianti e clienti, cron a costo zero
- ⏳ Billing API e pagine UI (Field Mapping, Sync History, Customers, Billing): non incluse in questa release

## Limitazione nota — creazione tabelle

La route `/api/supabase/create-tables` invoca una RPC Postgres `exec_sql` che
**non** esiste in un progetto Supabase stock. Finché non viene fornita, esegui
lo schema SQL manualmente nel SQL editor di Supabase (lo stesso DDL della route).
