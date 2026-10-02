-- Connessione OAuth, associazioni fra campi, conflitti e import da provider
-- esterni (Klaviyo).
--
-- PERCHE'. L'import dei dati clienti da Klaviyo vale a condizione che i dati
-- siano strutturati: il merchant sceglie quale proprieta' di Klaviyo finisce
-- in quale colonna del suo database (integration_field_mappings), l'import
-- gira sugli account Klaviyo collegati (integration_connections), e quando lo
-- stesso campo ha valori diversi si chiede a lui chi vince
-- (integration_conflicts). L'operazione intera e' una riga di
-- integration_import_runs, che tiene il cursore per riprenderla e i contatori
-- di cosa e' stato fatto.
--
-- Additiva: quattro tabelle nuove e basta.

-- CreateTable
CREATE TABLE IF NOT EXISTS "integration_connections" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMP(3),
    "account_name" TEXT,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "integration_field_mappings" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "target_field" TEXT NOT NULL,
    "date_format" TEXT,

    CONSTRAINT "integration_field_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "integration_conflicts" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "shopify_customer_id" BIGINT NOT NULL,
    "target_field" TEXT NOT NULL,
    "our_value" TEXT,
    "their_value" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "integration_import_runs" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cursor" TEXT,
    "counters" JSONB NOT NULL DEFAULT '{}',
    "sample" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "integration_import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "integration_connections_shop_id_provider_key" ON "integration_connections"("shop_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "integration_field_mappings_shop_id_provider_target_field_key" ON "integration_field_mappings"("shop_id", "provider", "target_field");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "integration_conflicts_shop_id_provider_shopify_customer_id_target_field_key" ON "integration_conflicts"("shop_id", "provider", "shopify_customer_id", "target_field");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "integration_conflicts_shop_id_status_idx" ON "integration_conflicts"("shop_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "integration_import_runs_shop_id_provider_started_at_idx" ON "integration_import_runs"("shop_id", "provider", "started_at");

-- AddForeignKey
ALTER TABLE "integration_connections"
  DROP CONSTRAINT IF EXISTS "integration_connections_shop_id_fkey";
ALTER TABLE "integration_connections"
  ADD CONSTRAINT "integration_connections_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_field_mappings"
  DROP CONSTRAINT IF EXISTS "integration_field_mappings_shop_id_fkey";
ALTER TABLE "integration_field_mappings"
  ADD CONSTRAINT "integration_field_mappings_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_conflicts"
  DROP CONSTRAINT IF EXISTS "integration_conflicts_shop_id_fkey";
ALTER TABLE "integration_conflicts"
  ADD CONSTRAINT "integration_conflicts_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_import_runs"
  DROP CONSTRAINT IF EXISTS "integration_import_runs_shop_id_fkey";
ALTER TABLE "integration_import_runs"
  ADD CONSTRAINT "integration_import_runs_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS su ogni tabella: la Data API di Supabase espone public, e senza RLS
-- basterebbe la anon key per leggere i dati. Nessuna policy: Prisma si collega
-- come proprietario e scavalca RLS.
ALTER TABLE "integration_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_field_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_conflicts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_import_runs" ENABLE ROW LEVEL SECURITY;
