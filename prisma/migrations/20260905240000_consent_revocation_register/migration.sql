-- Il registro durevole delle revoche del tracciamento.
--
-- PERCHE'. La rimozione del legame browser-cliente e la cancellazione
-- dell'identificativo erano best effort da capo a fondo: `forgetVisitor`
-- scriveva un avviso nel log, le quattro rotte che la chiamano quel risultato
-- non lo guardavano, e il cookie `corew_eid` veniva fatto scadere comunque. Il
-- riferimento da cui si sarebbe potuto riprovare spariva dal browser, mentre
-- nel database del merchant restavano il legame e la riga del visitatore — e
-- non tornava a riprenderli nessuno, perche' il delta dei clienti puo'
-- benissimo non rivedere piu' quel cliente.
--
-- PERCHE' UNA TABELLA E NON UN TIPO NUOVO IN `sync_requests`. Il soggetto va
-- conservato CIFRATO e cancellato appena il lavoro riesce, e `payload` e' un
-- JSON in chiaro senza ritenzione propria; la deduplica dev'essere un HMAC del
-- soggetto, e `dedup_key` metterebbe l'identificativo in chiaro dentro un
-- indice unico; la coda lavora ogni item dentro il lucchetto del negozio, e una
-- revoca non puo' aspettare la fine di una sincronizzazione che dura minuti.
-- `sync_repairs` era l'altro candidato ed e' peggio: quel registro tiene
-- indietro il confine incrementale finche' una risorsa non e' rimessa a posto,
-- e una revoca con quel confine non c'entra niente.
--
-- Additive: una tabella nuova e basta. Nessuna riga esistente cambia
-- significato, e le revoche perse prima di questa migrazione restano perse —
-- non c'e' niente da cui ricostruirle.

CREATE TABLE IF NOT EXISTS "consent_revocations" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT,
    "scope" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "subject_cipher" TEXT,
    "customer_cipher" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "steps" JSONB,
    "last_error" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "subject_purged_at" TIMESTAMP(3),

    CONSTRAINT "consent_revocations_pkey" PRIMARY KEY ("id")
);

-- L'indice su cui poggia l'idempotenza: due revoche identiche diventano un
-- lavoro solo. La chiave e' un HMAC di negozio + scopo + soggetto, quindi
-- l'identificativo del browser NON compare in chiaro qui dentro — che e' il
-- motivo per cui `sync_requests.dedup_key` non poteva servire.
CREATE UNIQUE INDEX IF NOT EXISTS "consent_revocations_idempotency_key_key"
  ON "consent_revocations" ("idempotency_key");

-- Cosa c'e' da lavorare adesso: la query del drenaggio, a ogni giro del cron.
CREATE INDEX IF NOT EXISTS "consent_revocations_status_next_attempt_at_idx"
  ON "consent_revocations" ("status", "next_attempt_at");

-- Le revoche di un negozio per stato: serve a chi va a guardare dopo un
-- allarme, e al comando di replay.
CREATE INDEX IF NOT EXISTS "consent_revocations_shop_id_status_idx"
  ON "consent_revocations" ("shop_id", "status");

-- SET NULL e non CASCADE, come per `webhook_events`: la revoca deve
-- sopravvivere alla riga del negozio. E' la prova che una persona aveva chiesto
-- di non essere piu' riconosciuta, e una prova che sparisce insieme al negozio
-- di cui parla non prova niente.
ALTER TABLE "consent_revocations"
  DROP CONSTRAINT IF EXISTS "consent_revocations_shop_id_fkey";
ALTER TABLE "consent_revocations"
  ADD CONSTRAINT "consent_revocations_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS, come su ogni altra tabella dello schema public.
--
-- Qui pesa piu' che altrove: Supabase pubblica lo schema `public` attraverso la
-- Data API, e senza questa riga basterebbe la anon key del progetto — una
-- chiave che sta nei browser e non e' un segreto — per leggere l'elenco di chi
-- ha revocato. Nessuna policy, come per le altre: Prisma si collega come
-- proprietario e scavalca RLS, zero policy significa che dalla Data API non si
-- legge niente.
ALTER TABLE "consent_revocations" ENABLE ROW LEVEL SECURITY;
