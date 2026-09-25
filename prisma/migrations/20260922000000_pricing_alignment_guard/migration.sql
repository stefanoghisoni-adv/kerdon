-- Un appoggio provvisorio per 20260923000000_pricing_alignment, e solo su un
-- database nuovo.
--
-- PERCHE'. Da 20260926000000_plans_basic_growth_scale_core in poi
-- `owner-bootstrap.sql` (e la sua copia `0_init`) semina direttamente il listino
-- finale: Basic, Growth, Scale, Core. La migrazione del 23 settembre pero' e' gia'
-- stata consegnata e non si tocca, e fra le altre cose inserisce il prezzo in
-- euro del piano "Free". Su un database nato dal bootstrap nuovo "Free" non
-- esiste, e la chiave esterna di plan_prices ferma l'intera catena: il job
-- `migrations` della CI e il server delle prove e2e, che rigiocano tutte le
-- migrazioni su un database vuoto, non arriverebbero in fondo.
--
-- COSA FA. Crea una riga "Free" provvisoria, senza negozi e senza prezzi, SOLO
-- se tutte queste cose sono vere:
--
--   1. c'e' gia' "Basic" e manca "Free": il listino e' gia' quello finale;
--   2. pricing_alignment e plans_basic_growth_scale_core stanno per girare
--      entrambe, dopo di questa. Lo dice `_prisma_migrations`: nessuna delle
--      due vi risulta conclusa. E' l'unico caso in cui la riga serve (alla
--      prima) e in cui qualcuno la togliera' (la seconda);
--   3. se `_prisma_migrations` non esiste (il server delle prove e2e applica i
--      file da solo, senza Prisma), il database non ha negozi: e' nuovo.
--
-- La migrazione del 23 ci scrive sopra quello che vuole; quella del 26 la
-- riconosce come un doppione del Basic e la toglie, prezzi compresi.
--
-- IN PRODUZIONE NON FA NIENTE:
--   - sui listini di prima (Free/Pro/Business/Enterprise o Free/Core/Growth/
--     Scale) "Basic" non c'e', quindi la condizione 1 e' falsa, in qualunque
--     ordine Prisma la applichi;
--   - se la migrazione del 26 e' gia' passata (anche incollata a mano
--     nell'editor e poi dichiarata applicata) la condizione 2 e' falsa, e non
--     resta nessun "Free" orfano. Se invece la si e' incollata a mano SENZA
--     dichiararla, rigira dopo questa e toglie la riga provvisoria.

DO $$
DECLARE
  serve boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" = 'Basic')
     OR EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" = 'Free') THEN
    RETURN;
  END IF;

  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE $q$
      SELECT NOT EXISTS (
        SELECT 1 FROM "_prisma_migrations"
         WHERE "finished_at" IS NOT NULL
           AND "rolled_back_at" IS NULL
           AND "migration_name" IN (
             '20260923000000_pricing_alignment',
             '20260926000000_plans_basic_growth_scale_core'
           )
      )
    $q$ INTO serve;
  ELSE
    serve := NOT EXISTS (SELECT 1 FROM "shops");
  END IF;

  IF serve THEN
    INSERT INTO "plans" (
      "id", "plan_name", "max_products", "max_customers", "max_sync_frequency_hours",
      "custom_fields_limit", "support_level", "customers_sync_enabled",
      "product_feeds_enabled", "trial_days"
    ) VALUES (
      gen_random_uuid()::text, 'Free', 20, 0, 168, 3, 'community', false, false, 14
    );
  END IF;
END
$$;
