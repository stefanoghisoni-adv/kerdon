-- RLS su OGNI tabella dello schema public, comprese quelle che l'hanno gia'.
--
-- Perche' serve una migrazione e non bastava la regola: `owner-bootstrap.sql`
-- attiva RLS con un ciclo su tutte le tabelle, quindi un database ricostruito da
-- zero e' a posto per costruzione. Il database owner in uso pero' e' stato
-- costruito una volta sola, a luglio, e da allora e' cresciuto per migrazioni
-- applicate a mano — e una migrazione deve dire la riga tabella per tabella.
-- Dove non e' stata detta, la tabella e' rimasta scoperta.
--
-- Cosa vuol dire scoperta: Supabase pubblica lo schema `public` attraverso la
-- Data API. Senza RLS chiunque abbia la anon key del progetto — che e' una
-- chiave pensata per stare nei browser, non un segreto — puo' leggere la
-- tabella. E' gia' successo con `compliance_requests`, che conteneva le
-- esportazioni GDPR complete; le migrazioni che creavano `plan_prices`,
-- `meta_connections` (token di accesso a Meta), `product_feeds` (il token con
-- cui si scarica un feed senza autenticarsi) e `feed_field_mappings` avevano la
-- stessa dimenticanza. Quelle righe ora ci sono, ma solo per chi rigioca le
-- migrazioni da zero: sul database owner quelle migrazioni sono gia' passate.
--
-- Quindi: un colpo solo, su tutto, adesso.
--
-- Nessuna policy, come sempre. Prisma si collega come proprietario delle
-- tabelle e il proprietario scavalca RLS (non c'e' FORCE ROW LEVEL SECURITY),
-- quindi l'app non se ne accorge; zero policy significa che dalla Data API non
-- si legge niente.
--
-- Idempotente e senza effetti su una tabella che ce l'ha gia'. Comprende
-- `_prisma_migrations`: e' una tabella dello schema public come le altre, e
-- Prisma continua a leggerla e scriverla perche' ne e' il proprietario.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
