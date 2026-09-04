-- CreateTable
--
-- IF NOT EXISTS ovunque, e la foreign key aggiunta dentro un blocco che
-- ingoia il doppione: da quando esiste `0_init` la catena riparte da un
-- database che ha gia' lo schema intero, e qui si fermerebbe con "relation
-- already exists". Vedi la nota in 20260714165105_add_connection_verified_at.
CREATE TABLE IF NOT EXISTS "supabase_oauth_tokens" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supabase_oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "supabase_oauth_tokens_shop_id_key" ON "supabase_oauth_tokens"("shop_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "supabase_oauth_tokens" ADD CONSTRAINT "supabase_oauth_tokens_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- La tabella porta i token OAuth di Supabase del merchant: RLS come su tutte
-- le altre, altrimenti la Data API la servirebbe a chiunque abbia la chiave
-- pubblica del progetto. Su un database creato da `0_init` e' gia' attiva e
-- questa riga non cambia niente.
ALTER TABLE "supabase_oauth_tokens" ENABLE ROW LEVEL SECURITY;
