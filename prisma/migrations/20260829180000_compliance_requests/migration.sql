-- La coda durevole delle richieste di conformita' (customers/data_request,
-- customers/redact, shop/redact).
--
-- Prima non c'era, e i tre webhook facevano tutto dentro la richiesta: letture
-- sul nostro database, letture sul progetto del merchant, ordini e righe
-- d'ordine, e poi la risposta. Shopify pero' tratta il 2xx come una ricevuta e
-- taglia la richiesta a cinque secondi — quel modello non era lento, era il
-- modello sbagliato. Ora il webhook scrive una riga qui e risponde; il lavoro
-- vero, i suoi tentativi e la consegna al merchant vengono dopo.
--
-- Additive: una tabella nuova, nessuna riga esistente toccata.

CREATE TABLE IF NOT EXISTS "compliance_requests" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "data_request_id" TEXT,
    "topic" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shop_id" TEXT,
    "customer_ref" TEXT,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "export" JSONB,
    "export_expires_at" TIMESTAMP(3),
    "downloaded_at" TIMESTAMP(3),

    CONSTRAINT "compliance_requests_pkey" PRIMARY KEY ("id")
);

-- La deduplica: l'id della consegna e' unico, quindi una seconda consegna della
-- stessa richiesta si schianta qui invece di produrre una seconda esportazione
-- o una seconda cancellazione in corsa con la prima.
CREATE UNIQUE INDEX IF NOT EXISTS "compliance_requests_webhook_id_key"
  ON "compliance_requests" ("webhook_id");

-- Secondo livello, per le richieste di accesso: la pratica lato Shopify resta
-- quella anche se l'id della consegna cambia. I NULL non si contano fra loro,
-- quindi i topic che non hanno un `data_request.id` non danno fastidio.
CREATE UNIQUE INDEX IF NOT EXISTS "compliance_requests_shop_domain_data_request_id_key"
  ON "compliance_requests" ("shop_domain", "data_request_id");

-- La lettura del drenaggio: cosa c'e' da lavorare, dalla piu' vecchia.
CREATE INDEX IF NOT EXISTS "compliance_requests_status_received_at_idx"
  ON "compliance_requests" ("status", "received_at");

-- La lettura della pagina del merchant: le sue richieste, dalla piu' recente.
CREATE INDEX IF NOT EXISTS "compliance_requests_shop_domain_received_at_idx"
  ON "compliance_requests" ("shop_domain", "received_at" DESC);

-- SET NULL e non CASCADE: shop/redact cancella il negozio, e la riga che sta
-- registrando quella stessa cancellazione non puo' sparire mentre la esegue.
ALTER TABLE "compliance_requests"
  DROP CONSTRAINT IF EXISTS "compliance_requests_shop_id_fkey";
ALTER TABLE "compliance_requests"
  ADD CONSTRAINT "compliance_requests_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
