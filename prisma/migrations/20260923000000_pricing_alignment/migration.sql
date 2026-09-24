-- Allineamento del pricing ai documenti approvati il 2026-09-20.
--
-- PRIMA:
--   Free/Pro/Business/Enterprise
--   Limiti su max_products (50/200/1000/NULL)
--   Prezzi $0/$19/$49/$79 mensili
--
-- DOPO:
--   Free/Core/Growth/Scale
--   Limiti su max_orders (50/500/3000/10000)
--   Prezzi €0/€29/€79/€149 mensili (USD allineati)
--
-- Ordine critico: aggiorna i prezzi PRIMA di rinominare i piani, altrimenti
-- i vecchi nomi non esistono più quando arriviamo agli UPDATE.

-- Step 1: Aggiungi colonna max_orders
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "max_orders" INT;

-- Step 2: Aggiorna i prezzi USD con i VECCHI nomi dei piani
UPDATE "plan_prices" SET "price_monthly" = 0.00, "price_yearly" = 0.00
WHERE "plan_name" = 'Free' AND "currency" = 'USD';

UPDATE "plan_prices" SET "price_monthly" = 29.00, "price_yearly" = 290.00
WHERE "plan_name" = 'Pro' AND "currency" = 'USD';

UPDATE "plan_prices" SET "price_monthly" = 79.00, "price_yearly" = 790.00
WHERE "plan_name" = 'Business' AND "currency" = 'USD';

UPDATE "plan_prices" SET "price_monthly" = 149.00, "price_yearly" = 1490.00
WHERE "plan_name" = 'Enterprise' AND "currency" = 'USD';

-- Step 3: Rinomina i piani nella tabella plans
-- La foreign key plan_prices.plan_name -> plans.plan_name ha ON UPDATE CASCADE,
-- quindi questo aggiorna automaticamente anche plan_prices
UPDATE "plans" SET "plan_name" = 'Scale' WHERE "plan_name" = 'Enterprise';
UPDATE "plans" SET "plan_name" = 'Growth' WHERE "plan_name" = 'Business';
UPDATE "plans" SET "plan_name" = 'Core' WHERE "plan_name" = 'Pro';
-- Free resta Free, Lifetime resta Lifetime

-- Step 4: Aggiorna i limiti con i NUOVI nomi
-- Free: 50 ordini/mese, max 10 prodotti
UPDATE "plans" SET
  "max_orders" = 50,
  "max_products" = 10,
  "max_customers" = 100
WHERE "plan_name" = 'Free';

-- Core: 500 ordini/mese, max 200 prodotti
UPDATE "plans" SET
  "max_orders" = 500,
  "max_products" = 200,
  "max_customers" = 500
WHERE "plan_name" = 'Core';

-- Growth: 3000 ordini/mese, max 1000 prodotti
UPDATE "plans" SET
  "max_orders" = 3000,
  "max_products" = 1000,
  "max_customers" = 2000
WHERE "plan_name" = 'Growth';

-- Scale: 10000 ordini/mese, prodotti e clienti illimitati
UPDATE "plans" SET
  "max_orders" = 10000,
  "max_products" = NULL,
  "max_customers" = NULL
WHERE "plan_name" = 'Scale';

-- Step 5: Aggiungi i prezzi in EUR (i piani hanno già i nuovi nomi)
INSERT INTO "plan_prices" ("id", "plan_name", "currency", "price_monthly", "price_yearly")
SELECT gen_random_uuid(), 'Free', 'EUR', 0.00, 0.00
WHERE NOT EXISTS (SELECT 1 FROM "plan_prices" WHERE "plan_name" = 'Free' AND "currency" = 'EUR');

INSERT INTO "plan_prices" ("id", "plan_name", "currency", "price_monthly", "price_yearly")
SELECT gen_random_uuid(), 'Core', 'EUR', 29.00, 290.00
WHERE NOT EXISTS (SELECT 1 FROM "plan_prices" WHERE "plan_name" = 'Core' AND "currency" = 'EUR');

INSERT INTO "plan_prices" ("id", "plan_name", "currency", "price_monthly", "price_yearly")
SELECT gen_random_uuid(), 'Growth', 'EUR', 79.00, 790.00
WHERE NOT EXISTS (SELECT 1 FROM "plan_prices" WHERE "plan_name" = 'Growth' AND "currency" = 'EUR');

INSERT INTO "plan_prices" ("id", "plan_name", "currency", "price_monthly", "price_yearly")
SELECT gen_random_uuid(), 'Scale', 'EUR', 149.00, 1490.00
WHERE NOT EXISTS (SELECT 1 FROM "plan_prices" WHERE "plan_name" = 'Scale' AND "currency" = 'EUR');

-- Step 6: Aggiorna i riferimenti ai piani in shops.current_plan
-- Non serve: la foreign key shops.current_plan -> plans.plan_name
-- ha ON UPDATE CASCADE, quindi si aggiorna automaticamente

-- Nota: il piano Lifetime non viene toccato
