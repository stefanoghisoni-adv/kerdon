-- Il registro delle riparazioni, e il confine incrementale che diventa una
-- colonna sua.
--
-- PERCHE'. Nei processor una quantita' di errori veniva registrata e ignorata,
-- e alla fine la corsa si dichiarava `completed` lo stesso. Il confine
-- incrementale della corsa successiva si calcolava dall'ultima corsa
-- completata: la risorsa che l'upsert non era riuscito a scrivere usciva dalla
-- finestra e — se su Shopify nessuno la toccava piu' — non veniva riletta mai
-- piu'. Il difetto non si vedeva il giorno stesso: diventava permanente, e
-- nessun registro sapeva dire quale riga fosse rimasta indietro.
--
-- Due cose, quindi. Una colonna che dice fin dove una corsa ha DIRITTO di dire
-- di essere arrivata, distinta da quando e' partita; e una tabella dove le
-- risorse rimaste indietro restano scritte finche' non sono rimesse a posto.
--
-- Additive: una tabella nuova e due colonne con un default. Nessuna riga
-- esistente cambia significato — le corse gia' concluse restano senza confine,
-- e chi legge il confine ha gia' il suo ripiego per quel caso.

-- Il confine, e il conto delle riparazioni lasciate aperte.
--
-- `watermark_at` nullo sulle righe esistenti e' voluto: una corsa vecchia non
-- ha mai dimostrato di aver scritto tutto, e regalarle il confine adesso
-- vorrebbe dire firmare al posto suo. Il primo giro dopo questa migrazione
-- riparte dal ripiego (l'istante del collegamento) e rilegge di piu' una volta
-- sola.
ALTER TABLE "sync_jobs" ADD COLUMN IF NOT EXISTS "watermark_at" TIMESTAMP(3);
ALTER TABLE "sync_jobs" ADD COLUMN IF NOT EXISTS "repairs_opened" INTEGER NOT NULL DEFAULT 0;

-- La lettura del confine a ogni corsa: l'ultima che se l'e' guadagnato. Senza
-- indice sarebbe una scansione del registro a ogni sincronizzazione.
CREATE INDEX IF NOT EXISTS "sync_jobs_shop_id_watermark_at_idx"
  ON "sync_jobs" ("shop_id", "watermark_at" DESC);

CREATE TABLE IF NOT EXISTS "sync_repairs" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "source_updated_at" TIMESTAMP(3),
    "recovered_by_delta" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,
    "last_error" TEXT,
    "opened_by_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "sync_repairs_pkey" PRIMARY KEY ("id")
);

-- Una riga per risorsa e operazione, che si riapre invece di duplicarsi: due
-- corse che inciampano sullo stesso prodotto descrivono lo stesso lavoro da
-- fare, non due. E' anche il motivo per cui questa tabella non e' un tipo nuovo
-- dentro `sync_requests`: li' la chiave di deduplica e' unica per sempre,
-- concluse comprese, quindi un secondo guasto sulla stessa risorsa a distanza
-- di settimane verrebbe scambiato per un doppione e scartato.
CREATE UNIQUE INDEX IF NOT EXISTS "sync_repairs_shop_id_resource_type_resource_id_operation_key"
  ON "sync_repairs" ("shop_id", "resource_type", "resource_id", "operation");

-- Cosa c'e' da rimettere a posto per questo negozio, e da quando si puo'
-- ritentare. E' la query che apre ogni corsa.
CREATE INDEX IF NOT EXISTS "sync_repairs_shop_id_status_next_attempt_at_idx"
  ON "sync_repairs" ("shop_id", "status", "next_attempt_at");

-- Quali riparazioni ha aperto una certa corsa: serve a farla tornare
-- "completata" quando l'ultima si chiude.
CREATE INDEX IF NOT EXISTS "sync_repairs_opened_by_job_id_idx"
  ON "sync_repairs" ("opened_by_job_id");

-- CASCADE verso il negozio: un negozio che se ne va non lascia dietro
-- riparazioni per dati che non esistono piu'.
--
-- Nessuna chiave esterna verso `sync_jobs`, invece, ed e' voluto: la
-- riparazione deve sopravvivere alla corsa che l'ha aperta, e una riga che
-- sparisce insieme al registro si porterebbe via un lavoro non fatto.
ALTER TABLE "sync_repairs"
  DROP CONSTRAINT IF EXISTS "sync_repairs_shop_id_fkey";
ALTER TABLE "sync_repairs"
  ADD CONSTRAINT "sync_repairs_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, come su ogni altra tabella dello schema public.
--
-- Non e' una formalita': Supabase pubblica lo schema `public` attraverso la
-- Data API, quindi senza questa riga basta la anon key del progetto — una
-- chiave pensata per stare nei browser — per leggere la tabella. E qui dentro
-- ci sono gli id dei clienti di ogni negozio, che sono dati personali.
--
-- Nessuna policy, come per le altre: Prisma si collega come proprietario e
-- scavalca RLS, e zero policy significa che dalla Data API non si legge niente.
ALTER TABLE "sync_repairs" ENABLE ROW LEVEL SECURITY;
