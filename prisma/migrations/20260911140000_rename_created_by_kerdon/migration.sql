-- L'ultima colonna che portava il nome di prima del cambio.
--
-- PERCHE' ADESSO E NON PRIMA. Rinominare una colonna e' l'unica modifica di
-- questo rebrand che tocca dati gia' scritti, e finche' non si sapeva quanti
-- negozi fossero collegati non valeva il rischio: una riscrittura per un fatto
-- di sola lettura umana. Con l'app non ancora pubblicata e un solo negozio di
-- prova, la tabella conta una manciata di righe e il rename e' istantaneo —
-- Postgres cambia il nome nel catalogo, non riscrive niente.
--
-- Sotto guardia, e serve davvero: un database creato da zero con
-- `owner-bootstrap.sql` nasce gia' con il nome nuovo, e su quello un rename
-- nudo fallirebbe fermando tutta la coda delle migrazioni.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'supabase_managed_resources'
      AND column_name = 'created_by_coreward'
  ) THEN
    ALTER TABLE "supabase_managed_resources"
      RENAME COLUMN "created_by_coreward" TO "created_by_kerdon";
  END IF;
END $$;
