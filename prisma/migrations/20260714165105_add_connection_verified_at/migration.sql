-- AlterTable
--
-- IF NOT EXISTS: da quando esiste `0_init` la catena delle migrazioni riparte
-- sempre da un database che ha gia' lo schema intero, e un ADD COLUMN nudo si
-- fermerebbe qui con "column already exists". Chi lo verifica e' il job
-- `migrations` della CI, che rigioca tutta la catena su un Postgres vuoto.
ALTER TABLE "supabase_configs" ADD COLUMN IF NOT EXISTS "connection_verified_at" TIMESTAMP;
