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
-- COSA FA. Solo se c'e' gia' "Basic" (quindi il database e' nato dal bootstrap
-- nuovo) e manca "Free", crea una riga "Free" provvisoria, senza negozi e senza
-- prezzi. La migrazione del 23 ci scrive sopra quello che vuole; quella del 26 la
-- riconosce come un doppione del Basic e la toglie, prezzi compresi.
--
-- IN PRODUZIONE NON FA NIENTE. Li' "Basic" non esiste ancora (i nomi sono
-- Free/Pro/Business/Enterprise oppure Free/Core/Growth/Scale), quindi la
-- condizione e' falsa, sia che questa migrazione venga applicata prima di quella
-- del 23 sia che arrivi dopo, a posteriori.

INSERT INTO "plans" (
  "id", "plan_name", "max_products", "max_customers", "max_sync_frequency_hours",
  "custom_fields_limit", "support_level", "customers_sync_enabled",
  "product_feeds_enabled", "trial_days"
)
SELECT
  gen_random_uuid()::text, 'Free', 20, 0, 168, 3, 'community', false, false, 14
WHERE EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" = 'Basic')
  AND NOT EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" = 'Free');
