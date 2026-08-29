-- Il nonce del tentativo di sottoscrizione, e il momento in cui e' stato speso.
--
-- Al ritorno dal pagamento Shopify aggiunge alla URL solo un `charge_id`: senza
-- un segno nostro, la callback non sa quale tentativo sta chiudendo e deve dare
-- per buono che tutto il resto combaci. Il nonce viaggia firmato nella URL di
-- ritorno e vive qui: la callback ritrova la riga esatta, confronta piano,
-- cifra, valuta e cadenza con quello che Shopify dichiara, e spendendolo rende
-- innocua la stessa callback ripetuta.
--
-- Additive: due colonne nuove, nullable, nessun dato toccato. Le righe
-- precedenti restano senza nonce e continuano a ritrovarsi dal charge_id.

ALTER TABLE "billing_charges"
  ADD COLUMN IF NOT EXISTS "callback_nonce" TEXT,
  ADD COLUMN IF NOT EXISTS "callback_nonce_used_at" TIMESTAMP(3);

-- Un nonce appartiene a un tentativo solo: cosi' ritrovare la riga e' una
-- lettura per chiave. I NULL non si contano fra loro, quindi le righe vecchie
-- non danno fastidio.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_charges_callback_nonce_key"
  ON "billing_charges" ("callback_nonce");
