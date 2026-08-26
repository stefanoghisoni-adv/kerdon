-- Quattordici giorni di prova su ogni piano, non solo sul gratuito.
--
-- `trial_days` finisce dritto in `trialDays` della subscription di Shopify: e'
-- Shopify a non addebitare nulla per quei giorni. Prima era 14 sul Free e NULL
-- sugli altri, cioe' addebito immediato — e un piano che si paga dal primo
-- minuto e' molto piu' difficile da provare.
--
-- Lifetime resta fuori: e' assegnato da noi e non passa dal pagamento, quindi
-- una prova non vuol dire niente.
UPDATE "plans"
SET "trial_days" = 14
WHERE "plan_name" <> 'Lifetime';
