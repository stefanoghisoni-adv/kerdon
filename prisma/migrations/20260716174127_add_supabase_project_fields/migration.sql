-- AlterTable
--
-- IF NOT EXISTS: dopo `0_init` le colonne ci sono gia'. Vedi la nota in
-- 20260714165105_add_connection_verified_at.
ALTER TABLE "supabase_configs" ADD COLUMN IF NOT EXISTS "supabase_db_password" TEXT;
ALTER TABLE "supabase_configs" ADD COLUMN IF NOT EXISTS "supabase_project_ref" TEXT;
