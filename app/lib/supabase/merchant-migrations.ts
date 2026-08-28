import { buildMerchantSchemaSQL, RELOAD_SCHEMA_SQL } from '~/lib/supabase-schema';

/**
 * Aggiornamenti dello schema sui database dei merchant.
 *
 * Il problema che risolvono: i progetti Supabase sono dei merchant, non nostri.
 * Quando le tabelle dell'app cambiano non possiamo entrare noi a eseguire SQL,
 * e non ha senso chiederlo a loro. Qui lo schema si allinea da solo.
 *
 * Due meccanismi, complementari:
 *
 *  - la DDL corrente (`buildMerchantSchemaSQL`) e' idempotente e additiva:
 *    CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS. Rieseguirla allinea
 *    da sola qualunque colonna nuova, senza toccare i dati. Viene sempre
 *    applicata in coda.
 *
 *  - i passi espliciti qui sotto servono a cio' che una DDL additiva non sa
 *    fare: rinominare una colonna portandosi dietro i dati, spostare valori,
 *    sistemare indici. Ognuno dev'essere idempotente: puo' capitare che venga
 *    eseguito su un progetto che l'ha gia' ricevuto.
 */
export interface MerchantMigration {
  version: number;
  description: string;
  sql: string;
}

export const MERCHANT_MIGRATIONS: MerchantMigration[] = [
  {
    version: 1,
    description: 'Nomi per esteso delle colonne identificative dei clienti',
    // email -> email_address, phone -> phone_number. Una ADD COLUMN lascerebbe
    // i dati nella colonna vecchia e la sincronizzazione scriverebbe altrove:
    // il RENAME invece se li porta dietro.
    sql: `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'email'
  ) THEN
    ALTER TABLE public.customers RENAME COLUMN email TO email_address;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'phone'
  ) THEN
    ALTER TABLE public.customers RENAME COLUMN phone TO phone_number;
  END IF;
END $$;

-- Gli indici seguono la colonna rinominata ma conservano il vecchio nome: senza
-- questo, alla prossima DDL ne verrebbe creato un secondo identico.
ALTER INDEX IF EXISTS idx_customers_email RENAME TO idx_customers_email_address;
ALTER INDEX IF EXISTS idx_customers_phone RENAME TO idx_customers_phone_number;
`,
  },
  {
    version: 6,
    description: 'Telefono in sole cifre e data di nascita come YYYYMMDD',
    // Due cose che la DDL additiva non sa fare: cambiare il tipo di una colonna
    // e riscrivere i dati gia' dentro.
    //
    // `date_of_birth` era nata DATE, e un DATE non puo' contenere "19850423".
    // La conversione e' innocua perche' la colonna e' vuota — nessuno la scrive
    // ancora — ma va fatta prima che qualcuno cominci.
    //
    // I telefoni gia' sincronizzati restano nella forma leggibile di Shopify
    // ("+39 333 123 4567"), che per un confronto non vale: senza questa riga
    // proprio i clienti piu' vecchi resterebbero fuori dai pubblici, e sono
    // quelli che contano di piu'. `regexp_replace` e' idempotente: rieseguirla
    // su un numero gia' pulito non lo tocca.
    sql: `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customers'
      AND column_name = 'date_of_birth'
      AND data_type = 'date'
  ) THEN
    ALTER TABLE public.customers
      ALTER COLUMN date_of_birth TYPE TEXT
      USING to_char(date_of_birth, 'YYYYMMDD');
  END IF;
END $$;

UPDATE public.customers
SET phone_number = regexp_replace(phone_number, '[^0-9]', '', 'g')
WHERE phone_number IS NOT NULL
  AND phone_number <> regexp_replace(phone_number, '[^0-9]', '', 'g');

-- Un numero fatto di soli separatori diventa una stringa vuota: e' un'assenza,
-- e va scritta come tale o finisce nei pubblici come cliente senza telefono ma
-- con il campo pieno.
UPDATE public.customers
SET phone_number = NULL
WHERE phone_number = '';
`,
  },
];

/**
 * Schema che l'app si aspetta oggi.
 *
 * VA ALZATA a ogni cambiamento delle tabelle dei merchant — colonna nuova,
 * indice nuovo, rinomina — altrimenti i progetti gia' collegati restano com'e'
 * e la sincronizzazione scrive su colonne che non esistono. Per le aggiunte
 * basta alzare il numero (ci pensa la DDL idempotente); per tutto il resto si
 * aggiunge anche un passo a MERCHANT_MIGRATIONS.
 */
/**
 * La 4, e non la 3.
 *
 * La 3 e' bruciata: e' stata pubblicata per errore insieme alle tabelle degli
 * ordini, quando la DDL non le creava ancora, e i progetti aperti in quei
 * giorni si sono presi il numero senza ricevere niente. Riusarla li avrebbe
 * lasciati senza tabelle e senza modo di accorgersene — per loro
 * l'aggiornamento sarebbe risultato gia' fatto.
 */
/**
 * La 5 ha portato l'indirizzo del cliente — paese, via, CAP, regione — piu' due
 * colonne che Shopify non riempie da sola (`external_id`, `date_of_birth`).
 *
 * La 6 sistema il formato dei due campi che le piattaforme pubblicitarie
 * confrontano: telefono in sole cifre, data di nascita come YYYYMMDD. Ha un
 * passo esplicito perche' cambia un tipo e riscrive dati gia' presenti, cose
 * che la DDL additiva non sa fare.
 *
 * La 7 porta `users`, la tabella dei browser conosciuti. Nessun passo
 * esplicito: e' una tabella nuova, e per quelle basta la DDL idempotente — che
 * pero' viaggia solo se questo numero e' salito. Senza il numero, i progetti
 * gia' collegati resterebbero senza la tabella e il riconoscimento del
 * visitatore non partirebbe mai per nessuno di loro.
 */
export const LATEST_SCHEMA_VERSION = 7;

/** Il database del merchant e' indietro rispetto a cio' che l'app si aspetta. */
export function needsSchemaUpdate(currentVersion: number | null | undefined): boolean {
  return (currentVersion ?? 0) < LATEST_SCHEMA_VERSION;
}

export function pendingMigrations(
  currentVersion: number | null | undefined,
): MerchantMigration[] {
  const from = currentVersion ?? 0;
  return MERCHANT_MIGRATIONS.filter(
    (m) => m.version > from && m.version <= LATEST_SCHEMA_VERSION,
  ).sort((a, b) => a.version - b.version);
}

/**
 * SQL completo dell'aggiornamento, o null se non c'e' nulla da fare.
 *
 * Ordine: prima i passi espliciti (rinomine), poi la DDL corrente che aggiunge
 * il mancante, infine la ricarica dello schema — senza quella l'API REST del
 * progetto continuerebbe a rispondere con le colonne di prima.
 */
export function buildSchemaUpdateSQL(
  currentVersion: number | null | undefined,
  includeCustomers: boolean,
  includeOrders = false,
): string | null {
  if (!needsSchemaUpdate(currentVersion)) return null;

  const steps = pendingMigrations(currentVersion).map((m) => m.sql);
  return [
    ...steps,
    buildMerchantSchemaSQL(includeCustomers, includeOrders),
    RELOAD_SCHEMA_SQL,
  ].join('\n');
}
