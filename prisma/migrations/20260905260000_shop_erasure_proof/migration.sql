-- La cancellazione di un negozio: la prova che le sopravvive, e il gettone che
-- chiude le scritture prima che cominci.
--
-- PERCHE'. `shop/redact` cancellava log di accesso, sessioni e `shops` in tre
-- try/catch separati. Se il primo falliva e l'ultimo riusciva, i log restavano
-- orfani con lo `shop_id` azzerato e il ritentativo non conosceva piu' l'id da
-- cui ripartire: quelle righe non le avrebbe piu' tolte nessuno. E la traccia
-- di controllo finiva in `sync_jobs`, che ha una chiave esterna IN CASCATA
-- verso `shops`: spariva insieme al negozio di cui parlava. Restava un
-- `console.log`, che non e' una prova.
--
-- PERCHE' UNA TABELLA E NON UN TIPO NUOVO IN `sync_requests`. Un item di coda
-- e' una sveglia, non una prova — si consuma e si pota — e la sua `dedup_key`
-- e' unica per sempre, quindi ci finirebbe dentro il dominio in chiaro. Le
-- altre due case candidate sono peggio, ognuna a modo suo: `compliance_requests`
-- porta il dominio in chiaro ed e' proprio la riga che a cancellazione riuscita
-- va tolta di mezzo; `sync_jobs` e' il guasto stesso, visto che cade in cascata
-- con il negozio. Serviva un registro senza legami con `shops`, senza dati
-- personali dentro e con una ritenzione sua.
--
-- Additive: due colonne con un default e una tabella nuova. Nessuna riga
-- esistente cambia significato — i negozi gia' presenti nascono 'active' con
-- generazione 0, che e' esattamente quello che erano — e le cancellazioni
-- avvenute prima di questa migrazione restano senza prova: non c'e' niente da
-- cui ricostruirle, visto che il negozio non c'e' piu'.

-- Il ciclo di vita del negozio, e il gettone della cancellazione.
--
-- `lifecycle_status` si porta a 'erasing' in una scrittura sua, PRIMA della
-- transazione che cancella: chi legge deve vederla cambiata mentre il lavoro e'
-- in corso, non alla fine. Se la transazione fallisce la colonna resta li', ed
-- e' voluto — il negozio e' in attesa di cancellazione, e riaprirlo al lavoro
-- vorrebbe dire riscrivere quel che il ritentativo dovra' togliere.
--
-- `erasure_generation` cresce a ogni inizio e non riparte mai da zero: e' il
-- gemello di `shop_locks.fencing_token` per il ciclo di vita. Una corsa partita
-- prima se lo porta dietro e lo riverifica un istante prima di ogni scrittura
-- sul database del merchant.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "lifecycle_status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "erasure_generation" INTEGER NOT NULL DEFAULT 0;

-- La prova, che al negozio sopravvive.
--
-- Dentro c'e' solo quello che serve a dimostrare l'esecuzione: l'id della
-- consegna, il topic, l'istante, l'esito, i conteggi per tabella, la versione
-- della procedura e l'impronta del negozio. Nessun dominio, nessun id, nessuna
-- email — un registro di cancellazioni che conserva quello che ha cancellato e'
-- il modo piu' elegante di non aver cancellato niente.
CREATE TABLE IF NOT EXISTS "shop_erasure_proofs" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop_ref" TEXT NOT NULL,
    "procedure_version" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "counts" JSONB NOT NULL,
    "erasure_generation" INTEGER,
    "erased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_erasure_proofs_pkey" PRIMARY KEY ("id")
);

-- L'indice su cui poggia l'idempotenza: la seconda consegna della stessa
-- richiesta trova la prova gia' scritta e si dichiara fatta, invece di andare a
-- cercare un negozio che non esiste piu'.
CREATE UNIQUE INDEX IF NOT EXISTS "shop_erasure_proofs_webhook_id_key"
  ON "shop_erasure_proofs" ("webhook_id");

-- La domanda a cui la prova esiste per rispondere: "questo negozio e' stato
-- cancellato?". Chi la fa ricalcola l'impronta e cerca qui. NON e' unico: lo
-- stesso negozio puo' installare, disinstallare e chiedere di nuovo, e ogni
-- richiesta ha diritto alla sua prova.
CREATE INDEX IF NOT EXISTS "shop_erasure_proofs_shop_ref_idx"
  ON "shop_erasure_proofs" ("shop_ref");

-- Per la ritenzione e per chi guarda un periodo.
CREATE INDEX IF NOT EXISTS "shop_erasure_proofs_erased_at_idx"
  ON "shop_erasure_proofs" ("erased_at");

-- NESSUNA chiave esterna verso `shops`, e non e' una dimenticanza: e' il punto
-- di tutta la tabella. Nemmeno SET NULL andrebbe bene — quella vorrebbe dire
-- una colonna con l'id del negozio, cioe' un riferimento in piu' a una cosa che
-- abbiamo appena finito di cancellare. Del negozio qui resta solo l'impronta.

-- RLS, come su ogni altra tabella dello schema public.
--
-- Qui pesa quanto sulle revoche: Supabase pubblica lo schema `public`
-- attraverso la Data API, e senza questa riga basterebbe la anon key del
-- progetto — una chiave che sta nei browser e non e' un segreto — per leggere
-- l'elenco delle cancellazioni. Nessuna policy, come per le altre: Prisma si
-- collega come proprietario e scavalca RLS, zero policy significa che dalla
-- Data API non si legge niente.
ALTER TABLE "shop_erasure_proofs" ENABLE ROW LEVEL SECURITY;
