-- La valuta con cui il negozio vende, che non e' quella con cui paga noi.
-- Meta vuole "9.99 EUR" accanto a ogni prezzo e senza rifiuta il file intero.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "shop_currency" TEXT;

-- Un feed per negozio e per piattaforma. Il token e' cio' che sta
-- nell'indirizzo pubblico: unico, e sostituibile quando il merchant vuole
-- bruciare il vecchio.
CREATE TABLE IF NOT EXISTS "product_feeds" (
  "id"              TEXT         NOT NULL,
  "shop_id"         TEXT         NOT NULL,
  "platform"        TEXT         NOT NULL,
  "token"           TEXT         NOT NULL,
  "format"          TEXT         NOT NULL DEFAULT 'xml',
  "enabled"         BOOLEAN      NOT NULL DEFAULT true,
  "last_fetched_at" TIMESTAMP(3),
  "fetch_count"     INTEGER      NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_feeds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_feeds_token_key" ON "product_feeds"("token");
CREATE INDEX IF NOT EXISTS "product_feeds_token_idx" ON "product_feeds"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "product_feeds_shop_id_platform_key" ON "product_feeds"("shop_id", "platform");

DO $$
BEGIN
  ALTER TABLE "product_feeds"
    ADD CONSTRAINT "product_feeds_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- RLS, come su tutte le altre, e qui pesa: `token` e' la chiave con cui si
-- scarica il feed di un negozio senza autenticarsi. Mancava.
ALTER TABLE "product_feeds" ENABLE ROW LEVEL SECURITY;
