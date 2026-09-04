-- Listino riservato ai negozi che arrivano dalle agenzie con cui collaboriamo,
-- o che seguiamo direttamente.
--
-- Tutto additivo: nessuna colonna rimossa, nessun dato toccato. Le due colonne
-- nuove su shops nascono vuote, quindi i negozi esistenti restano a listino
-- pieno finche' non li si assegna a un partner.

-- CreateTable
CREATE TABLE IF NOT EXISTS "partners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Prezzo FINALE riservato, non una percentuale: e' cosi' che si decide, e una
-- percentuale darebbe cifre con i decimali invece di prezzi tondi.
CREATE TABLE IF NOT EXISTS "partner_plan_prices" (
    "id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "price_monthly" DECIMAL(10,2) NOT NULL,
    "price_yearly" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "partner_plan_prices_pkey" PRIMARY KEY ("id")
);

-- La colonna, per il caso in cui la tabella ci fosse gia' senza.
--
-- Serve a chi arriva da `0_init`: li' `partner_plan_prices` nasce nella forma
-- di oggi — con `partner_name`, perche' la migrazione successiva sostituisce
-- l'id col nome — quindi il CREATE TABLE qui sopra non fa niente e l'indice e
-- la foreign key qui sotto cercherebbero una colonna che non c'e'. Nullable e
-- non NOT NULL: sul database owner la colonna e' gia' stata tolta e ci sono
-- righe, e una colonna obbligatoria senza default non si aggiunge a una tabella
-- piena.
ALTER TABLE "partner_plan_prices" ADD COLUMN IF NOT EXISTS "partner_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "partners_name_key" ON "partners"("name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "partner_plan_prices_partner_id_plan_name_key"
  ON "partner_plan_prices"("partner_id", "plan_name");

-- AlterTable
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "partner_id" TEXT;
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "discount_intervals" INTEGER;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "partner_plan_prices" ADD CONSTRAINT "partner_plan_prices_partner_id_fkey"
    FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
-- SET NULL e non CASCADE: cancellare un partner non deve portarsi via i negozi.
DO $$ BEGIN
  ALTER TABLE "shops" ADD CONSTRAINT "shops_partner_id_fkey"
    FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Come tutte le tabelle dell'app: nessuna policy, quindi nessun accesso via
-- Data API. Prisma passa da postgres, che possiede le tabelle e non e' soggetto
-- a RLS.
ALTER TABLE "partners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partner_plan_prices" ENABLE ROW LEVEL SECURITY;

-- Partner di partenza: i negozi che seguiamo direttamente, senza agenzia.
INSERT INTO "partners" ("id", "name", "label")
VALUES (gen_random_uuid()::text, 'own_partner', 'Clienti diretti')
ON CONFLICT ("name") DO NOTHING;
