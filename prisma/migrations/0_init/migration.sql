-- Il database owner, da zero.
--
-- Lo SCHEMA qui sotto e' GENERATO da `prisma/schema.prisma`, che e' l'unica
-- fonte di verita': lo schema lo legge l'app, questo file lo legge solo chi
-- ricostruisce un ambiente. Scritto a mano divergeva, e lo faceva in silenzio —
-- prima di questa rigenerazione mancavano tre tabelle intere
-- (`product_feeds`, `feed_field_mappings`, `tracking_setups`) e una dozzina di
-- colonne, fra cui quelle appena aggiunte al billing. Da un database vuoto ne
-- usciva uno rotto, e nessuno lo sapeva perche' nessuno ricostruisce un
-- ambiente da zero tutti i giorni.
--
-- Per rigenerarlo dopo una modifica allo schema:
--
--   npx prisma migrate diff --from-empty \
--     --to-schema-datamodel prisma/schema.prisma --script
--
-- e si rimette in coda tutto cio' che sta dopo le chiavi esterne generate: i
-- cinque piani, il listino, le due chiavi esterne sul nome del piano, l'attivazione
-- di RLS e il partner iniziale. Non si generano perche' non sono struttura.
--
-- SOSTITUIRE, non aggiungere: la volta scorsa la DDL nuova e' finita SOPRA
-- quella vecchia invece che al suo posto, e nove tabelle sono rimaste
-- dichiarate due volte — su un database vuoto lo script si ferma al primo
-- `CREATE TABLE` ripetuto. Da allora c'e' `owner-bootstrap.test.ts`, che
-- confronta questo file con lo schema e non lascia passare ne' una tabella
-- ripetuta ne' una colonna mancante.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "authorization_state" AS ENUM ('ENABLED', 'PENDING', 'DISABLED');

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "access_token" TEXT NOT NULL,
    "user_id" BIGINT,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" TEXT,
    "account_owner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "email_verified" BOOLEAN DEFAULT false,
    "refresh_token" TEXT,
    "refresh_token_expires" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "current_plan" TEXT NOT NULL,
    "active_charge_id" TEXT,
    "trial_ends_at" TIMESTAMP(3),
    "is_in_trial" BOOLEAN NOT NULL DEFAULT true,
    "plan_started_at" TIMESTAMP(3),
    "plan_confirmed_at" TIMESTAMP(3),
    "tracking_checked_at" TIMESTAMP(3),
    "locale" TEXT,
    "setup_completed_at" TIMESTAMP(3),
    "preferred_currency" TEXT,
    "shop_currency" TEXT,
    "detected_locale" TEXT,
    "billing_currency" TEXT,
    "billing_cycle" TEXT,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),
    "authorization" "authorization_state" NOT NULL DEFAULT 'ENABLED',
    "tracking_authorization" "authorization_state" NOT NULL DEFAULT 'ENABLED',
    "iana_timezone" TEXT,
    "primary_domain" TEXT,
    "last_synced_plan" TEXT,
    "plan_banner_shown_at" TIMESTAMP(3),
    "birthdate_metafield_namespace" TEXT,
    "birthdate_metafield_key" TEXT,
    "read_proxy_token_hash" TEXT,
    "read_proxy_token_enc" TEXT,
    "partner_name" TEXT,
    "discount_intervals" INTEGER,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_setups" (
    "shop_id" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "platforms" TEXT[],
    "answered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_setups_pkey" PRIMARY KEY ("shop_id")
);

-- CreateTable
CREATE TABLE "supabase_configs" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "supabase_url" TEXT NOT NULL,
    "supabase_public_key" TEXT NOT NULL,
    "supabase_service_role_key" TEXT NOT NULL,
    "supabase_project_ref" TEXT,
    "supabase_project_name" TEXT,
    "table_name_products" TEXT NOT NULL DEFAULT 'products',
    "table_name_customers" TEXT NOT NULL DEFAULT 'customers',
    "sync_interval_hours" INTEGER NOT NULL DEFAULT 24,
    "connection_verified_at" TIMESTAMP(3),
    "schema_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supabase_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "max_products" INTEGER,
    "max_customers" INTEGER,
    "max_sync_frequency_hours" DOUBLE PRECISION NOT NULL,
    "custom_fields_limit" INTEGER,
    "support_level" TEXT NOT NULL,
    "customers_sync_enabled" BOOLEAN NOT NULL DEFAULT false,
    "product_feeds_enabled" BOOLEAN NOT NULL DEFAULT false,
    "trial_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_prices" (
    "id" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "price_monthly" DECIMAL(10,2) NOT NULL,
    "price_yearly" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_plan_prices" (
    "id" TEXT NOT NULL,
    "partner_name" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "price_monthly" DECIMAL(10,2) NOT NULL,
    "price_yearly" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "partner_plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dismissed_tracking_sources" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dismissed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dismissed_tracking_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_charges" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shopify_charge_id" BIGINT,
    "plan_type" TEXT NOT NULL,
    "price" DECIMAL(10,2),
    "currency" TEXT,
    "billing_cycle" TEXT,
    "status" TEXT NOT NULL,
    "trial_days" INTEGER NOT NULL DEFAULT 7,
    "trial_ends_at" TIMESTAMP(3),
    "confirmation_url" TEXT,
    "callback_nonce" TEXT,
    "callback_nonce_used_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "products_synced" INTEGER NOT NULL DEFAULT 0,
    "variants_synced" INTEGER NOT NULL DEFAULT 0,
    "customers_synced" INTEGER NOT NULL DEFAULT 0,
    "products_added" INTEGER NOT NULL DEFAULT 0,
    "products_removed" INTEGER NOT NULL DEFAULT 0,
    "customers_added" INTEGER NOT NULL DEFAULT 0,
    "customers_updated" INTEGER NOT NULL DEFAULT 0,
    "customers_suspended" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supabase_oauth_tokens" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supabase_oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_eligibility_snapshots" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "eligible_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_eligibility_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_job_events" (
    "id" TEXT NOT NULL,
    "sync_job_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "shopify_id" BIGINT,
    "variant_id" BIGINT,
    "label" TEXT NOT NULL,
    "sublabel" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_data_access_logs" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT,
    "outcome" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_data_access_logs_pkey" PRIMARY KEY ("id")
);

-- La coda durevole delle richieste di conformita'. Il webhook di Shopify scrive
-- qui e risponde subito: il 2xx e' una ricevuta, non una consegna, e la
-- richiesta viene tagliata a cinque secondi. Il lavoro vero — l'esportazione o
-- la cancellazione — avviene dopo, e la riga ne tiene tentativi ed esito.
CREATE TABLE "compliance_requests" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "data_request_id" TEXT,
    "topic" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shop_id" TEXT,
    "customer_ref" TEXT,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "export" JSONB,
    "export_expires_at" TIMESTAMP(3),
    "downloaded_at" TIMESTAMP(3),

    CONSTRAINT "compliance_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_feeds" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'xml',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_fetched_at" TIMESTAMP(3),
    "fetch_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_field_mappings" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "variable" TEXT NOT NULL,
    "recent" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feed_field_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_shop_domain_key" ON "shops"("shop_domain");

-- CreateIndex
CREATE UNIQUE INDEX "shops_read_proxy_token_hash_key" ON "shops"("read_proxy_token_hash");

-- CreateIndex
CREATE INDEX "shops_shop_domain_idx" ON "shops"("shop_domain");

-- CreateIndex
CREATE UNIQUE INDEX "supabase_configs_shop_id_key" ON "supabase_configs"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "plans_plan_name_key" ON "plans"("plan_name");

-- Un prezzo solo per piano e valuta: due righe per la stessa coppia sarebbero
-- di nuovo due prezzi in disaccordo, che e' il guaio da cui si viene.
CREATE UNIQUE INDEX "plan_prices_plan_name_currency_key" ON "plan_prices"("plan_name", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "partners_name_key" ON "partners"("name");

-- CreateIndex
CREATE UNIQUE INDEX "partner_plan_prices_partner_name_plan_name_key" ON "partner_plan_prices"("partner_name", "plan_name");

-- CreateIndex
CREATE UNIQUE INDEX "dismissed_tracking_sources_shop_id_kind_name_key" ON "dismissed_tracking_sources"("shop_id", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "billing_charges_shopify_charge_id_key" ON "billing_charges"("shopify_charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_charges_callback_nonce_key" ON "billing_charges"("callback_nonce");

-- CreateIndex
CREATE INDEX "billing_charges_shop_id_idx" ON "billing_charges"("shop_id");

-- CreateIndex
CREATE INDEX "sync_jobs_shop_id_idx" ON "sync_jobs"("shop_id");

-- CreateIndex
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs"("status");

-- CreateIndex
CREATE INDEX "sync_jobs_started_at_idx" ON "sync_jobs"("started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "supabase_oauth_tokens_shop_id_key" ON "supabase_oauth_tokens"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_eligibility_snapshots_shop_id_day_key" ON "product_eligibility_snapshots"("shop_id", "day");

-- CreateIndex
CREATE INDEX "sync_job_events_sync_job_id_idx" ON "sync_job_events"("sync_job_id");

-- CreateIndex
CREATE INDEX "customer_data_access_logs_shop_id_created_at_idx" ON "customer_data_access_logs"("shop_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "customer_data_access_logs_created_at_idx" ON "customer_data_access_logs"("created_at");

-- La deduplica delle consegne ripetute: l'id della consegna e', in seconda
-- battuta, la pratica lato Shopify. I NULL non si contano fra loro, quindi i
-- topic senza `data_request.id` non danno fastidio.
CREATE UNIQUE INDEX "compliance_requests_webhook_id_key" ON "compliance_requests"("webhook_id");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_requests_shop_domain_data_request_id_key" ON "compliance_requests"("shop_domain", "data_request_id");

-- CreateIndex
CREATE INDEX "compliance_requests_status_received_at_idx" ON "compliance_requests"("status", "received_at");

-- CreateIndex
CREATE INDEX "compliance_requests_shop_domain_received_at_idx" ON "compliance_requests"("shop_domain", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "product_feeds_token_key" ON "product_feeds"("token");

-- CreateIndex
CREATE INDEX "product_feeds_token_idx" ON "product_feeds"("token");

-- CreateIndex
CREATE UNIQUE INDEX "product_feeds_shop_id_platform_key" ON "product_feeds"("shop_id", "platform");

-- CreateIndex
CREATE INDEX "feed_field_mappings_shop_id_platform_idx" ON "feed_field_mappings"("shop_id", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "feed_field_mappings_shop_id_platform_field_key" ON "feed_field_mappings"("shop_id", "platform", "field");

-- SET NULL e non CASCADE: cancellare un partner non deve portarsi via i negozi.
ALTER TABLE "shops" ADD CONSTRAINT "shops_partner_name_fkey" FOREIGN KEY ("partner_name") REFERENCES "partners"("name") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_setups" ADD CONSTRAINT "tracking_setups_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supabase_configs" ADD CONSTRAINT "supabase_configs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rinominare un piano porta con se' i suoi prezzi; cancellarlo li porta via.
-- Un prezzo orfano sarebbe un listino per un piano che non esiste.
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_name_fkey" FOREIGN KEY ("plan_name") REFERENCES "plans"("plan_name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_plan_prices" ADD CONSTRAINT "partner_plan_prices_partner_name_fkey" FOREIGN KEY ("partner_name") REFERENCES "partners"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dismissed_tracking_sources" ADD CONSTRAINT "dismissed_tracking_sources_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supabase_oauth_tokens" ADD CONSTRAINT "supabase_oauth_tokens_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_eligibility_snapshots" ADD CONSTRAINT "product_eligibility_snapshots_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_job_events" ADD CONSTRAINT "sync_job_events_sync_job_id_fkey" FOREIGN KEY ("sync_job_id") REFERENCES "sync_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL e non CASCADE: se il negozio sparisce il registro resta. Un log che
-- si cancella insieme a cio' che documenta non e' un log.
ALTER TABLE "customer_data_access_logs" ADD CONSTRAINT "customer_data_access_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SET NULL e non CASCADE: shop/redact cancella il negozio, e la riga che sta
-- registrando quella stessa cancellazione non puo' sparire mentre la esegue.
ALTER TABLE "compliance_requests" ADD CONSTRAINT "compliance_requests_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_feeds" ADD CONSTRAINT "product_feeds_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_field_mappings" ADD CONSTRAINT "feed_field_mappings_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- I piani: cinque righe copiate dal database owner in uso.
--
-- Non si generano dallo schema perche' non sono struttura, sono scelte:
-- quanti prodotti, ogni quanto si sincronizza, quanto costa. Vanno tenute
-- allineate a mano quando il listino cambia.
--
-- (C'era un `prisma/seed.ts` che le costruiva ed era rimasto indietro — nomi
-- minuscoli, prezzi vecchi. E' stato tolto, ed e' bene che non torni: una
-- seconda fonte per gli stessi cinque piani e' una seconda cosa da ricordarsi
-- di aggiornare.)
INSERT INTO "plans" ("id", "plan_name", "max_products", "max_customers", "max_sync_frequency_hours", "custom_fields_limit", "support_level", "customers_sync_enabled", "product_feeds_enabled", "created_at", "trial_days") VALUES
  ('60b36215-e0d0-48e4-8f59-1550028a1078', 'Free',        50,  200, 168.00,    3, 'community', false, false, '2026-07-14 15:48:23.356115', 14),
  ('316217c4-3a7b-40f8-9f7c-8d5ddc1d5daa', 'Pro',        200,  500,  96.00,   10, 'email',     true,  true,  '2026-07-14 15:48:23.356115', 14),
  ('eb31cfe0-d134-4421-a4d6-0f6e2a89f88d', 'Business',  1000, 2000,  48.00,   50, 'priority',  true,  true,  '2026-07-14 15:48:23.356115', 14),
  ('fdf4476c-ab51-44f7-ba28-a785cddb3ec9', 'Enterprise',NULL, NULL,  24.00, NULL, 'dedicated', true,  true,  '2026-07-14 15:48:23.356115', 14),
  ('0b896582-5f98-41b3-9073-65c9874b8360', 'Lifetime',  NULL, NULL,   0.50, NULL, 'dedicated', true,  true,  '2026-07-17 02:30:10.250832', NULL);

-- Il listino, in dollari: la valuta base, quella della scheda dell'App Store.
--
-- Ogni piano ha la sua riga, anche quelli che non si pagano: zero e' un prezzo
-- scritto, non un'assenza. E' da queste righe che l'app sa quali piani sono a
-- pagamento — senza, li darebbe tutti per gratuiti.
--
-- Le altre valute si aggiungono qui accanto, una riga per piano. Una valuta si
-- usa solo se copre TUTTI i piani a pagamento: a meta' listino le card
-- mostrerebbero due valute affiancate, e a quel punto non si capisce piu' né
-- l'una né l'altra.
INSERT INTO "plan_prices" ("id", "plan_name", "currency", "price_monthly", "price_yearly") VALUES
  (gen_random_uuid(), 'Free',       'USD',  0.00,    0.00),
  (gen_random_uuid(), 'Pro',        'USD', 19.00,  290.00),
  (gen_random_uuid(), 'Business',   'USD', 49.00,  990.00),
  (gen_random_uuid(), 'Enterprise', 'USD', 79.00, 2990.00),
  (gen_random_uuid(), 'Lifetime',   'USD',  0.00,    0.00);

-- Le due chiavi esterne sul nome del piano. Non le genera `migrate diff`:
-- schema.prisma non modella la relazione fra shops e plans, ma il database in
-- uso le ha e il codice ci conta. Vanno dopo l'INSERT, altrimenti non c'e'
-- niente a cui puntare.
ALTER TABLE "shops" ADD CONSTRAINT "shops_current_plan_fkey"
  FOREIGN KEY ("current_plan") REFERENCES "plans"("plan_name")
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "shops" ADD CONSTRAINT "shops_last_synced_plan_fkey"
  FOREIGN KEY ("last_synced_plan") REFERENCES "plans"("plan_name")
  ON UPDATE CASCADE ON DELETE SET NULL;

-- RLS attiva ovunque, e nessuna policy: e' voluto.
--
-- Supabase pubblica lo schema `public` attraverso la Data API. Senza RLS
-- chiunque abbia la anon key del progetto — che e' una chiave pensata per stare
-- nei browser, non un segreto — potrebbe leggere queste tabelle. E qui dentro ci
-- sono i token di accesso Shopify e le chiavi cifrate dei merchant.
--
-- Attivarla non tocca l'app: Prisma si collega come `postgres`, che e' il
-- proprietario delle tabelle, e il proprietario scavalca RLS (non c'e' FORCE ROW
-- LEVEL SECURITY). Zero policy significa che dalla Data API non si legge niente.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Partner di partenza: i negozi che seguiamo direttamente, senza agenzia.
INSERT INTO "partners" ("id", "name", "label")
VALUES (gen_random_uuid()::text, 'own_partner', 'Clienti diretti')
ON CONFLICT ("name") DO NOTHING;

