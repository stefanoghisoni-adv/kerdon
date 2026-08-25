-- Via i prezzi da `plans`: da qui in poi il listino ha un posto solo.
--
-- Da applicare DOPO che il codice nuovo e' in produzione. Il codice vecchio
-- legge queste due colonne a ogni apertura della tab Piano: toglierle prima del
-- deploy fa fallire la lettura del listino, non degradare.
--
-- Prima di eseguire, verificare che ogni piano abbia la sua riga in dollari —
-- la migrazione precedente le crea, questa si fida:
--
--   SELECT p.plan_name FROM plans p
--   WHERE NOT EXISTS (SELECT 1 FROM plan_prices pp
--                     WHERE pp.plan_name = p.plan_name AND pp.currency = 'USD');
--
-- Se quella query restituisce righe, fermarsi: quei piani resterebbero a zero.
ALTER TABLE "plans" DROP COLUMN IF EXISTS "price_monthly";
ALTER TABLE "plans" DROP COLUMN IF EXISTS "price_yearly";
