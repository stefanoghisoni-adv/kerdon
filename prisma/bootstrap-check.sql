-- Cosa deve essere vero subito dopo `owner-bootstrap.sql`, su un database vuoto.
--
-- Le tabelle e le colonne le confronta Prisma (`migrate diff`), che sa leggere
-- lo schema meglio di qualunque query scritta a mano. Qui c'e' quello che
-- `migrate diff` non guarda: le righe iniziali, che fanno parte del bootstrap
-- quanto le tabelle — senza i cinque piani l'app parte e non sa cosa concedere
-- a nessuno — e l'attivazione di RLS, che protegge i token dei merchant da
-- chiunque abbia la chiave pubblica del progetto.
--
-- Si esegue con `-v ON_ERROR_STOP=1`: un'eccezione qui deve fermare la CI.

DO $$
DECLARE
  piani int;
  prezzi int;
  senza_rls text;
BEGIN
  SELECT count(*) INTO piani FROM plans;
  IF piani <> 5 THEN
    RAISE EXCEPTION 'attesi 5 piani, trovati %', piani;
  END IF;

  SELECT count(*) INTO prezzi FROM plan_prices;
  IF prezzi <> 5 THEN
    RAISE EXCEPTION 'atteso un prezzo per piano, trovati %', prezzi;
  END IF;

  -- RLS ovunque e nessuna policy: e' cio' che impedisce alla Data API di
  -- Supabase di servire queste tabelle a chi ha la sola chiave pubblica. Una
  -- tabella nuova aggiunta senza ripassare di li' resterebbe scoperta.
  SELECT string_agg(tablename, ', ') INTO senza_rls
  FROM pg_tables
  WHERE schemaname = 'public' AND NOT rowsecurity;

  IF senza_rls IS NOT NULL THEN
    RAISE EXCEPTION 'tabelle senza row level security: %', senza_rls;
  END IF;
END $$;
