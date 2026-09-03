// app/lib/supabase-schema.ts
// DDL idempotente e non distruttivo per le tabelle del merchant.
//
// Ogni tabella viene garantita in tre mosse, tutte sicure sui dati esistenti:
//  1. CREATE TABLE IF NOT EXISTS  → crea la tabella se manca
//  2. ALTER TABLE ADD COLUMN IF NOT EXISTS → allinea gli schemi vecchi aggiungendo
//     SOLO le colonne mancanti (nessun DROP: i dati presenti restano intatti)
//  3. indici + RLS, tutti IF NOT EXISTS / idempotenti
//
// Così un progetto Supabase pre-esistente con tabelle datate viene aggiornato
// alla configurazione corretta senza cancellare nulla.

// Creare o modificare una tabella non basta: le letture e scritture passano
// dall'API REST del progetto, che tiene una copia in cache dello schema. Finche'
// non la ricarica risponde con le colonne di prima — o con "Could not find the
// table ... in the schema cache" per una tabella appena creata.
export const RELOAD_SCHEMA_SQL = "NOTIFY pgrst, 'reload schema';";

interface Column {
  name: string;
  // Tipo base (usato anche nell'ALTER: niente vincoli che romperebbero su righe
  // esistenti, es. NOT NULL/UNIQUE). I default sono inclusi qui apposta.
  type: string;
  // Vincoli aggiuntivi applicati SOLO nel CREATE (tabella nuova, ancora vuota).
  constraints?: string;
}

const PRODUCTS_COLUMNS: Column[] = [
  { name: 'id', type: 'UUID', constraints: 'PRIMARY KEY DEFAULT gen_random_uuid()' },
  { name: 'shopify_product_id', type: 'BIGINT', constraints: 'NOT NULL' },
  { name: 'shopify_variant_id', type: 'BIGINT', constraints: 'UNIQUE' },
  { name: 'is_variant', type: 'BOOLEAN DEFAULT true' },
  { name: 'product_title', type: 'TEXT', constraints: 'NOT NULL' },
  { name: 'product_description', type: 'TEXT' },
  { name: 'vendor', type: 'TEXT' },
  { name: 'product_type', type: 'TEXT' },
  { name: 'handle', type: 'TEXT' },
  { name: 'product_status', type: 'TEXT' },
  { name: 'tags', type: 'TEXT[]' },
  { name: 'product_published_at', type: 'TIMESTAMP' },
  { name: 'variant_title', type: 'TEXT' },
  { name: 'sku', type: 'TEXT' },
  { name: 'barcode', type: 'TEXT' },
  { name: 'price', type: 'NUMERIC(10, 2)', constraints: 'NOT NULL' },
  { name: 'compare_at_price', type: 'NUMERIC(10, 2)' },
  { name: 'cost_per_item', type: 'NUMERIC(10, 2)' },
  { name: 'net_value', type: 'NUMERIC(10, 2)' },
  { name: 'position', type: 'INTEGER' },
  { name: 'inventory_quantity', type: 'INTEGER' },
  { name: 'inventory_tracked', type: 'BOOLEAN' },
  { name: 'inventory_policy', type: 'TEXT' },
  { name: 'weight', type: 'NUMERIC(10, 3)' },
  { name: 'weight_unit', type: 'TEXT' },
  { name: 'requires_shipping', type: 'BOOLEAN' },
  { name: 'taxable', type: 'BOOLEAN' },
  { name: 'image_url', type: 'TEXT' },
  { name: 'option1', type: 'TEXT' },
  { name: 'option2', type: 'TEXT' },
  { name: 'option3', type: 'TEXT' },
  { name: 'created_at', type: 'TIMESTAMP DEFAULT NOW()' },
  { name: 'updated_at', type: 'TIMESTAMP DEFAULT NOW()' },
  { name: 'synced_at', type: 'TIMESTAMP DEFAULT NOW()' },
];

const PRODUCTS_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_variant
  ON products(shopify_variant_id)
  WHERE shopify_variant_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_products_product_id ON products(shopify_product_id);`,
  `CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);`,
  `CREATE INDEX IF NOT EXISTS idx_products_status ON products(product_status);`,
];

const CUSTOMERS_COLUMNS: Column[] = [
  { name: 'id', type: 'UUID', constraints: 'PRIMARY KEY DEFAULT gen_random_uuid()' },
  { name: 'shopify_customer_id', type: 'BIGINT', constraints: 'UNIQUE NOT NULL' },
  // I nomi sono per esteso perche' e' cosi' che li cercano gli strumenti di
  // tracciamento (email_address, phone_number): la colonna si chiama come il
  // dato che il tag va a leggere.
  { name: 'email_address', type: 'TEXT' },
  { name: 'phone_number', type: 'TEXT' },
  { name: 'first_name', type: 'TEXT' },
  { name: 'last_name', type: 'TEXT' },
  { name: 'accepts_marketing', type: 'BOOLEAN' },
  { name: 'marketing_opt_in_level', type: 'TEXT' },
  // L'indirizzo predefinito del cliente, sparso in colonne invece che in un
  // testo solo: gli strumenti di tracciamento chiedono paese e CAP separati, e
  // ricavarli da una stringa unica vorrebbe dire indovinare dove finisce l'uno
  // e comincia l'altro.
  //
  // `region` e non `state`: `customer_state` esiste gia' su questa tabella e
  // vuol dire un'altra cosa — se il cliente e' attivo, invitato o disabilitato.
  // Due colonne con lo stesso nome e significati diversi sono un errore che si
  // scopre tardi.
  { name: 'country', type: 'TEXT' },
  // La sigla ISO a due lettere ACCANTO al nome esteso, non al suo posto: le
  // piattaforme pubblicitarie confrontano `IT`, mentre chi apre la tabella si
  // aspetta di leggere `Italy`. Tenerne una sola costringerebbe a ricavare
  // l'altra, e per farlo servirebbe un elenco di nazioni aggiornato a mano
  // dentro l'app — che prima o poi sbaglia proprio sui paesi meno frequenti.
  { name: 'country_code', type: 'TEXT' },
  { name: 'address', type: 'TEXT' },
  // La citta' arrivava gia' da Shopify e non veniva scritta da nessuna parte:
  // era l'unico pezzo dell'indirizzo che si leggeva e si buttava via.
  { name: 'city', type: 'TEXT' },
  { name: 'zipcode', type: 'TEXT' },
  { name: 'region', type: 'TEXT' },
  // Le colonne che Shopify non ha come campi propri: restano vuote finche' non
  // c'e' da dove leggerle — un metafield da scegliere, o un accesso che ancora
  // non esiste. Ci sono lo stesso, cosi' chi costruisce un pubblico o una
  // integrazione trova il posto gia' pronto e non deve rifare una migrazione
  // per un campo solo.
  { name: 'external_id', type: 'TEXT' },
  // Gli identificativi che Meta e Google danno alla persona quando entra col
  // loro accesso (per Google e' il claim `sub` del token). Restano vuote
  // finche' non ci sara' l'accesso con Meta e Google: oggi quel dato l'app non
  // lo vede mai, e non c'e' niente da cui dedurlo. La colonna c'e' lo stesso
  // per la stessa ragione di `external_id` qui sopra — il posto e' pronto, e
  // il giorno in cui arrivera' il login non servira' una migrazione per due
  // campi.
  { name: 'fb_login_id', type: 'TEXT' },
  { name: 'google_login_id', type: 'TEXT' },
  // TEXT e non DATE: il formato voluto e' `YYYYMMDD` senza separatori, che e'
  // quello che le piattaforme pubblicitarie confrontano. Un DATE lo
  // restituirebbe sempre come 1985-04-23, e chi legge dovrebbe rifare la
  // conversione ogni volta.
  { name: 'date_of_birth', type: 'TEXT' },
  { name: 'total_spent', type: 'NUMERIC(10, 2)' },
  // Il profitto del cliente: la colonna c'e', il valore per ora no, e non e'
  // una dimenticanza. Il profitto nasce dagli ordini e dai costi dei prodotti,
  // e si calcola in SQL al momento della lettura (vedi `customers-query`): e'
  // il motivo per cui compilare un costo oggi corregge il profitto di ieri.
  // Scriverlo qui vorrebbe dire congelare un numero che cambia da solo, e
  // mostrare a chi legge la tabella quello di ieri. Resta vuota finche' non ci
  // sara' un motivo per fissarlo davvero.
  { name: 'total_profit', type: 'NUMERIC(10, 2)' },
  { name: 'orders_count', type: 'INTEGER' },
  { name: 'customer_state', type: 'TEXT' },
  { name: 'tags', type: 'TEXT[]' },
  { name: 'note', type: 'TEXT' },
  { name: 'verified_email', type: 'BOOLEAN' },
  { name: 'tax_exempt', type: 'BOOLEAN' },
  { name: 'created_at', type: 'TIMESTAMP' },
  { name: 'updated_at', type: 'TIMESTAMP' },
  { name: 'synced_at', type: 'TIMESTAMP DEFAULT NOW()' },
];

const CUSTOMERS_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_shopify_id ON customers(shopify_customer_id);`,
  `CREATE INDEX IF NOT EXISTS idx_customers_email_address ON customers(email_address) WHERE email_address IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_customers_phone_number ON customers(phone_number) WHERE phone_number IS NOT NULL;`,
];

// Ordini e loro righe. Servono a una cosa sola: il profitto per cliente.
//
// Cosa NON c'e' dentro, di proposito: indirizzi, telefoni, email, note. Di un
// ordine qui interessano il quando, il chi (per raggruppare) e il cosa (per
// moltiplicare quantita' per margine). Tutto il resto sarebbe dato personale
// raccolto senza motivo.
//
// Il nome e il cognome ci sono perche' l'elenco deve dire di chi si parla, e
// arrivano dall'ordine: sono del merchant, stanno nel suo database, e non
// finiscono nella tabella dei clienti — quella resta di chi ha dato consenso al
// marketing.
const ORDERS_COLUMNS: Column[] = [
  { name: 'id', type: 'UUID', constraints: 'PRIMARY KEY DEFAULT gen_random_uuid()' },
  { name: 'shopify_order_id', type: 'BIGINT', constraints: 'UNIQUE NOT NULL' },
  { name: 'order_number', type: 'TEXT' },
  // null = ordine senza account cliente (acquisto come ospite): resta fuori
  // dagli elenchi per cliente, ma non si butta — vive nei totali del negozio.
  { name: 'shopify_customer_id', type: 'BIGINT' },
  { name: 'customer_first_name', type: 'TEXT' },
  { name: 'customer_last_name', type: 'TEXT' },
  { name: 'currency', type: 'TEXT' },
  { name: 'total_price', type: 'NUMERIC(10, 2)' },
  { name: 'financial_status', type: 'TEXT' },
  // Un ordine annullato o rimborsato non e' profitto: la colonna c'e' perche'
  // il conto possa lasciarlo fuori invece di far finta che sia andato bene.
  { name: 'cancelled_at', type: 'TIMESTAMP' },
  { name: 'placed_at', type: 'TIMESTAMP' },
  { name: 'updated_at', type: 'TIMESTAMP' },
  { name: 'synced_at', type: 'TIMESTAMP DEFAULT NOW()' },
];

const ORDERS_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_shopify_id ON orders(shopify_order_id);`,
  // I due modi in cui questa tabella viene interrogata: per cliente, e per
  // periodo. Senza, ogni apertura della tab leggerebbe tutto.
  `CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(shopify_customer_id) WHERE shopify_customer_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_orders_placed_at ON orders(placed_at);`,
];

// Le righe: quanto e' stato pagato e per cosa. Il costo NON sta qui — si legge
// dai prodotti quando serve, ed e' il motivo per cui compilare un costo oggi
// aggiorna il profitto di ieri.
const ORDER_LINES_COLUMNS: Column[] = [
  { name: 'id', type: 'UUID', constraints: 'PRIMARY KEY DEFAULT gen_random_uuid()' },
  { name: 'shopify_line_id', type: 'BIGINT', constraints: 'UNIQUE NOT NULL' },
  { name: 'shopify_order_id', type: 'BIGINT', constraints: 'NOT NULL' },
  { name: 'shopify_product_id', type: 'BIGINT' },
  // E' la chiave con cui si arriva al costo: una riga senza variante resta
  // fuori dal conto, e la tab lo dichiara invece di stimare.
  { name: 'shopify_variant_id', type: 'BIGINT' },
  { name: 'title', type: 'TEXT' },
  { name: 'quantity', type: 'INTEGER' },
  // Prezzo unitario davvero pagato, sconti di riga gia' tolti: il margine si fa
  // su quello che e' entrato in cassa, non sul listino.
  { name: 'unit_price', type: 'NUMERIC(10, 2)' },
  { name: 'total_discount', type: 'NUMERIC(10, 2)' },
  { name: 'synced_at', type: 'TIMESTAMP DEFAULT NOW()' },
];

const ORDER_LINES_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_order_lines_shopify_id ON order_lines(shopify_line_id);`,
  `CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(shopify_order_id);`,
  `CREATE INDEX IF NOT EXISTS idx_order_lines_variant ON order_lines(shopify_variant_id) WHERE shopify_variant_id IS NOT NULL;`,
];

// I browser che hanno visitato il negozio. UNA RIGA PER BROWSER, non per
// persona: chi compra dal telefono, dal tablet e dal portatile ha tre righe qui
// e una sola in `customers`. Non e' duplicazione, e' una relazione — l'insieme
// delle righe con lo stesso `shopify_customer_id` E' l'elenco dei suoi browser,
// ed e' l'unico posto dove quell'elenco esiste.
//
// Da qui non si sposta e non si cancella niente quando il visitatore diventa
// cliente: si riempie `shopify_customer_id` e basta. Spostarlo in `customers`
// sarebbe impossibile e sbagliato insieme — impossibile perche' li'
// `shopify_customer_id` e' UNIQUE NOT NULL e un browser anonimo non ci puo'
// entrare, sbagliato perche' cancellare le righe svuoterebbe l'elenco dei
// browser proprio per i clienti, che sono gli unici per cui serve: al ritorno
// quel browser risulterebbe di nuovo di uno sconosciuto.
const USERS_COLUMNS: Column[] = [
  // La chiave primaria e' l'identificativo stesso, non un UUID generato: e' gia'
  // unico per costruzione (32 caratteri casuali), arriva dal browser in ogni
  // richiesta, e averlo come PK vuol dire che l'aggiornamento al ritorno e' un
  // upsert su una chiave che il chiamante conosce gia' — senza prima cercare la
  // riga per sapere quale numero le era stato dato.
  { name: 'external_id', type: 'TEXT', constraints: 'PRIMARY KEY' },
  // NULL finche' non si sa chi sia. Riempirlo e' tutto cio' che succede quando
  // la persona si identifica o compra: nessuna riga nasce, nessuna muore.
  { name: 'shopify_customer_id', type: 'BIGINT' },
  // COLONNE, non pezzi dell'identificativo. Metterli dentro l'id era la
  // proposta iniziale e sarebbe stato un errore senza rimedio: il dispositivo
  // e' una SUPPOSIZIONE (iPadOS si dichiara Macintosh, un browser dentro
  // un'app si dichiara quel che gli pare) mentre l'identificativo e' per
  // sempre. Una supposizione sbagliata dentro l'id non si corregge piu'; in una
  // colonna si riscrive alla visita dopo.
  //
  // Restano vuote se il container non le manda: sono un di piu' per segmentare,
  // mai una condizione per riconoscere qualcuno.
  { name: 'browser', type: 'TEXT' },
  { name: 'device_type', type: 'TEXT' },
  // Il DEFAULT non e' un dettaglio: la scrittura al ritorno non manda
  // `first_seen_at`, cosi' l'upsert la valorizza solo all'inserimento e non la
  // tocca mai piu'. E' il modo in cui la prima comparsa resta la prima comparsa
  // senza dover leggere la riga prima di scriverla.
  { name: 'first_seen_at', type: 'TIMESTAMP DEFAULT NOW()' },
  { name: 'last_seen_at', type: 'TIMESTAMP DEFAULT NOW()' },
  // Quando due browser si rivelano la stessa persona, il piu' recente PUNTA al
  // piu' vecchio invece di essere cancellato. Cancellarlo sembrerebbe pulizia e
  // sarebbe una perdita: gli eventi gia' partiti sotto quell'identificativo
  // esistono dentro Meta e GA4, dove non possiamo entrare, e restare senza la
  // riga qui li lascerebbe orfani per sempre. Vince il piu' vecchio perche' ha
  // la storia piu' lunga alle spalle.
  { name: 'merged_into', type: 'TEXT' },
];

const USERS_INDEXES = [
  // I browser di un cliente: e' la lettura per cui questa tabella esiste. Il
  // parziale tiene fuori gli anonimi, che sono la maggioranza delle righe e non
  // si cercano mai per questa via.
  `CREATE INDEX IF NOT EXISTS idx_users_customer ON users(shopify_customer_id) WHERE shopify_customer_id IS NOT NULL;`,
  // L'esatto contrario, e serve alla potatura: gli anonimi ordinati per
  // ultima visita. Senza, il giro periodico leggerebbe tutta la tabella per
  // trovare le poche righe da togliere.
  `CREATE INDEX IF NOT EXISTS idx_users_anonymous_last_seen ON users(last_seen_at) WHERE shopify_customer_id IS NULL;`,
];

function columnCreateDef(col: Column): string {
  return `${col.name} ${col.type}${col.constraints ? ` ${col.constraints}` : ''}`;
}

function buildTableSQL(
  table: string,
  columns: Column[],
  indexes: string[],
): string {
  const createTable =
    `CREATE TABLE IF NOT EXISTS ${table} (\n  ` +
    columns.map(columnCreateDef).join(',\n  ') +
    `\n);`;

  // ALTER per allineare gli schemi datati: salta la PK (sempre presente) e
  // aggiunge le colonne mancanti col solo tipo base (mai NOT NULL/UNIQUE, che
  // fallirebbero su tabelle già popolate).
  const alters = columns
    .filter((c) => !c.constraints?.includes('PRIMARY KEY'))
    .map((c) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${c.name} ${c.type};`)
    .join('\n');

  const rls = `-- RLS attiva (senza policy pubbliche): la tabella NON è accessibile via Data
-- API con la anon key. L'app scrive/legge con la service_role key, che bypassa RLS.
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`;

  return `\n${createTable}\n\n${alters}\n\n${indexes.join('\n')}\n\n${rls}\n`;
}

export function buildProductsSchemaSQL(): string {
  return buildTableSQL('products', PRODUCTS_COLUMNS, PRODUCTS_INDEXES);
}

export function buildCustomersSchemaSQL(): string {
  return buildTableSQL('customers', CUSTOMERS_COLUMNS, CUSTOMERS_INDEXES);
}

/**
 * La tabella dei browser conosciuti.
 *
 * Non dipende ne' dal piano ne' dai permessi, a differenza di clienti e ordini:
 * il riconoscimento del visitatore e' il primo anello di tutto il resto, e un
 * negozio che non lo tiene da subito non puo' recuperarlo dopo — gli eventi
 * passati sotto un identificativo che non abbiamo mai scritto non tornano.
 */
export function buildUsersSchemaSQL(): string {
  return buildTableSQL('users', USERS_COLUMNS, USERS_INDEXES);
}

export function buildOrdersSchemaSQL(): string {
  return (
    buildTableSQL('orders', ORDERS_COLUMNS, ORDERS_INDEXES) +
    buildTableSQL('order_lines', ORDER_LINES_COLUMNS, ORDER_LINES_INDEXES)
  );
}

/**
 * DDL per le sole tabelle abilitate: `products` e `users` sempre, `customers`
 * se il piano include la sincronizzazione clienti, `orders` se il negozio ci ha
 * concesso di leggere gli ordini.
 *
 * Gli ordini non dipendono dal piano ma dal permesso: senza, le tabelle non
 * verrebbero mai riempite, e crearle vuote nel database di qualcuno che non le
 * usera' mai e' spazio occupato per niente.
 *
 * `users` invece non ha nessuna condizione, per il motivo scritto sopra la sua
 * DDL: e' l'unica tabella che, se non la si tiene da subito, non si puo'
 * ricostruire dopo.
 */
export function buildMerchantSchemaSQL(
  includeCustomers: boolean,
  includeOrders = false,
): string {
  return (
    buildProductsSchemaSQL() +
    buildUsersSchemaSQL() +
    (includeCustomers ? buildCustomersSchemaSQL() : '') +
    (includeOrders ? buildOrdersSchemaSQL() : '')
  );
}

// Compat: costanti pre-generate (usate dal path legacy create-tables e dai test).
export const PRODUCTS_TABLE_SQL = buildProductsSchemaSQL();
export const CUSTOMERS_TABLE_SQL = buildCustomersSchemaSQL();
export const MERCHANT_TABLES_SQL = PRODUCTS_TABLE_SQL + CUSTOMERS_TABLE_SQL;
