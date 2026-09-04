-- Valuta in cui Shopify fattura il merchant (shopBillingPreferences).
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "billing_currency" TEXT;

-- Listino nelle valute diverse da quella base (EUR, che vive in "plans").
CREATE TABLE IF NOT EXISTS "plan_prices" (
  "id" TEXT NOT NULL,
  "plan_name" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "price_monthly" DECIMAL(10,2) NOT NULL,
  "price_yearly" DECIMAL(10,2) NOT NULL,
  CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "plan_prices_plan_name_currency_key"
  ON "plan_prices" ("plan_name", "currency");

-- Rieseguibile: il vincolo si aggiunge solo se non c'e' gia', cosi' lanciare
-- il file due volte (o su un database dove era gia' passato) non si ferma a
-- meta'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_prices_plan_name_fkey'
  ) THEN
    ALTER TABLE "plan_prices"
      ADD CONSTRAINT "plan_prices_plan_name_fkey"
      FOREIGN KEY ("plan_name") REFERENCES "plans" ("plan_name")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Valuta dell'addebito: un importo senza valuta non risponde alla domanda
-- "quanto ho pagato". Le righe gia' scritte sono tutte in euro.
ALTER TABLE "billing_charges" ADD COLUMN IF NOT EXISTS "currency" TEXT;

-- RLS, come su tutte le altre: la Data API di Supabase pubblica lo schema
-- public, e una tabella senza RLS e' leggibile con la sola chiave pubblica del
-- progetto. Qui c'e' il listino, che non e' un segreto — ma la regola non ha
-- eccezioni, altrimenti diventa una cosa da valutare ogni volta e prima o poi
-- si valuta male. Mancava.
ALTER TABLE "plan_prices" ENABLE ROW LEVEL SECURITY;
