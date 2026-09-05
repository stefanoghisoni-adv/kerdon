-- La coda dei lavori, e il lucchetto per negozio, su Postgres.
--
-- PERCHE'. La coda stava su BullMQ/Redis, ma su Vercel Free non gira nessun
-- Worker: il cron leggeva i job in attesa con `getJobs('waiting','delayed')` e
-- chiamava i processor direttamente. Nessuno prendeva possesso di niente,
-- quindi due drenaggi simultanei — il cron ogni trenta minuti e quello che un
-- gesto manuale innesca subito — vedevano lo stesso job e lo lavoravano tutti e
-- due. E su eccezione il job veniva RIMOSSO: i tentativi e il backoff
-- configurati su BullMQ non li applicava nessuno, quindi un errore di rete
-- perdeva il lavoro per sempre.
--
-- Il danno peggiore non e' un doppione innocuo. La corsa completa finisce
-- spazzando dal database del merchant le righe con `synced_at` anteriore al
-- proprio inizio: e' cosi' che toglie i prodotti spariti da Shopify. Due corse
-- sovrapposte hanno due istanti d'inizio diversi, e la piu' vecchia porta via
-- le righe che la piu' recente ha appena scritto. Non lascia errori: si vede
-- dopo, come prodotti mancanti.
--
-- Il perche' di Postgres invece di un altro giro su Redis sta in
-- docs/architecture/queue-adr.md.
--
-- Additive: due tabelle nuove, nessuna riga esistente toccata.

CREATE TABLE IF NOT EXISTS "sync_requests" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "dedup_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "sync_requests_pkey" PRIMARY KEY ("id")
);

-- La deduplica. La chiave e' tipo + negozio + finestra temporale: due clic
-- ravvicinati sul pulsante, o il cron e un gesto manuale che chiedono la stessa
-- cosa, si schiantano qui e producono un item solo. La finestra fa il resto —
-- una richiesta fatta piu' tardi e' una richiesta diversa, e fonderla in quella
-- di prima vorrebbe dire ignorarla.
CREATE UNIQUE INDEX IF NOT EXISTS "sync_requests_dedup_key_key"
  ON "sync_requests" ("dedup_key");

-- La lettura della presa: cosa e' pronto, dal piu' vecchio. E' l'unica query
-- calda della coda, e senza indice diventerebbe una scansione a ogni giro.
CREATE INDEX IF NOT EXISTS "sync_requests_status_next_attempt_at_idx"
  ON "sync_requests" ("status", "next_attempt_at");

-- La corsia veloce: cosa c'e' in ballo per QUESTO negozio.
CREATE INDEX IF NOT EXISTS "sync_requests_shop_id_status_idx"
  ON "sync_requests" ("shop_id", "status");

-- CASCADE: un negozio che se ne va non lascia dietro lavori da fare per lui.
-- La colonna resta nullabile perche' non tutti i lavori hanno un negozio —
-- `shop/redact` sta cancellando proprio quello.
ALTER TABLE "sync_requests"
  DROP CONSTRAINT IF EXISTS "sync_requests_shop_id_fkey";
ALTER TABLE "sync_requests"
  ADD CONSTRAINT "sync_requests_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "shop_locks" (
    "shop_id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_locks_pkey" PRIMARY KEY ("shop_id")
);

-- La potatura dei lucchetti scaduti, che gira nel cron.
CREATE INDEX IF NOT EXISTS "shop_locks_expires_at_idx"
  ON "shop_locks" ("expires_at");

-- Nessuna chiave esterna verso `shops` su questa tabella, ed e' voluto: il
-- lucchetto serve anche mentre il negozio viene cancellato (`shop/redact`), e
-- una riga che sparisce a meta' di quel lavoro sarebbe il lucchetto che si apre
-- da solo nel momento peggiore.

-- RLS su entrambe, come su ogni altra tabella dello schema public.
--
-- Non e' una formalita': Supabase pubblica lo schema `public` attraverso la
-- Data API, quindi senza questa riga basta la anon key del progetto — una
-- chiave pensata per stare nei browser — per leggere la tabella. E' gia'
-- successo una volta, su `compliance_requests`, che conteneva le esportazioni
-- GDPR complete. Qui dentro c'e' meno, ma `sync_requests.payload` porta
-- comunque l'id delle pratiche di conformita' in lavorazione, e chi puo'
-- leggere `shop_locks` sa quali negozi sono aperti a una corsa sovrapposta.
--
-- Nessuna policy, come per le altre: Prisma si collega come proprietario e
-- scavalca RLS, e zero policy significa che dalla Data API non si legge niente.
ALTER TABLE "sync_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shop_locks" ENABLE ROW LEVEL SECURITY;
