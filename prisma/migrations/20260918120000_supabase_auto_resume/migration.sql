-- La riattivazione automatica del database del merchant: se la vuole, e cosa
-- abbiamo gia' provato.
--
-- PERCHE'. Un progetto Supabase gratuito messo in pausa non resta in pausa per
-- sempre: passata la finestra di riattivazione non e' piu' riaccendibile e di
-- quel database restano soltanto le copie di sicurezza da scaricare. Il banner
-- lo dice gia' al merchant, ma dirlo non basta — il merchant che non apre l'app
-- non lo legge, ed e' proprio lui quello a rischio, visto che la pausa arriva
-- quando nessuno tocca il progetto da settimane. Quindi l'app lo riaccende da
-- sola prima della scadenza, e glielo dice dopo averlo fatto.
--
-- PERCHE' UNA TABELLA E NON TRE COLONNE SU `supabase_configs`. Perche' il
-- codice va in produzione prima che questa migrazione venga eseguita, e nella
-- finestra fra le due cose le colonne non esistono. Prisma elenca per nome ogni
-- colonna del modello: una colonna nuova su `supabase_configs` farebbe fallire
-- ogni `include: { supabaseConfig: true }` del repository — Impostazioni, cron,
-- dashboard — con un errore su una colonna che non c'e'. Una tabella nuova
-- invece la interroga solo chi la conosce: finche' non esiste, quella sola
-- lettura fallisce, viene intercettata, e la riattivazione automatica resta
-- spenta mentre tutto il resto continua a funzionare.
--
-- Additive: una tabella nuova e basta. Nessuna riga esistente cambia
-- significato, e una tabella vuota vale "nessun merchant ha ancora espresso una
-- scelta" — che, con NULL letto come acceso, e' il comportamento dichiarato
-- dell'app.

CREATE TABLE IF NOT EXISTS "supabase_auto_resume" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    -- NULL = mai toccato, e vale acceso. La colonna e' nullable di proposito:
    -- "non ha scelto" e "ha scelto no" sono due cose diverse, e solo la seconda
    -- deve fermare l'app.
    "enabled" BOOLEAN DEFAULT true,
    -- Il freno contro le richieste ripetute. Sta qui e non in cache perche' un
    -- freno che sparisce quando la cache non risponde non e' un freno.
    "last_attempt_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    -- Quando l'app ha riacceso il database al posto del merchant: e' il fatto da
    -- dirgli, e il punto di aggancio dell'avviso via email quando ci sara' un
    -- provider.
    "auto_resumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supabase_auto_resume_pkey" PRIMARY KEY ("id")
);

-- Una riga per negozio: e' una scelta, non una storia.
CREATE UNIQUE INDEX IF NOT EXISTS "supabase_auto_resume_shop_id_key"
  ON "supabase_auto_resume" ("shop_id");

-- CASCADE verso il negozio: un negozio che se ne va non lascia dietro di se' il
-- permesso di toccare un'infrastruttura che non e' piu' sua.
ALTER TABLE "supabase_auto_resume"
  DROP CONSTRAINT IF EXISTS "supabase_auto_resume_shop_id_fkey";
ALTER TABLE "supabase_auto_resume"
  ADD CONSTRAINT "supabase_auto_resume_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, come su ogni altra tabella dello schema public.
--
-- Non e' una formalita': Supabase pubblica lo schema `public` attraverso la Data
-- API, quindi senza questa riga basterebbe la anon key del progetto — una chiave
-- pensata per stare nei browser — per leggere questa tabella. Qui dentro c'e'
-- l'elenco dei negozi il cui database e' in pausa e quante volte abbiamo provato
-- a riaccenderlo.
--
-- Nessuna policy, come per le altre: Prisma si collega come proprietario e
-- scavalca RLS, e zero policy significa che dalla Data API non si legge niente.
ALTER TABLE "supabase_auto_resume" ENABLE ROW LEVEL SECURITY;
