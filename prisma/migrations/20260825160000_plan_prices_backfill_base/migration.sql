-- Il listino si trasferisce in `plan_prices`, dollaro compreso.
--
-- Prima stava in due posti: le colonne `price_monthly`/`price_yearly` su
-- `plans` e le righe per valuta in `plan_prices`. Niente teneva d'accordo i
-- due, e chi amministrava scriveva il dollaro nella tabella per valuta mentre
-- l'app leggeva la colonna sul piano: il prezzo mostrato non era quello
-- scritto, e non c'era modo di accorgersene se non guardandoli entrambi.
--
-- Questa migrazione NON toglie niente: copia solo quello che manca. Va
-- applicata PRIMA di mandare in produzione il codice nuovo, cosi' il codice
-- vecchio continua a funzionare mentre le righe ci sono gia'.
-- Dentro un EXECUTE, e solo se le colonne di partenza ci sono ancora: la
-- migrazione successiva le toglie da `plans`, e su un database nato da `0_init`
-- non sono mai esistite. Postgres analizza l'intera query prima di eseguirla,
-- quindi una INSERT ... SELECT nuda si fermerebbe qui con "column p.price_monthly
-- does not exist" anche quando non c'e' niente da copiare. Chi arriva da
-- `0_init` ha gia' le cinque righe in dollari.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans' AND column_name = 'price_monthly'
  ) THEN
    EXECUTE $sql$
      INSERT INTO "plan_prices" ("id", "plan_name", "currency", "price_monthly", "price_yearly")
      SELECT
        gen_random_uuid(),
        p."plan_name",
        'USD',
        p."price_monthly",
        p."price_yearly"
      FROM "plans" p
      WHERE NOT EXISTS (
        SELECT 1 FROM "plan_prices" pp
        WHERE pp."plan_name" = p."plan_name" AND pp."currency" = 'USD'
      )
    $sql$;
  END IF;
END
$$;

-- Le righe gia' presenti restano come sono: se qualcuno ha scritto un prezzo in
-- dollari dentro `plan_prices`, quello e' il prezzo voluto — era proprio il
-- numero che l'app non leggeva.
