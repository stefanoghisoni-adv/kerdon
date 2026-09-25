-- Il listino definitivo: Basic, Growth, Scale e Core. Niente limite sugli ordini.
--
-- PERCHE'. La migrazione 20260923000000_pricing_alignment aveva rinominato i
-- piani Free/Pro/Business/Enterprise in Free/Core/Growth/Scale, con Core come
-- piano da 29 €. La decisione del proprietario (25 settembre 2026) e' diversa:
--
--   0 €    Basic   (era Free)        20 prodotti,    clienti non sincronizzati
--   29 €   Growth  (era Pro / Core)  200 prodotti,   250 clienti
--   79 €   Scale   (era Business / Growth)  1.000 prodotti, 500 clienti
--   149 €  Core    (era Enterprise / Scale) prodotti e clienti illimitati
--
-- Annuale = dieci mensilita' (290 / 790 / 1.490), stesse cifre in EUR e in USD.
-- I feed di catalogo restano quelli di prima: esclusi sul Basic, inclusi sugli
-- altri, senza nessun tetto di quantita'. Gli ordini si sincronizzano sempre
-- tutti: la colonna max_orders era stata aggiunta per errore e se ne va.
-- Il piano Lifetime (assegnato a mano dall'owner, illimitato, non in vendita)
-- resta com'e'.
--
-- DA DOVE PARTE. Non si sa con certezza in che stato sia la produzione: il
-- workflow delle migrazioni non e' mai stato lanciato e parte dell'SQL e' stato
-- applicato a mano. Questa migrazione arriva al listino finale da ognuno dei
-- casi possibili, e rilanciata non cambia piu' niente:
--
--   A. Free/Pro/Business/Enterprise, prezzi vecchi (pricing_alignment mai eseguita);
--   B. Free/Core/Growth/Scale (pricing_alignment eseguita);
--   C. gia' Basic/Growth/Scale/Core: un database nato dal bootstrap nuovo, dove
--      pricing_alignment ha lasciato un "Free" provvisorio (vedi
--      20260922000000_pricing_alignment_guard), oppure un secondo lancio.
--
-- Si riconosce A o B dalla presenza di "Free" senza "Basic". In B i nomi Core,
-- Growth e Scale esistono gia' ma indicano lo scaglione SOTTO: per questo il
-- cambio di nome passa da nomi provvisori ("__kerdon__Growth"...), cosi' nessun
-- passaggio si scontra con il nome che un altro piano sta ancora usando.
--
-- LE CATENE SUL NOME DEL PIANO. plan_prices, shops.current_plan e
-- shops.last_synced_plan seguono il piano da sole (ON UPDATE CASCADE) se le
-- chiavi esterne ci sono. Non si da' per scontato che ci siano: prima di
-- rinominare si annota l'id del piano di ogni riga, e dopo si riscrive il nome
-- partendo dall'id, che non cambia. Con le chiavi esterne presenti quel secondo
-- passaggio non trova niente da fare. partner_plan_prices.plan_name e
-- billing_charges.plan_type non hanno chiavi esterne e si allineano allo stesso
-- modo; i vecchi nomi Free/Pro/Business/Enterprise rimasti li' senza un piano
-- corrispondente (la migrazione del 23 non li aveva toccati) si traducono con la
-- mappa fissa, che non e' ambigua.
--
-- Un abbonamento Shopify gia' attivo porta ancora il nome con cui e' nato: l'app
-- lo riconosce dall'id dell'abbonamento e, dove serve, dal prezzo (vedi
-- app/lib/billing/plan-tiers.ts). Qui non si tocca niente su Shopify.

DO $$
DECLARE
  da_rinominare boolean;
  mancanti text;
BEGIN
  da_rinominare := EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" = 'Free')
    AND NOT EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" = 'Basic');

  -- Nomi di A e di B insieme: uno stato che nessun percorso produce. Meglio
  -- fermarsi che fondere due piani a caso.
  IF da_rinominare
     AND EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" IN ('Pro', 'Business', 'Enterprise'))
     AND EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" IN ('Core', 'Growth', 'Scale')) THEN
    RAISE EXCEPTION 'listino in uno stato non riconosciuto: nomi vecchi (Pro/Business/Enterprise) e intermedi (Core/Growth/Scale) insieme';
  END IF;

  -- 1. L'id del piano di ogni riga che lo cita per nome, prima di rinominare.
  DROP TABLE IF EXISTS "_kerdon_negozi";
  CREATE TEMP TABLE "_kerdon_negozi" ON COMMIT DROP AS
    SELECT s."id" AS "shop_id", pc."id" AS "current_id", pl."id" AS "last_id"
    FROM "shops" s
    LEFT JOIN "plans" pc ON pc."plan_name" = s."current_plan"
    LEFT JOIN "plans" pl ON pl."plan_name" = s."last_synced_plan";

  DROP TABLE IF EXISTS "_kerdon_partner";
  CREATE TEMP TABLE "_kerdon_partner" ON COMMIT DROP AS
    SELECT pp."id" AS "row_id", p."id" AS "plan_id"
    FROM "partner_plan_prices" pp
    JOIN "plans" p ON p."plan_name" = pp."plan_name";

  DROP TABLE IF EXISTS "_kerdon_addebiti";
  CREATE TEMP TABLE "_kerdon_addebiti" ON COMMIT DROP AS
    SELECT b."id" AS "row_id", p."id" AS "plan_id"
    FROM "billing_charges" b
    JOIN "plans" p ON p."plan_name" = b."plan_type";

  -- 2. Stati A e B: il cambio di nome, in due tempi.
  IF da_rinominare THEN
    UPDATE "plans" p
       SET "plan_name" = '__kerdon__' || m."target"
      FROM (VALUES
        ('Free', 'Basic'),
        ('Pro', 'Growth'), ('Business', 'Scale'), ('Enterprise', 'Core'),
        ('Core', 'Growth'), ('Growth', 'Scale'), ('Scale', 'Core')
      ) AS m("source", "target")
     WHERE p."plan_name" = m."source";

    UPDATE "plans"
       SET "plan_name" = substr("plan_name", 11)
     WHERE left("plan_name", 10) = '__kerdon__';
  END IF;

  -- 3. Le righe che citano il piano per nome, riscritte a partire dall'id.
  UPDATE "shops" s
     SET "current_plan" = p."plan_name"
    FROM "_kerdon_negozi" n
    JOIN "plans" p ON p."id" = n."current_id"
   WHERE s."id" = n."shop_id" AND s."current_plan" IS DISTINCT FROM p."plan_name";

  UPDATE "shops" s
     SET "last_synced_plan" = p."plan_name"
    FROM "_kerdon_negozi" n
    JOIN "plans" p ON p."id" = n."last_id"
   WHERE s."id" = n."shop_id" AND s."last_synced_plan" IS DISTINCT FROM p."plan_name";

  UPDATE "billing_charges" b
     SET "plan_type" = p."plan_name"
    FROM "_kerdon_addebiti" a
    JOIN "plans" p ON p."id" = a."plan_id"
   WHERE b."id" = a."row_id" AND b."plan_type" IS DISTINCT FROM p."plan_name";

  -- Il listino riservato ha un indice unico (partner, piano): due tempi anche qui.
  UPDATE "partner_plan_prices" pp
     SET "plan_name" = '__kerdon__' || p."plan_name"
    FROM "_kerdon_partner" r
    JOIN "plans" p ON p."id" = r."plan_id"
   WHERE pp."id" = r."row_id" AND pp."plan_name" IS DISTINCT FROM p."plan_name";

  UPDATE "partner_plan_prices"
     SET "plan_name" = substr("plan_name", 11)
   WHERE left("plan_name", 10) = '__kerdon__';

  -- 4. I nomi vecchi rimasti: righe senza piano corrispondente, oppure un piano
  --    vecchio accanto al suo successore (il "Free" provvisorio dello stato C).
  --    La mappa Free/Pro/Business/Enterprise non e' ambigua: si applica sempre.
  DROP TABLE IF EXISTS "_kerdon_mappa";
  CREATE TEMP TABLE "_kerdon_mappa" ON COMMIT DROP AS
    SELECT * FROM (VALUES
      ('Free', 'Basic'), ('Pro', 'Growth'), ('Business', 'Scale'), ('Enterprise', 'Core')
    ) AS m("source", "target")
    WHERE EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" = m."target");

  UPDATE "shops" s SET "current_plan" = m."target"
    FROM "_kerdon_mappa" m WHERE s."current_plan" = m."source";
  UPDATE "shops" s SET "last_synced_plan" = m."target"
    FROM "_kerdon_mappa" m WHERE s."last_synced_plan" = m."source";
  UPDATE "billing_charges" b SET "plan_type" = m."target"
    FROM "_kerdon_mappa" m WHERE b."plan_type" = m."source";

  -- Un prezzo riservato col nome vecchio, quando il partner ne ha gia' uno col
  -- nome nuovo: vale quello nuovo, il doppione se ne va.
  DELETE FROM "partner_plan_prices" pp
   USING "_kerdon_mappa" m
   WHERE pp."plan_name" = m."source"
     AND EXISTS (
       SELECT 1 FROM "partner_plan_prices" altro
        WHERE altro."partner_name" = pp."partner_name" AND altro."plan_name" = m."target"
     );
  UPDATE "partner_plan_prices" pp SET "plan_name" = m."target"
    FROM "_kerdon_mappa" m WHERE pp."plan_name" = m."source";

  -- Ora nessuno cita piu' il piano vecchio: si puo' togliere (i suoi prezzi
  -- vanno con lui).
  DELETE FROM "plans" p USING "_kerdon_mappa" m WHERE p."plan_name" = m."source";

  -- 5. I quattro piani devono esserci tutti, prima di scriverci sopra.
  SELECT string_agg(atteso, ', ') INTO mancanti
    FROM unnest(ARRAY['Basic', 'Growth', 'Scale', 'Core']) AS atteso
   WHERE NOT EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" = atteso);
  IF mancanti IS NOT NULL THEN
    RAISE EXCEPTION 'piani mancanti dopo il cambio di nome: %', mancanti;
  END IF;

  -- 6. Limiti e funzioni. Stessi valori di app/lib/billing/plan-tiers.ts e del
  --    seed di owner-bootstrap.sql: un test li confronta.
  UPDATE "plans" p
     SET "max_products" = l."max_products",
         "max_customers" = l."max_customers",
         "customers_sync_enabled" = l."customers_sync_enabled",
         "product_feeds_enabled" = l."product_feeds_enabled"
    FROM (VALUES
      ('Basic',  20,         0,          false, false),
      ('Growth', 200,        250,        true,  true),
      ('Scale',  1000,       500,        true,  true),
      ('Core',   NULL::int,  NULL::int,  true,  true)
    ) AS l("plan_name", "max_products", "max_customers", "customers_sync_enabled", "product_feeds_enabled")
   WHERE p."plan_name" = l."plan_name";

  -- 7. Il listino, in euro e in dollari.
  INSERT INTO "plan_prices" ("id", "plan_name", "currency", "price_monthly", "price_yearly")
  SELECT gen_random_uuid()::text, l."plan_name", c."currency", l."price_monthly", l."price_yearly"
    FROM (VALUES
      ('Basic',    0.00,    0.00),
      ('Growth',  29.00,  290.00),
      ('Scale',   79.00,  790.00),
      ('Core',   149.00, 1490.00)
    ) AS l("plan_name", "price_monthly", "price_yearly")
    CROSS JOIN (VALUES ('EUR'), ('USD')) AS c("currency")
  ON CONFLICT ("plan_name", "currency") DO UPDATE
     SET "price_monthly" = EXCLUDED."price_monthly",
         "price_yearly" = EXCLUDED."price_yearly";
END
$$;

-- 8. Gli ordini non hanno limite: la colonna non serve a niente e a nessuno.
ALTER TABLE "plans" DROP COLUMN IF EXISTS "max_orders";
