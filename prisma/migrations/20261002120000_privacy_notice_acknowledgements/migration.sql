-- L'ultima versione dell'informativa per cui il negozio ha detto "Ho capito".
--
-- PERCHE'. La sezione 10 dell'informativa promette che una modifica
-- sostanziale viene annunciata dentro l'app prima di valere. L'avviso sta in
-- cima alla Dashboard, e questa tabella ricorda per ogni negozio quale
-- versione ha gia' visto: quando la versione dell'informativa sale, l'avviso
-- torna. Sul server e non nel browser per le ragioni scritte in
-- 20260920120000_birthdate_notice_dismissal (iframe di un'altra origine,
-- storage di terze parti, dominio cambiato), e perche' che il negozio abbia
-- visto l'avviso e' un fatto da poter dimostrare.
--
-- PERCHE' UNA TABELLA E NON UNA COLONNA SU `shops`. Il codice va in produzione
-- prima che questa migrazione venga eseguita, e Prisma elenca per nome ogni
-- colonna del modello: una colonna nuova su `shops` farebbe fallire ogni
-- lettura del negozio in quella finestra. Una tabella nuova la interroga solo
-- chi la conosce, e finche' non c'e' l'avviso si mostra (vedi
-- app/lib/legal/privacy-notice.server.ts).
--
-- Additiva: una tabella nuova e basta. Una tabella vuota vale "nessun negozio
-- ha ancora visto l'avviso", cioe' lo vedranno tutti quelli installati prima
-- della versione corrente — che e' quel che si vuole.

CREATE TABLE IF NOT EXISTS "privacy_notice_acknowledgements" (
    "shop_id" TEXT NOT NULL,
    -- La versione vista, nella forma della testata dei documenti (`1.5`).
    "version_seen" TEXT NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "privacy_notice_acknowledgements_pkey" PRIMARY KEY ("shop_id")
);

-- CASCADE verso il negozio: la riga riguarda solo lui.
ALTER TABLE "privacy_notice_acknowledgements"
  DROP CONSTRAINT IF EXISTS "privacy_notice_acknowledgements_shop_id_fkey";
ALTER TABLE "privacy_notice_acknowledgements"
  ADD CONSTRAINT "privacy_notice_acknowledgements_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, come su ogni altra tabella dello schema public: la Data API di Supabase
-- espone public, e senza RLS basterebbe la anon key per leggere l'elenco dei
-- negozi. Nessuna policy: Prisma si collega come proprietario e scavalca RLS.
ALTER TABLE "privacy_notice_acknowledgements" ENABLE ROW LEVEL SECURITY;
