-- Il registro di cosa, nel database del merchant, e' roba nostra — e la traccia
-- dei tentativi di eliminarla.
--
-- Perche' servono: lo scollegamento con "elimina tabelle e dati" faceva DROP su
-- due nomi soli, quelli configurati per prodotti e clienti, mentre l'app di
-- tabelle ne crea cinque (`users`, `orders` e `order_lines` restavano dentro).
-- E i due nomi li prendeva dalla configurazione, che il merchant puo' scrivere:
-- una `products` che era gia' sua, col suo catalogo dentro, veniva cancellata
-- da un gesto che prometteva di togliere le NOSTRE tabelle. Senza un registro
-- quella distinzione non e' ricostruibile dopo — la DDL e' CREATE TABLE IF NOT
-- EXISTS, e una tabella che c'e' non dice chi l'ha creata.
--
-- Additive: due tabelle nuove, nessuna riga esistente toccata.

CREATE TABLE IF NOT EXISTS "supabase_managed_resources" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "project_ref" TEXT NOT NULL,
    "schema_name" TEXT NOT NULL DEFAULT 'public',
    "resource_name" TEXT NOT NULL,
    "resource_kind" TEXT NOT NULL DEFAULT 'table',
    "created_by_coreward" BOOLEAN NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supabase_managed_resources_pkey" PRIMARY KEY ("id")
);

-- Una riga sola per risorsa e per progetto: il collegamento si rifa' spesso
-- (riconnessioni, cambio di piano) e senza questo vincolo ogni giro lascerebbe
-- un doppione, con il rischio che due righe della stessa tabella dicano cose
-- diverse su chi l'ha creata.
CREATE UNIQUE INDEX IF NOT EXISTS "supabase_managed_resources_shop_id_project_ref_schema_name__key"
  ON "supabase_managed_resources" ("shop_id", "project_ref", "schema_name", "resource_name");

-- La lettura dell'eliminazione: cosa possediamo su questo progetto.
CREATE INDEX IF NOT EXISTS "supabase_managed_resources_shop_id_project_ref_idx"
  ON "supabase_managed_resources" ("shop_id", "project_ref");

ALTER TABLE "supabase_managed_resources"
  DROP CONSTRAINT IF EXISTS "supabase_managed_resources_shop_id_fkey";
ALTER TABLE "supabase_managed_resources"
  ADD CONSTRAINT "supabase_managed_resources_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "supabase_data_deletions" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "project_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "resources" TEXT[],
    "remaining" TEXT[],
    "last_error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "supabase_data_deletions_pkey" PRIMARY KEY ("id")
);

-- L'ultimo tentativo per negozio: e' la domanda che si fa sempre ("com'e'
-- finita?"), e senza indice costerebbe leggere tutto lo storico.
CREATE INDEX IF NOT EXISTS "supabase_data_deletions_shop_id_started_at_idx"
  ON "supabase_data_deletions" ("shop_id", "started_at" DESC);

ALTER TABLE "supabase_data_deletions"
  DROP CONSTRAINT IF EXISTS "supabase_data_deletions_shop_id_fkey";
ALTER TABLE "supabase_data_deletions"
  ADD CONSTRAINT "supabase_data_deletions_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS su entrambe, come su ogni altra tabella dello schema public.
--
-- Non e' una formalita': Supabase pubblica lo schema `public` attraverso la
-- Data API, quindi senza questa riga basta la anon key del progetto — una
-- chiave pensata per stare nei browser — per leggere la tabella. E' gia'
-- successo una volta, su `compliance_requests`, che conteneva le esportazioni
-- GDPR complete. Qui dentro c'e' meno, ma c'e' comunque la mappa di quali
-- tabelle l'app tiene nel database di quale merchant.
--
-- Nessuna policy, come per le altre: Prisma si collega come proprietario e
-- scavalca RLS, e zero policy significa che dalla Data API non si legge niente.
ALTER TABLE "supabase_managed_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supabase_data_deletions" ENABLE ROW LEVEL SECURITY;
