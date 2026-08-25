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
);

-- Le righe gia' presenti restano come sono: se qualcuno ha scritto un prezzo in
-- dollari dentro `plan_prices`, quello e' il prezzo voluto — era proprio il
-- numero che l'app non leggeva.
