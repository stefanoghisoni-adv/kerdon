-- Configurazione dei costi di spedizione: zone, tariffe, confezionamento.
--
-- PERCHE'. La colonna `total_shipping` su `orders` arriva sempre zero: Shopify
-- la restituisce solo con i permessi `read_shipping`, che richiedono
-- approvazione manuale per ogni negozio — un tetto insormontabile per un'app
-- destinata a merchant che vogliono installarla e basta. Senza un costo di
-- spedizione configurabile i margini restano sbagliati di una delle voci piu'
-- importanti: il merchant che confronta i dati dell'app con i suoi registri
-- vede numeri che non combaciano, e smette di fidarsi.
--
-- Zone di spedizione con tariffe lineari o a fasce (il merchant sceglie quale).
-- Tariffe a peso, in euro per chilo oppure in euro fissi per fascia di peso.
-- Confezionamento: categorie (imballaggio piccolo € 0.50, medio € 1.20) con
-- regole di fallback per peso ("fino a 2 kg usa 'piccolo', il resto 'medio'") e
-- un peso di default per gli articoli che su Shopify non ce l'hanno. Reso: costo
-- fisso facoltativo, sottratto se l'ordine risulta restituito.
--
-- Il calcolo resta interno, non esce mai: lo vede solo il merchant nel suo
-- database — margine, profitto, ACP — per farci sopra i suoi conti, e nessuno
-- dei dati verso l'esterno (bridge, feed catalogo) lo coinvolge.
--
-- Additive: quattro tabelle nuove, nessuna colonna su quelle esistenti.

CREATE TABLE IF NOT EXISTS "shipping_zones" (
  "id"            TEXT         NOT NULL,
  "shop_id"       TEXT         NOT NULL,
  "zone_name"     TEXT         NOT NULL,
  "countries"     TEXT[]       NOT NULL,
  "rest_of_world" BOOLEAN      NOT NULL DEFAULT false,
  "rate_type"     TEXT         NOT NULL DEFAULT 'linear',
  "synced_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipping_zones_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "shipping_zones_shop_id_zone_name_key"
  ON "shipping_zones" ("shop_id", "zone_name");
CREATE INDEX IF NOT EXISTS "shipping_zones_shop_id_idx"
  ON "shipping_zones" ("shop_id");

CREATE TABLE IF NOT EXISTS "shipping_rates" (
  "id"          TEXT           NOT NULL,
  "zone_id"     TEXT           NOT NULL,
  "weight_from" DECIMAL(10, 3),
  "weight_to"   DECIMAL(10, 3),
  "cost"        DECIMAL(10, 2) NOT NULL,
  CONSTRAINT "shipping_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "shipping_rates_zone_id_idx"
  ON "shipping_rates" ("zone_id");

CREATE TABLE IF NOT EXISTS "packaging_config" (
  "shop_id"                  TEXT           NOT NULL,
  "categories"               JSONB          NOT NULL DEFAULT '[]',
  "fallback_rules"           JSONB          NOT NULL DEFAULT '[]',
  "default_weight_per_item"  DECIMAL(10, 3),
  "return_cost"              DECIMAL(10, 2),
  "updated_at"               TIMESTAMP(3)   NOT NULL,
  CONSTRAINT "packaging_config_pkey" PRIMARY KEY ("shop_id")
);

CREATE TABLE IF NOT EXISTS "shipping_alert_dismissals" (
  "shop_id"      TEXT         NOT NULL,
  "dismissed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipping_alert_dismissals_pkey" PRIMARY KEY ("shop_id")
);

-- Foreign keys con ON DELETE CASCADE: cancellando la zona si cancellano le sue
-- tariffe; cancellando il negozio si cancella tutta la sua configurazione.
DO $$
BEGIN
  ALTER TABLE "shipping_zones"
    ADD CONSTRAINT "shipping_zones_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "shipping_rates"
    ADD CONSTRAINT "shipping_rates_zone_id_fkey"
    FOREIGN KEY ("zone_id") REFERENCES "shipping_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "packaging_config"
    ADD CONSTRAINT "packaging_config_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "shipping_alert_dismissals"
    ADD CONSTRAINT "shipping_alert_dismissals_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- RLS su tutte e quattro, come su ogni altra tabella dello schema public.
-- La Data API di Supabase espone public: senza RLS basterebbe la anon key di un
-- progetto — una chiave pensata per stare nei browser — per leggere la
-- configurazione di spedizione di tutti i negozi. Nessuna policy: Prisma si
-- collega come proprietario e scavalca RLS, zero policy significa che dalla Data
-- API non si legge niente.
ALTER TABLE "shipping_zones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipping_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "packaging_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipping_alert_dismissals" ENABLE ROW LEVEL SECURITY;
