-- I feed di catalogo sono una funzione del piano, come la sincronizzazione
-- clienti. Default false: chi la concede la accende a mano, invece di
-- ritrovarsela accesa ovunque senza averlo deciso.
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "product_feeds_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Sui piani a pagamento la si accende subito: e' cosi' che il listino e' stato
-- venduto finora.
UPDATE "plans" SET "product_feeds_enabled" = true WHERE "price_monthly" > 0;
