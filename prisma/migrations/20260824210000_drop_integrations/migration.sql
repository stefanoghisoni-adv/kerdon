-- Via le tabelle delle integrazioni.
--
-- Il tracciamento lo gestisce GTM: l'app sincronizza catalogo, clienti e ordini
-- e calcola la profittabilita', e non deve diventare uno strumento di
-- tracciamento. Le due tabelle nate per quella strada non hanno piu' nessuno
-- che le legga.
DROP TABLE IF EXISTS "meta_connections";
DROP TABLE IF EXISTS "integration_platforms";
