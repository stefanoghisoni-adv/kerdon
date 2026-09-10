-- Il registro dell'ambito: quali prodotti continuano ad aggiornarsi, e quali
-- sono fermi perche' il piano ha un tetto.
--
-- PERCHE'. La corsa completa smetteva di impaginare appena raggiungeva il tetto
-- di prodotti del piano, e poi eseguiva lo stesso la spazzata globale — "via
-- tutte le righe che questa corsa non ha riscritto". Ma tutto cio' che stava
-- oltre il tetto non era stato riscritto perche' non era stato nemmeno chiesto:
-- risultava vecchio, e veniva cancellato. Un negozio che passava a un piano piu'
-- piccolo non perdeva l'aggiornamento dei prodotti in eccedenza, perdeva i
-- prodotti — mentre la pagina dei piani prometteva l'esatto contrario.
--
-- Per smettere di cancellarli bisogna poter dire "questa riga e' ferma di
-- proposito": senza un posto dove scriverlo, "ferma" e "sparita" restano
-- indistinguibili e l'unico modo di non perdere niente sarebbe non cancellare
-- mai piu' niente.
--
-- Additive: una tabella nuova e basta. Nessuna riga esistente cambia
-- significato, e un registro vuoto vale "nessun prodotto e' stato ancora
-- classificato" — che e' esattamente com'e' il mondo prima della prima corsa
-- completa dopo questa migrazione.

CREATE TABLE IF NOT EXISTS "product_scope" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shopify_product_id" TEXT NOT NULL,
    "source_created_at" TIMESTAMP(3),
    "first_scoped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "in_scope" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL DEFAULT 'in_scope',
    "last_checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_in_scope_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_scope_pkey" PRIMARY KEY ("id")
);

-- Una riga per prodotto: l'ambito e' uno stato, non una storia. E' anche la
-- chiave con cui la corsa riscrive il registro senza doverlo prima svuotare —
-- svuotarlo vorrebbe dire, per un istante, un negozio senza niente di fermo.
CREATE UNIQUE INDEX IF NOT EXISTS "product_scope_shop_id_shopify_product_id_key"
  ON "product_scope" ("shop_id", "shopify_product_id");

-- Quante righe si aggiornano e quante sono ferme: e' la domanda che
-- l'interfaccia fa a ogni apertura della dashboard.
CREATE INDEX IF NOT EXISTS "product_scope_shop_id_in_scope_idx"
  ON "product_scope" ("shop_id", "in_scope");

-- CASCADE verso il negozio: un negozio che se ne va non lascia dietro l'ambito
-- di dati che non esistono piu'. Qui, a differenza di `sync_repairs`, non c'e'
-- niente da conservare oltre la vita del negozio: questa tabella descrive lo
-- stato di righe che spariscono con lui.
ALTER TABLE "product_scope"
  DROP CONSTRAINT IF EXISTS "product_scope_shop_id_fkey";
ALTER TABLE "product_scope"
  ADD CONSTRAINT "product_scope_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, come su ogni altra tabella dello schema public.
--
-- Non e' una formalita': Supabase pubblica lo schema `public` attraverso la
-- Data API, quindi senza questa riga basta la anon key del progetto — una
-- chiave pensata per stare nei browser — per leggere la tabella. Qui dentro c'e'
-- l'elenco dei prodotti di ogni negozio, che e' informazione commerciale del
-- merchant.
--
-- Nessuna policy, come per le altre: Prisma si collega come proprietario e
-- scavalca RLS, e zero policy significa che dalla Data API non si legge niente.
ALTER TABLE "product_scope" ENABLE ROW LEVEL SECURITY;
