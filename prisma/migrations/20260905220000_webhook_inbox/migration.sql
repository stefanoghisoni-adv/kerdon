-- La posta in arrivo dei webhook amministrativi.
--
-- PERCHE'. `app/uninstalled` e `app_subscriptions/update` facevano il lavoro
-- dentro la richiesta HTTP e avvolgevano tutto in un try/catch che rispondeva
-- 200 lo stesso. Per Shopify il 200 e' la ricevuta: da quel momento l'evento
-- risulta consegnato e non viene ritentato mai piu'. Un negozio disinstallato
-- mentre il database owner non rispondeva restava attivo nei registri per
-- sempre; un abbonamento finito non faceva retrocedere il piano. Non c'era ne'
-- lettera morta ne' allarme: l'evento spariva e nessuna riga lo ricordava.
--
-- Da qui in avanti la ricevuta e' questa riga, scritta subito dopo la verifica
-- della firma e prima di qualunque risposta. Se non si riesce a scriverla si
-- risponde 5xx e Shopify ritenta, che e' l'unica risposta onesta. Il lavoro
-- vero viene dopo, con i suoi tentativi e il suo distanziamento, e puo'
-- fallire senza che nessuno lo scambi per un rifiuto.
--
-- PERCHE' UNA TABELLA E NON UN TIPO NUOVO IN `sync_requests`. La coda lavora
-- ogni item dentro il lucchetto del suo negozio, e una disinstallazione che
-- aspetta il lucchetto aspetta la fine di una sincronizzazione che dura minuti
-- — proprio quella che sta scrivendo per conto di un negozio che ha appena
-- chiuso. In piu' `sync_requests.shop_id` punta a `shops`, mentre questi due
-- webhook arrivano anche per installazioni mai completate; e la coda porta di
-- proposito il minimo per ritrovare un lavoro, mai il corpo dell'evento, che
-- qui e' l'unica cosa da cui lo si puo' rifare. E' lo stesso ragionamento che
-- ha portato fuori dalla coda `sync_repairs`, e la stessa forma gia' in uso per
-- `compliance_requests`.
--
-- Additive: una tabella nuova e basta. Nessuna riga esistente cambia
-- significato, e gli eventi arrivati prima di questa migrazione restano persi —
-- a ritrovarli ci pensa la riconciliazione periodica, non questa tabella.

CREATE TABLE IF NOT EXISTS "webhook_events" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shop_id" TEXT,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- L'indice su cui poggia tutto il resto: e' lui a rendere la seconda consegna
-- dello stesso evento una ricevuta invece di un secondo effetto. Senza, due
-- consegne ravvicinate produrrebbero due righe e due retrocessioni di piano.
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_webhook_id_key"
  ON "webhook_events" ("webhook_id");

-- Cosa c'e' da lavorare adesso: la query del drenaggio, a ogni giro del cron.
CREATE INDEX IF NOT EXISTS "webhook_events_status_next_attempt_at_idx"
  ON "webhook_events" ("status", "next_attempt_at");

-- Cosa e' arrivato per questo negozio, dal piu' recente. Serve a chi va a
-- guardare dopo un allarme, e alla riconciliazione quando deve capire se un
-- evento era gia' passato di qui.
CREATE INDEX IF NOT EXISTS "webhook_events_shop_domain_received_at_idx"
  ON "webhook_events" ("shop_domain", "received_at" DESC);

-- SET NULL e non CASCADE, come per `compliance_requests`: l'evento deve
-- sopravvivere alla riga del negozio. E' anche la prova di cosa era arrivato
-- per un negozio che nel frattempo e' stato cancellato — e una prova che
-- sparisce insieme a cio' che deve provare non prova niente.
ALTER TABLE "webhook_events"
  DROP CONSTRAINT IF EXISTS "webhook_events_shop_id_fkey";
ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS, come su ogni altra tabella dello schema public.
--
-- Supabase pubblica lo schema `public` attraverso la Data API: senza questa
-- riga basterebbe la anon key del progetto — una chiave che sta nei browser e
-- non e' un segreto — per leggere il corpo di ogni webhook amministrativo, e
-- quindi il nome del negozio e il suo abbonamento. Nessuna policy, come per le
-- altre: Prisma si collega come proprietario e scavalca RLS, zero policy
-- significa che dalla Data API non si legge niente.
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;

-- Quando abbiamo chiesto a Shopify come stanno davvero le cose per questo
-- negozio.
--
-- Serve a far ruotare la riconciliazione periodica: un webhook amministrativo
-- perso fuori dalla finestra dei ritentativi non torna piu', e l'unico modo di
-- accorgersene e' andare a guardare — due chiamate a Shopify per negozio.
-- Senza questa colonna il giro del cron ripasserebbe ogni volta dagli stessi
-- primi negozi e agli ultimi non arriverebbe mai.
--
-- Nulla sulle righe esistenti, ed e' voluto: nessuno di quei negozi e' mai
-- stato riconciliato, e dirlo controllato adesso vorrebbe dire firmare al posto
-- di un controllo che non e' avvenuto. Il primo giro li prende tutti, una volta
-- sola, a scaglioni.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "shopify_state_checked_at" TIMESTAMP(3);
