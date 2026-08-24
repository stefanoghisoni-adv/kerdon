-- La connessione di un negozio a Meta: credenziali e, quando scelti, account
-- pubblicitario e pixel.
CREATE TABLE IF NOT EXISTS "meta_connections" (
  "id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "access_token" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "ad_account_id" TEXT,
  "ad_account_name" TEXT,
  "pixel_id" TEXT,
  "pixel_name" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "meta_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "meta_connections_shop_id_key"
  ON "meta_connections" ("shop_id");

-- Scollegando l'app la connessione se ne va con il negozio.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'meta_connections_shop_id_fkey'
  ) THEN
    ALTER TABLE "meta_connections"
      ADD CONSTRAINT "meta_connections_shop_id_fkey"
      FOREIGN KEY ("shop_id") REFERENCES "shops" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
