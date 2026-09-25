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
  /**
   * Il passo va eseguito DOPO la DDL invece che prima.
   *
   * Prima e' il posto giusto per le rinomine: la DDL, trovando la colonna nuova
   * gia' li' col nome nuovo, non la ricrea vuota accanto a quella piena. Ma un
   * passo che riempie una colonna APPENA AGGIUNTA non puo' girare prima di chi
   * la aggiunge — la colonna non esiste ancora, e l'UPDATE fallisce portandosi
   * dietro l'intero aggiornamento.
   *
   * L'alternativa era ripetere le ADD COLUMN dentro al passo: un doppione da
   * tenere allineato a mano a ogni modifica della DDL, che e' esattamente cio'
   * che questo file evita altrove.
   */
  runAfterDDL?: boolean;
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
  {
    version: 9,
    description: 'Righe d ordine: quantita corrente e netto di riga sullo storico',
    // Dopo la DDL: le due colonne che questo passo riempie e' la DDL ad
    // aggiungerle, e prima di lei non esistono ancora.
    runAfterDDL: true,
    // Le due colonne le aggiunge la DDL; questo passo mette dentro un valore
    // alle righe che c'erano gia', e senza di lui l'aggiornamento sarebbe un
    // disastro silenzioso.
    //
    // Il conto nuovo e' `line_net_total - costo * current_quantity`. Su una riga
    // storica `line_net_total` e' NULL e `current_quantity` e' 0 (il default):
    // la riga smette di essere misurabile e sparisce dal profitto. Non
    // sbagliato di poco — proprio azzerato, per tutto lo storico, il giorno
    // dell'aggiornamento.
    //
    // Quello che si scrive qui e' PROVVISORIO e lo si dichiara: e'
    // esattamente il vecchio conto (`unit_price * quantity`), cioe' i numeri
    // che il merchant vedeva ieri. Non corregge i rimborsi — non c'e' da dove
    // ricavarli, quel dato sta su Shopify e non qui — ma non regala nemmeno un
    // crollo a zero che sarebbe piu' falso di cio' che sostituisce. I valori
    // veri arrivano rileggendo gli ordini da Shopify (vedi
    // `lib/sync/orders-backfill`), e la rilettura li sovrascrive.
    //
    // `WHERE line_net_total IS NULL` rende il passo idempotente e, soprattutto,
    // gli impedisce di calpestare le righe gia' rilette: un merchant a meta'
    // backfill che riceve di nuovo questo SQL non deve tornare indietro.
    sql: `
DO $$
BEGIN
  -- La tabella puo' non esistere: gli ordini si sincronizzano solo per chi ha
  -- concesso il permesso, e per gli altri qui non c'e' niente da aggiornare.
  IF to_regclass('public.order_lines') IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.order_lines
  SET current_quantity = COALESCE(quantity, 0)
  WHERE current_quantity = 0
    AND COALESCE(quantity, 0) <> 0
    AND line_net_total IS NULL;

  UPDATE public.order_lines
  SET line_net_total = ROUND(unit_price * COALESCE(quantity, 0), 2)
  WHERE line_net_total IS NULL
    AND unit_price IS NOT NULL;

  -- La valuta della riga si prende dall'ordine: e' l'unica fonte che c'e', ed
  -- e' quella giusta finche' l'ordine ne dichiara una sola.
  UPDATE public.order_lines l
  SET line_currency = o.currency
  FROM public.orders o
  WHERE o.shopify_order_id = l.shopify_order_id
    AND l.line_currency IS NULL
    AND o.currency IS NOT NULL;
END $$;
`,
  },
  {
    version: 11,
    description: 'Sblocca le righe d ordine a cui era stata congelata un assenza di costo',
    // Dopo la DDL: le due colonne che questo passo tocca sono della 10, e su un
    // progetto che salta dalla 9 alla 11 prima della DDL non esistono ancora.
    runAfterDDL: true,
    // LA RIPARAZIONE, e perche' sta qui invece che nel salvataggio del costo.
    //
    // Cosa era successo. Inserendo per la prima volta il costo di un prodotto
    // gia' venduto e scegliendo "solo da adesso in avanti", l'app congelava sul
    // passato il costo di prima — che non c'era. La riga restava senza valore ma
    // con la data del congelamento sopra: per il calcolo del profitto vuol dire
    // "conto chiuso", e da li' in poi nessun costo inserito poteva piu' farla
    // rientrare. Il merchant compilava il costo che l'app gli chiedeva e trovava
    // di nuovo profitto zero, senza niente da premere per uscirne.
    //
    // Il codice adesso non lo fa piu' (vedi `lib/products/cost-scope`), ma le
    // righe gia' marcate restano invisibili per sempre: il bug ha lasciato dati,
    // e i dati vanno sistemati dove sono.
    //
    // Perche' qui e non nel salvataggio del costo. Perche' quelle righe nascono
    // da un salvataggio gia' avvenuto: la variante ha ormai il suo costo, non
    // compare piu' nell'elenco dei problemi e il merchant non ha nessun motivo
    // per salvarla una seconda volta. Una riparazione agganciata al salvataggio
    // aspetterebbe un gesto che non arrivera'. Qui invece parte da sola alla
    // prima apertura della dashboard, per ogni negozio collegato, senza che
    // nessuno debba sapere di essere stato colpito.
    //
    // Perche' la condizione e' sicura. `unit_cost_at_sale IS NULL AND
    // unit_cost_frozen_at IS NOT NULL` descrive esattamente un'assenza
    // congelata, e non esiste un caso legittimo in cui debba restare: congelare
    // vuol dire fissare un valore, e se il valore non c'e' non e' stato fissato
    // niente. Le righe con un costo fissato davvero non vengono toccate — quelle
    // conservano un passato vero, ed e' l'unica cosa che il congelamento serve a
    // proteggere.
    //
    // Una tantum per davvero: dopo il fix quella combinazione non si ricrea, e
    // rieseguire l'UPDATE su un progetto gia' sistemato non trova piu' righe.
    sql: `
DO $$
BEGIN
  -- La tabella puo' non esistere: gli ordini si sincronizzano solo per chi ha
  -- concesso il permesso, e per gli altri qui non c'e' niente da riparare.
  IF to_regclass('public.order_lines') IS NULL THEN
    RETURN;
  END IF;

  -- E le due colonne possono non esserci: un progetto con la tabella ordini
  -- gia' creata ma il permesso ritirato non le riceve dalla DDL di questo giro,
  -- e un UPDATE su una colonna che non c'e' farebbe fallire tutto
  -- l'aggiornamento — comprese le parti che non c'entrano niente.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_lines'
      AND column_name = 'unit_cost_frozen_at'
  ) THEN
    RETURN;
  END IF;

  UPDATE public.order_lines
  SET unit_cost_frozen_at = NULL
  WHERE unit_cost_at_sale IS NULL
    AND unit_cost_frozen_at IS NOT NULL;
END $$;
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
 *
 * La 8 porta cinque colonne sui clienti: `city` (che Shopify mandava da sempre
 * e non veniva scritta da nessuna parte), `country_code` accanto al nome
 * esteso del paese, `total_profit` e i due identificativi dell'accesso con
 * Meta e Google. Nessun passo esplicito in MERCHANT_MIGRATIONS, e non per
 * dimenticanza: sono cinque aggiunte pure, senza rinomine ne' cambi di tipo ne'
 * dati da spostare, e per quelle basta la DDL additiva — che pero' viaggia solo
 * se questo numero e' salito. Un passo con dentro le stesse ADD COLUMN sarebbe
 * un doppione da tenere allineato a mano alla prossima modifica.
 *
 * Su chi si e' aggiunto `city` a mano prima di noi non cambia niente: la DDL e'
 * ADD COLUMN IF NOT EXISTS e il tipo dichiarato e' TEXT, lo stesso che avrebbe
 * scelto chiunque per una citta'. La colonna esistente resta com'e', coi dati
 * dentro.
 *
 * La 9 porta quattro colonne sulle righe d'ordine — `current_quantity`,
 * `line_net_total`, `line_currency`, `source_updated_at` — e con loro la fine
 * di un errore che si vedeva solo dopo un rimborso: il totale dell'ordine
 * seguiva `currentTotalPriceSet`, che i rimborsi li riflette, mentre ogni riga
 * conservava la quantita' ordinata e un prezzo unitario con dentro allocazioni
 * di sconto riferite anche a unita' rimborsate. Le metriche moltiplicavano quei
 * due valori: ricavi e margini piu' alti del vero, in modo credibile.
 *
 * Qui il passo esplicito serve eccome, ed e' l'unica volta in cui non aggiunge
 * niente allo schema: riempie le colonne appena create sulle righe che c'erano
 * gia'. Senza, `line_net_total` resterebbe NULL su tutto lo storico e il
 * profitto di ogni mese passato crollerebbe a zero il giorno
 * dell'aggiornamento. Per questo gira DOPO la DDL (`runAfterDDL`) e non prima
 * come gli altri: le colonne che riempie e' la DDL ad aggiungerle.
 *
 * La 10 porta due colonne sulle righe d'ordine — `unit_cost_at_sale` e
 * `unit_cost_frozen_at` — e con loro la fine di un effetto che nessuno aveva
 * chiesto: il costo si legge dai prodotti nel momento in cui si guarda, quindi
 * correggere un costo oggi riscriveva il profitto di sei mesi fa. Numeri gia'
 * letti, gia' esportati, gia' usati per decidere, che cambiavano da soli.
 *
 * Nessun passo esplicito in MERCHANT_MIGRATIONS, e stavolta l'assenza e' il
 * punto: le due colonne devono restare VUOTE sullo storico. Riempirle
 * significherebbe dichiarare un costo storico che non esiste — Shopify
 * conserva solo il costo attuale, quello di allora non e' ricostruibile da
 * nessuna parte. Vuote vogliono dire "per questa riga il costo non e' stato
 * fissato", che e' vero, e il comportamento resta quello di prima finche' il
 * merchant non decide diversamente.
 *
 * La 11 non porta niente di nuovo: ripara. La 10 aveva lasciato passare un
 * caso che non doveva esistere — una riga con la data del congelamento e
 * nessun costo dentro, cioe' un'assenza dichiarata definitiva. Nasceva dal
 * primo inserimento di un costo su un prodotto gia' venduto, che e'
 * precisamente cio' che la tab Prodotti chiede di fare, e toglieva quelle
 * vendite dal profitto del cliente per sempre. Il passo rimette a NULL la data
 * dove un valore fissato non c'e': solo li', perche' e' l'unica combinazione
 * che non puo' voler dire niente di sensato.
 *
 * La 12 porta sugli ordini i dati di spedizione — stato di evasione, paese,
 * peso, articoli, data del reso, imballo — e il costo logistico gia' calcolato.
 * Solo aggiunte, quindi nessun passo esplicito: le porta la DDL. Nemmeno un
 * riempimento dello storico: restano NULL finche' l'ordine non viene riscritto
 * dalla sincronizzazione o dal ricalcolo. Chi li legge deve trattare NULL come
 * zero: e' il profitto di prima, non un ordine senza profitto.
 *
 * La 13 porta sugli ordini `shipping_method`, l'opzione di spedizione scelta
 * dal cliente: il costo si prende da quell'opzione, non piu' solo dalla zona.
 * Una colonna aggiunta, quindi di nuovo nessun passo esplicito. Lo storico
 * resta NULL finche' l'ordine non viene riscritto, e un ordine senza opzione
 * usa la tariffa generica della zona: il costo di prima, non uno zero.
 *
 * La 14 porta sugli ordini `package_count`, i pacchi spediti (spedizioni
 * partite davvero), per il costo per pacco. Ancora solo una colonna: nessun passo
 * esplicito. Lo storico lo completa il recupero da Shopify che
 * l'aggiornamento accoda (apply-schema-update), e intanto un ordine spedito
 * senza conteggio paga un pacco.
 */
export const LATEST_SCHEMA_VERSION = 14;

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
 * il mancante, poi i passi che quelle colonne nuove le riempiono, infine la
 * ricarica dello schema — senza quella l'API REST del progetto continuerebbe a
 * rispondere con le colonne di prima.
 */
export function buildSchemaUpdateSQL(
  currentVersion: number | null | undefined,
  includeCustomers: boolean,
  includeOrders = false,
): string | null {
  if (!needsSchemaUpdate(currentVersion)) return null;

  const pending = pendingMigrations(currentVersion);
  return [
    ...pending.filter((m) => !m.runAfterDDL).map((m) => m.sql),
    buildMerchantSchemaSQL(includeCustomers, includeOrders),
    ...pending.filter((m) => m.runAfterDDL).map((m) => m.sql),
    RELOAD_SCHEMA_SQL,
  ].join('\n');
}
