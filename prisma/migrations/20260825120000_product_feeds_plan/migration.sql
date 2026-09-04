-- I feed di catalogo sono una funzione del piano, come la sincronizzazione
-- clienti. Default false: chi la concede la accende a mano, invece di
-- ritrovarsela accesa ovunque senza averlo deciso.
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "product_feeds_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Sui piani a pagamento la si accende subito: e' cosi' che il listino e' stato
-- venduto finora.
--
-- Dentro un EXECUTE, e solo se la colonna c'e' ancora: `plans.price_monthly` e'
-- stata tolta due migrazioni piu' avanti (il listino vive in `plan_prices`), e
-- su un database nato da `0_init` non esiste. Postgres analizza l'intera query
-- prima di eseguirla, quindi una UPDATE nuda si fermerebbe qui anche senza
-- toccare una riga. Chi arriva da `0_init` ha gia' il listino giusto: i cinque
-- piani sono inseriti con `product_feeds_enabled` al valore di oggi.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans' AND column_name = 'price_monthly'
  ) THEN
    EXECUTE 'UPDATE "plans" SET "product_feeds_enabled" = true WHERE "price_monthly" > 0';
  END IF;
END
$$;
