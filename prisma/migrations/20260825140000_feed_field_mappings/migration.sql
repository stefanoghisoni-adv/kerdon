-- Come le colonne del catalogo diventano i campi di una piattaforma.
-- Serve a Google, che chiede una ventina di campi e li rifiuta in blocco se uno
-- e' scritto male: il merchant deve poter dire quale colonna riempie cosa.
CREATE TABLE IF NOT EXISTS "feed_field_mappings" (
  "id"         TEXT         NOT NULL,
  "shop_id"    TEXT         NOT NULL,
  "platform"   TEXT         NOT NULL,
  "field"      TEXT         NOT NULL,
  "variable"   TEXT         NOT NULL,
  -- Le ultime scelte su QUESTO campo, dalla piu' recente. Al massimo cinque.
  "recent"     TEXT[]       NOT NULL DEFAULT '{}',
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "feed_field_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "feed_field_mappings_shop_platform_field_key"
  ON "feed_field_mappings"("shop_id", "platform", "field");
CREATE INDEX IF NOT EXISTS "feed_field_mappings_shop_platform_idx"
  ON "feed_field_mappings"("shop_id", "platform");

DO $$
BEGIN
  ALTER TABLE "feed_field_mappings"
    ADD CONSTRAINT "feed_field_mappings_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- RLS, come su tutte le altre. Mancava.
ALTER TABLE "feed_field_mappings" ENABLE ROW LEVEL SECURITY;
