-- Dettaglio delle sincronizzazioni: eventi di aggiunta/rimozione prodotti e
-- aggiunta/aggiornamento/sospensione clienti, visibili nel modal "Vedi dettagli"
-- della tab Logs.
--
-- I totali veri stanno su sync_jobs (products_added, products_removed, ecc.)
-- perché il dettaglio viene troncato a 500 righe per categoria per job: senza
-- quelli il modal non può scrivere "mostrate 500 di 3.412".
--
-- Idempotente: si può eseguire a mano sul database owner (il pooler sulla 6543
-- non esegue DDL) e poi di nuovo dalle migrazioni senza effetti.
--
-- Sui tipi: nel database owner di produzione sync_jobs.id è UUID, non TEXT. Lo
-- schema di quel database è nato a mano in Supabase, mentre Prisma per un
-- `String @id @default(uuid())` scrive TEXT — ed è TEXT anche in `0_init`, che
-- dallo schema è generato. La colonna che lo referenzia deve avere lo stesso
-- tipo dell'altra, altrimenti Postgres rifiuta la foreign key: "Key columns are
-- of incompatible types: text and uuid".
--
-- Quindi il tipo non si scrive: si legge da sync_jobs.id e si usa quello. Prima
-- qui c'era scritto `uuid`, e su un database creato da `0_init` — dove è TEXT —
-- questa migrazione buttava via la tabella appena creata per rifarla con la
-- colonna UUID, e poi si fermava sulla foreign key.

-- 1. Aggiunge le colonne di conteggio su sync_jobs
ALTER TABLE "sync_jobs"
  ADD COLUMN IF NOT EXISTS "products_added" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "products_removed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "customers_added" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "customers_updated" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "customers_suspended" INTEGER NOT NULL DEFAULT 0;

-- 2. Allinea la tabella al tipo di sync_jobs.id, e la crea se non c'è.
--
--    Se esiste già con sync_job_id di un altro tipo è un tentativo precedente
--    rimasto a metà: non potrà mai ricevere la foreign key. Si elimina solo se
--    è ancora vuota; se dentro ci fosse del dettaglio vero è meglio fermarsi e
--    guardare cosa c'è, invece di buttarlo via di nascosto.
DO $$
DECLARE
  tipo_id  text;
  tipo_fk  text;
BEGIN
  SELECT data_type INTO tipo_id
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'sync_jobs' AND column_name = 'id';

  IF tipo_id IS NULL THEN
    RAISE EXCEPTION 'sync_jobs.id non esiste: questa migrazione va dopo la tabella sync_jobs';
  END IF;

  SELECT data_type INTO tipo_fk
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'sync_job_events' AND column_name = 'sync_job_id';

  IF tipo_fk IS NOT NULL AND tipo_fk <> tipo_id THEN
    IF EXISTS (SELECT 1 FROM "sync_job_events" LIMIT 1) THEN
      RAISE EXCEPTION
        'sync_job_events ha sync_job_id del tipo sbagliato ma contiene già dati: convertire a mano';
    END IF;
    DROP TABLE "sync_job_events";
    tipo_fk := NULL;
  END IF;

  -- 3. Crea la tabella degli eventi (solo se non esiste), con la colonna della
  --    foreign key dello stesso tipo di sync_jobs.id.
  IF tipo_fk IS NULL THEN
    EXECUTE format($ddl$
      CREATE TABLE "sync_job_events" (
        -- Il cast è obbligatorio: gen_random_uuid() restituisce un uuid, e su
        -- una colonna TEXT Postgres rifiuta il default senza conversione.
        "id" %1$s NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::%1$s,
        "sync_job_id" %1$s NOT NULL,
        "entity" TEXT NOT NULL,
        "action" TEXT NOT NULL,
        "shopify_id" BIGINT,
        "variant_id" BIGINT,
        "label" TEXT NOT NULL,
        "sublabel" TEXT,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    $ddl$, tipo_id);

    -- Come tutte le altre: la Data API di Supabase pubblica lo schema public,
    -- e una tabella senza RLS è leggibile con la sola chiave pubblica.
    ALTER TABLE "sync_job_events" ENABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

-- 4. Crea l'indice sulla foreign key (solo se non esiste)
CREATE INDEX IF NOT EXISTS "sync_job_events_sync_job_id_idx"
  ON "sync_job_events"("sync_job_id");

-- 5. Aggiunge la foreign key (solo se non esiste)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sync_job_events_sync_job_id_fkey'
  ) THEN
    ALTER TABLE "sync_job_events"
      ADD CONSTRAINT "sync_job_events_sync_job_id_fkey"
      FOREIGN KEY ("sync_job_id")
      REFERENCES "sync_jobs"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END
$$;
