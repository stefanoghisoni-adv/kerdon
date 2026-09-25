-- Cosa deve essere vero di un database owner: appena costruito, appena
-- migrato, o in produzione da mesi.
--
-- Le tabelle e le colonne le confronta Prisma (`migrate diff`, filtrato da
-- prisma/expected-drift.ts), che sa leggere lo schema meglio di qualunque query
-- scritta a mano. Qui c'e' quello che `migrate diff` non guarda:
--
--   1. le righe iniziali, che fanno parte del database quanto le tabelle —
--      senza i piani e il loro listino l'app parte e non sa cosa concedere a
--      nessuno;
--   2. l'attivazione di RLS, che protegge i token dei merchant da chiunque
--      abbia la chiave pubblica del progetto;
--   3. le due chiavi esterne sul nome del piano, che lo schema non modella e
--      che `migrate diff` proporrebbe di cancellare.
--
-- Scritto come INVARIANTI e non come conteggi esatti, di proposito: prima
-- pretendeva "esattamente 5 piani", e cosi' scritto valeva solo su un database
-- appena costruito — bastava aggiungere un piano al listino per renderlo falso.
-- Serve invece in tre posti, e in tutti e tre deve dire la verita': la CI dopo
-- `owner-bootstrap.sql`, la CI dopo `prisma migrate deploy`, e il workflow di
-- migrazione dopo aver toccato la produzione.
--
-- Si esegue con `-v ON_ERROR_STOP=1`: un'eccezione qui deve fermare tutto.
--
-- DUE FASI. Il workflow di migrazione lo esegue due volte, e le due volte il
-- listino non e' lo stesso:
--
--   -v fase=pre   PRIMA di `migrate deploy`. La produzione puo' essere ancora
--                 su uno dei listini di prima — Free/Pro/Business/Enterprise
--                 (A) o Free/Core/Growth/Scale (B, dopo pricing_alignment) —
--                 e deve poter arrivare alla migrazione che la porta al
--                 listino finale. Qui basta che uno dei tre listini ci sia
--                 per intero.
--   -v fase=post  DOPO (e il default, se `fase` non si passa: la CI). Il
--                 listino deve essere quello finale, Basic/Growth/Scale/Core.
--
-- Senza la fase `pre` il controllo fermerebbe la produzione proprio prima
-- della migrazione che la mette a posto.

\if :{?fase}
\else
  \set fase post
\endif
SELECT set_config('kerdon.fase', :'fase', false);

DO $$
DECLARE
  fase text := coalesce(nullif(current_setting('kerdon.fase', true), ''), 'post');
  mancanti text;
  senza_rls text;
  senza_fk text;
BEGIN
  IF fase NOT IN ('pre', 'post') THEN
    RAISE EXCEPTION 'fase sconosciuta: % (attese: pre, post)', fase;
  END IF;

  -- 1a. I piani su cui l'app conta. Averne di piu' e' normale (un listino
  --     cresce); averne di meno vuol dire negozi senza piano valido.
  SELECT string_agg(atteso, ', ') INTO mancanti
  FROM unnest(ARRAY['Basic', 'Growth', 'Scale', 'Core', 'Lifetime']) AS atteso
  WHERE NOT EXISTS (SELECT 1 FROM plans p WHERE p.plan_name = atteso);

  -- Prima della migrazione vanno bene anche i due listini di prima, purche'
  -- completi: e' da li' che 20260926000000_plans_basic_growth_scale_core parte.
  IF mancanti IS NOT NULL AND fase = 'pre' AND (
    NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY['Free', 'Pro', 'Business', 'Enterprise', 'Lifetime']) AS a
      WHERE NOT EXISTS (SELECT 1 FROM plans p WHERE p.plan_name = a)
    )
    OR NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY['Free', 'Core', 'Growth', 'Scale', 'Lifetime']) AS b
      WHERE NOT EXISTS (SELECT 1 FROM plans p WHERE p.plan_name = b)
    )
  ) THEN
    mancanti := NULL;
  END IF;

  IF mancanti IS NOT NULL THEN
    RAISE EXCEPTION 'piani mancanti in plans (fase %): %', fase, mancanti;
  END IF;

  -- 1b. Ogni piano ha il suo prezzo in dollari: e' la valuta base, quella della
  --     scheda dell'App Store, ed e' da queste righe che l'app sa quali piani
  --     sono a pagamento. Un piano senza riga verrebbe dato per gratuito.
  SELECT string_agg(p.plan_name, ', ') INTO mancanti
  FROM plans p
  WHERE NOT EXISTS (
    SELECT 1 FROM plan_prices pp
    WHERE pp.plan_name = p.plan_name AND pp.currency = 'USD'
  );

  IF mancanti IS NOT NULL THEN
    RAISE EXCEPTION 'piani senza prezzo in USD: %', mancanti;
  END IF;

  -- 2. RLS ovunque e nessuna policy: e' cio' che impedisce alla Data API di
  --    Supabase di servire queste tabelle a chi ha la sola chiave pubblica. Una
  --    tabella nuova aggiunta senza ripassare di li' resterebbe scoperta — e'
  --    successo con compliance_requests, che conteneva le esportazioni GDPR.
  SELECT string_agg(tablename, ', ') INTO senza_rls
  FROM pg_tables
  WHERE schemaname = 'public' AND NOT rowsecurity;

  IF senza_rls IS NOT NULL THEN
    RAISE EXCEPTION 'tabelle senza row level security: %', senza_rls;
  END IF;

  -- 3. Le due chiavi esterne dal nome del piano scritto sul negozio al listino.
  --
  --    Non sono in schema.prisma — Prisma vorrebbe una relazione sull'id, qui il
  --    legame e' sul NOME — quindi `prisma migrate diff` le vede come qualcosa
  --    da cancellare, e chi applicasse il suo output alla lettera lo farebbe.
  --    Sono volute: sono quello che rende current_plan un elenco a tendina nel
  --    Table Editor invece di un campo di testo libero, e che impedisce a un
  --    refuso di finire su un negozio. Se questa eccezione scatta, qualcuno le
  --    ha cancellate: le ricrea la coda di owner-bootstrap.sql.
  SELECT string_agg(atteso, ', ') INTO senza_fk
  FROM unnest(ARRAY['shops_current_plan_fkey', 'shops_last_synced_plan_fkey']) AS atteso
  WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = atteso);

  IF senza_fk IS NOT NULL THEN
    RAISE EXCEPTION 'chiavi esterne sul nome del piano mancanti: %', senza_fk;
  END IF;
END $$;
