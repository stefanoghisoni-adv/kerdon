-- Opzioni di spedizione: costi specifici per metodo di spedizione.
--
-- PERCHE'. In Shopify ogni zona contiene più metodi di spedizione (Standard,
-- Express, ecc). L'ordine dice quale metodo ha scelto il cliente, quindi il costo
-- si prende da quel metodo, non dalla tariffa generica della zona. Le opzioni
-- hanno tipi di costo diversi: flat (fisso), linear (EUR/kg), weight_brackets
-- (fasce peso), value_brackets (fasce valore ordine). Import automatico da
-- Shopify: i costi proposti partono a zero (le cifre Shopify sono quanto paga il
-- cliente, non il costo). Opzioni con lo stesso nome e condizioni diverse
-- diventano una sola opzione con più fasce. Abbinamento ordine → opzione: zona
-- dal paese, poi opzione per nome. Niente opzione che combacia → si usa la tariffa
-- generica della zona (ripiego).
--
-- Additive: due tabelle nuove, nessuna colonna su quelle esistenti.

CREATE TABLE IF NOT EXISTS "shipping_options" (
  "id"           TEXT         NOT NULL,
  "zone_id"      TEXT         NOT NULL,
  "name"         TEXT         NOT NULL,
  "cost_type"    TEXT         NOT NULL DEFAULT 'flat',
  "shopify_kind" TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipping_options_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "shipping_options_zone_id_name_key"
  ON "shipping_options" ("zone_id", "name");
CREATE INDEX IF NOT EXISTS "shipping_options_zone_id_idx"
  ON "shipping_options" ("zone_id");

CREATE TABLE IF NOT EXISTS "shipping_option_rates" (
  "id"         TEXT           NOT NULL,
  "option_id"  TEXT           NOT NULL,
  "range_from" DECIMAL(12, 3),
  "range_to"   DECIMAL(12, 3),
  "cost"       DECIMAL(10, 2) NOT NULL,
  CONSTRAINT "shipping_option_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "shipping_option_rates_option_id_idx"
  ON "shipping_option_rates" ("option_id");

-- Foreign keys con ON DELETE CASCADE: cancellando la zona si cancellano le sue
-- opzioni; cancellando l'opzione si cancellano le sue tariffe.
DO $$
BEGIN
  ALTER TABLE "shipping_options"
    ADD CONSTRAINT "shipping_options_zone_id_fkey"
    FOREIGN KEY ("zone_id") REFERENCES "shipping_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "shipping_option_rates"
    ADD CONSTRAINT "shipping_option_rates_option_id_fkey"
    FOREIGN KEY ("option_id") REFERENCES "shipping_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- RLS su entrambe, come su ogni altra tabella dello schema public.
ALTER TABLE "shipping_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipping_option_rates" ENABLE ROW LEVEL SECURITY;
