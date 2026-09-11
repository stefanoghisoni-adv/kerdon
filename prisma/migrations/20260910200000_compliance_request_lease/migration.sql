-- La presa di una richiesta di conformita': quando torna dovuta, e chi la sta
-- lavorando.
--
-- PERCHE'. Il conteggio dei tentativi era rotto in due punti che si sommavano.
-- La presa incrementava `attempts`, poi chi decideva la lettera morta riceveva
-- `attempts + 1`: lo stesso tentativo valeva due, e la richiesta di una persona
-- vera si fermava al quarto dichiarando di averne fatti cinque. E il
-- distanziamento fra un tentativo e l'altro era un intervallo fisso calcolato
-- su `started_at`, uguale per tutte le richieste dello stesso negozio — quindi
-- quando il progetto di un merchant smetteva di rispondere, tutte le sue
-- richieste tornavano pronte insieme e rifacevano insieme lo stesso errore.
--
-- `next_attempt_at` porta l'attesa sulla riga, decisa al momento del
-- fallimento con un backoff esponenziale e jitter. `lease_owner` e
-- `lease_expires_at` dicono chi ha in mano la richiesta e fino a quando: ogni
-- scrittura finale porta quel nome nella WHERE, cosi' un'invocazione
-- sopravvissuta a un deploy non chiude una pratica che sta lavorando un altro,
-- e una riga rimasta 'processing' con il lease scaduto torna prendibile da sola.
--
-- Additive, e nessuna riga esistente ne soffre: `next_attempt_at` nasce con
-- l'istante di adesso, quindi tutto cio' che era in attesa resta dovuto subito;
-- il lease nasce vuoto, e la presa tratta esplicitamente il lease nullo come
-- "lavorazione abbandonata" — che e' proprio la condizione delle righe rimaste
-- in volo durante il rilascio.
ALTER TABLE "compliance_requests" ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "compliance_requests" ADD COLUMN IF NOT EXISTS "lease_owner" TEXT;
ALTER TABLE "compliance_requests" ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP(3);

-- L'indice su cui gira il drenaggio: per stato e per quando la richiesta torna
-- dovuta. Quello su `received_at` resta, ma risponde a un'altra domanda.
CREATE INDEX IF NOT EXISTS "compliance_requests_status_next_attempt_at_idx" ON "compliance_requests"("status", "next_attempt_at");
