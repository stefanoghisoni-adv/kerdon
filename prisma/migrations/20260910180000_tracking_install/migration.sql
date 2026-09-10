-- Come il merchant ha installato il ponte del tracciamento, in colonne sue.
--
-- PERCHE'. Le tre informazioni — quale strada, quale indirizzo, se la verifica
-- e' passata — erano nate come voci con un prefisso riservato dentro
-- `tracking_setups.platforms`, che e' l'elenco delle piattaforme di marketing
-- che il merchant ha spuntato. Funzionava, ma in quell'elenco finivano in mezzo
-- ai nomi veri: la dashboard e l'esportazione dei dati del negozio dovevano
-- ricordarsi di filtrarle, e bastava dimenticarsene una volta per mostrare al
-- merchant "kerdon:install=sgtm" fra le sue piattaforme.
--
-- Additive: tre colonne che nascono vuote. Vuote vogliono dire "nessuna strada
-- scelta", che e' vero per ogni negozio che non e' ancora passato di qui.
ALTER TABLE "tracking_setups" ADD COLUMN IF NOT EXISTS "install_path" TEXT;
ALTER TABLE "tracking_setups" ADD COLUMN IF NOT EXISTS "endpoint" TEXT;
ALTER TABLE "tracking_setups" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMP(3);
