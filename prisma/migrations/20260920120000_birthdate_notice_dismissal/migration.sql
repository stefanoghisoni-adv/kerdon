-- Per quale campo il merchant ha chiuso l'avviso della data di nascita.
--
-- PERCHE'. La chiusura di quell'avviso viveva nel browser. Non ha retto due
-- volte, e per due ragioni diverse. La prima e' che `localStorage` appartiene
-- all'indirizzo da cui la pagina arriva: l'app e' passata da
-- `api.coreward.app` a `api.kerdon.io`, e da quel momento la memoria di cio'
-- che era stato chiuso e' rimasta sull'altro dominio — l'avviso e' tornato su
-- per tutti. La seconda e' strutturale: dentro l'admin l'app sta in un iframe
-- di un'altra origine, quindi quello e' storage di terze parti, che Safari
-- blocca e Chrome partiziona. In un'app embedded non e' il caso raro, e' la
-- condizione normale.
--
-- Una preferenza che il merchant esprime con un gesto esplicito — "non
-- mostrarmelo piu'" — non puo' vivere in un posto che cambia con l'indirizzo o
-- che il browser puo' rifiutare. Vive qui, dove vivono le altre cose che
-- riguardano il negozio.
--
-- PERCHE' UNA TABELLA E NON UNA COLONNA SU `shops`. Perche' il codice va in
-- produzione prima che questa migrazione venga eseguita — la lancia una
-- persona, a mano, su Live e su Test — e nella finestra fra le due cose la
-- colonna non esiste. Prisma elenca per nome ogni colonna del modello: una
-- colonna nuova su `shops` farebbe fallire OGNI lettura del negozio, che vuol
-- dire tutta l'app, a partire dal controllo dei permessi. Una tabella nuova
-- invece la interroga solo chi la conosce: finche' non esiste fallisce quella
-- sola lettura, viene intercettata, e l'avviso si comporta come se non fosse
-- mai stato chiuso. E' la stessa scelta, e la stessa ragione, di
-- `supabase_auto_resume`.
--
-- Additive: una tabella nuova e basta. Nessuna riga esistente cambia
-- significato, e una tabella vuota vale "nessuno ha ancora chiuso l'avviso".

CREATE TABLE IF NOT EXISTS "birthdate_notice_dismissals" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    -- Il campo per cui l'avviso e' stato chiuso, per intero: `facts.birth_date`.
    -- NOT NULL di proposito: la riga esiste solo se qualcuno ha chiuso
    -- qualcosa, e una riga con il campo vuoto sarebbe una chiusura senza
    -- oggetto — cioe' il si'/no che non vogliamo, quello che zittirebbe anche
    -- la conferma del campo successivo.
    "dismissed_for" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "birthdate_notice_dismissals_pkey" PRIMARY KEY ("id")
);

-- Una riga per negozio: e' l'ultima chiusura, non uno storico delle chiusure.
CREATE UNIQUE INDEX IF NOT EXISTS "birthdate_notice_dismissals_shop_id_key"
  ON "birthdate_notice_dismissals" ("shop_id");

-- CASCADE verso il negozio: quello che un negozio disinstallato aveva gia'
-- letto non interessa piu' a nessuno.
ALTER TABLE "birthdate_notice_dismissals"
  DROP CONSTRAINT IF EXISTS "birthdate_notice_dismissals_shop_id_fkey";
ALTER TABLE "birthdate_notice_dismissals"
  ADD CONSTRAINT "birthdate_notice_dismissals_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, come su ogni altra tabella dello schema public.
--
-- Supabase pubblica lo schema `public` attraverso la Data API: senza questa
-- riga basterebbe la anon key del progetto — una chiave pensata per stare nei
-- browser — per leggere l'elenco dei negozi che hanno collegato la data di
-- nascita e a quale campo. Nessuna policy, come per le altre: Prisma si collega
-- come proprietario e scavalca RLS, e zero policy significa che dalla Data API
-- non si legge niente.
ALTER TABLE "birthdate_notice_dismissals" ENABLE ROW LEVEL SECURITY;
