-- Le piattaforme dell'elenco Integrazioni, con il loro stato.
CREATE TABLE IF NOT EXISTS "integration_platforms" (
  "id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "logo_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'coming_soon',
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_platforms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "integration_platforms_slug_key"
  ON "integration_platforms" ("slug");
CREATE INDEX IF NOT EXISTS "integration_platforms_category_idx"
  ON "integration_platforms" ("category");

-- L'elenco di partenza. Tutte in arrivo: lo stato lo alzi tu quando la
-- connessione di quella piattaforma esiste davvero.
INSERT INTO "integration_platforms" ("id", "category", "name", "slug", "position")
VALUES
  (gen_random_uuid()::text, 'advertising', 'Meta Ads',      'meta-ads',      10),
  (gen_random_uuid()::text, 'advertising', 'Google Ads',    'google-ads',    20),
  (gen_random_uuid()::text, 'advertising', 'TikTok Ads',    'tiktok-ads',    30),
  (gen_random_uuid()::text, 'advertising', 'Pinterest Ads', 'pinterest-ads', 40),
  (gen_random_uuid()::text, 'advertising', 'Snapchat Ads',  'snapchat-ads',  50),
  (gen_random_uuid()::text, 'advertising', 'ChatGPT Ads',   'chatgpt-ads',   60),
  (gen_random_uuid()::text, 'crm',         'HubSpot',       'hubspot',       10),
  (gen_random_uuid()::text, 'crm',         'GoHighLevel',   'gohighlevel',   20),
  (gen_random_uuid()::text, 'email',       'Klaviyo',       'klaviyo',       10),
  (gen_random_uuid()::text, 'email',       'Mailchimp',     'mailchimp',     20)
ON CONFLICT ("slug") DO NOTHING;

-- RLS, come su tutte le altre. Mancava.
ALTER TABLE "integration_platforms" ENABLE ROW LEVEL SECURITY;
