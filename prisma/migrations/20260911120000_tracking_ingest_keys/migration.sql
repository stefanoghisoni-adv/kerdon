-- La credenziale con cui un negozio SCRIVE, separata da quella con cui legge.
--
-- PERCHE'. Le rotte `/rest/v1/users` e `/rest/v1/identify` — che creano righe di
-- visitatori e legano un browser a una persona — chiedevano lo stesso identico
-- token con cui il proxy SERVE i dati gia' sincronizzati. Quelle scritture
-- passano dalla chiave di servizio del progetto del merchant, che salta le RLS:
-- un merchant che avesse dato la chiave di lettura a un'agenzia le aveva dato
-- anche il permesso di dichiarare che un browser qualsiasi appartiene a un
-- cliente qualsiasi. Una credenziale di sola lettura scriveva con i privilegi
-- massimi.
--
-- PERCHE' UNA TABELLA E NON DUE COLONNE SU `shops`, che e' come sta il token di
-- lettura. Tre ragioni, e nessuna si risolve con delle colonne:
--
--  - la ROTAZIONE ha bisogno di due righe vive insieme. Fra il "ruota" e la
--    pubblicazione del valore nuovo dentro un container server-side passano ore
--    o giorni; con due colonne, ruotare sovrascrive e il tracciamento si ferma
--    finche' il merchant non arriva a ripubblicare. Una misura di sicurezza che
--    si paga con un'interruzione e' una misura che nessuno usa;
--  - gli AMBITI sono per credenziale, non per negozio: chi installa il ponte in
--    vetrina deve poter scrivere l'identificativo e NON deve poter legare un
--    browser a una persona. Un array su `shops` darebbe un permesso solo per
--    tutte le chiavi, che e' lo stesso errore da cui si parte, in piccolo;
--  - la REVOCA e' una frase su una chiave ("questa e' finita dove non doveva"),
--    non su un negozio.
--
-- Additive, e in due pezzi indipendenti: una tabella nuova che nasce vuota, e
-- due colonne su `tracking_setups` che nascono NULL. Nessuna riga esistente
-- cambia significato. Finche' nessun negozio ha una credenziale di ingest, le
-- rotte di scrittura continuano a funzionare con il token di lettura — che e'
-- esattamente la fase di convivenza, e ha una data di fine scritta nel codice
-- (`INGEST_LEGACY_SUNSET_DEFAULT`).

CREATE TABLE IF NOT EXISTS "tracking_ingest_keys" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "secret_cipher" TEXT NOT NULL,
    "value_hash" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'ingest',
    "version" INTEGER NOT NULL DEFAULT 1,
    "scopes" TEXT[],
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "tracking_ingest_keys_pkey" PRIMARY KEY ("id")
);

-- L'identificativo pubblico e' il solo modo di trovare la riga: arriva in
-- chiaro nell'intestazione e qui sotto c'e' l'indice che lo rende una lettura
-- sola. Unico perche' due credenziali con lo stesso identificativo vorrebbero
-- dire una firma che si puo' verificare con due segreti diversi.
CREATE UNIQUE INDEX IF NOT EXISTS "tracking_ingest_keys_key_id_key"
  ON "tracking_ingest_keys" ("key_id");

-- Le credenziali vive di un negozio: la domanda della card di Impostazioni e
-- della rotazione, che deve datare tutte quelle che c'erano.
CREATE INDEX IF NOT EXISTS "tracking_ingest_keys_shop_id_revoked_at_idx"
  ON "tracking_ingest_keys" ("shop_id", "revoked_at");

-- CASCADE e non SET NULL, al contrario di `consent_revocations` e
-- `webhook_events`: quelle due sono PROVE, e una prova che sparisce insieme al
-- negozio di cui parla non prova niente. Questa e' una CREDENZIALE, e una
-- credenziale che sopravvive al negozio a cui apriva la porta e' solo una
-- chiave orfana che resta valida per un negozio che non esiste piu'.
ALTER TABLE "tracking_ingest_keys"
  DROP CONSTRAINT IF EXISTS "tracking_ingest_keys_shop_id_fkey";
ALTER TABLE "tracking_ingest_keys"
  ADD CONSTRAINT "tracking_ingest_keys_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, come su ogni altra tabella dello schema public.
--
-- Qui pesa piu' che altrove, ed e' il caso peggiore che questo progetto abbia
-- messo in una tabella: Supabase pubblica lo schema `public` attraverso la Data
-- API, e senza questa riga basterebbe la anon key del progetto — una chiave che
-- sta nei browser e non e' un segreto — per leggersi i segreti cifrati di ogni
-- credenziale di scrittura di ogni negozio. Nessuna policy, come per le altre:
-- Prisma si collega come proprietario e scavalca RLS, zero policy significa che
-- dalla Data API non si legge niente.
ALTER TABLE "tracking_ingest_keys" ENABLE ROW LEVEL SECURITY;

-- La metrica di adozione del passaggio alla chiave nuova.
--
-- Due date e non due contatori: un contatore vorrebbe dire una scrittura sul
-- database owner a ogni visita di ogni vetrina per rispondere a una domanda che
-- si fa una volta a settimana ("chi ha ancora bisogno della chiave vecchia?").
-- Le date si riscrivono al massimo ogni dieci minuti per negozio, e sono anche
-- quel che il merchant vede in Impostazioni: non un numero, ma "l'installazione
-- e' aggiornata" oppure "va aggiornata".
ALTER TABLE "tracking_setups" ADD COLUMN IF NOT EXISTS "ingest_last_signed_at" TIMESTAMP(3);
ALTER TABLE "tracking_setups" ADD COLUMN IF NOT EXISTS "ingest_last_legacy_at" TIMESTAMP(3);
