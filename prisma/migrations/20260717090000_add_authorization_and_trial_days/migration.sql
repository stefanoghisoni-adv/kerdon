-- Shop authorization gate (ENABLED / PENDING / DISABLED)
--
-- IF NOT EXISTS: dopo `0_init` la colonna c'e' gia', e c'e' gia' come enum —
-- la conversione da testo la fa 20260723190000_authorization_enum, che qui
-- sotto non trova piu' niente da convertire. Vedi la nota in
-- 20260714165105_add_connection_verified_at.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "authorization" TEXT NOT NULL DEFAULT 'ENABLED';

-- Trial days limit per plan (null = no limit)
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "trial_days" INTEGER;
