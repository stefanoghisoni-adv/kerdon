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
  { name: 'address', type: 'TEXT' },
  { name: 'zipcode', type: 'TEXT' },
  { name: 'region', type: 'TEXT' },
  // Le due che Shopify non ha come campi propri: restano vuote finche' non si
  // decide da quale metafield leggerle. La colonna c'e' lo stesso, cosi' chi
  // costruisce un pubblico o una integrazione trova il posto gia' pronto e non
  // deve rifare una migrazione per un campo solo.
  { name: 'external_id', type: 'TEXT' },
  // TEXT e non DATE: il formato voluto e' `YYYYMMDD` senza separatori, che e'
  // quello che le piattaforme pubblicitarie confrontano. Un DATE lo
  // restituirebbe sempre come 1985-04-23, e chi legge dovrebbe rifare la
  // conversione ogni volta.
  { name: 'date_of_birth', type: 'TEXT' },
  { name: 'total_spent', type: 'NUMERIC(10, 2)' },
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

export function buildOrdersSchemaSQL(): string {
  return (
    buildTableSQL('orders', ORDERS_COLUMNS, ORDERS_INDEXES) +
    buildTableSQL('order_lines', ORDER_LINES_COLUMNS, ORDER_LINES_INDEXES)
  );
}

/**
 * DDL per le sole tabelle abilitate: `products` sempre, `customers` se il piano
 * include la sincronizzazione clienti, `orders` se il negozio ci ha concesso di
 * leggere gli ordini.
 *
 * Gli ordini non dipendono dal piano ma dal permesso: senza, le tabelle non
 * verrebbero mai riempite, e crearle vuote nel database di qualcuno che non le
 * usera' mai e' spazio occupato per niente.
 */
export function buildMerchantSchemaSQL(
  includeCustomers: boolean,
  includeOrders = false,
): string {
  return (
    buildProductsSchemaSQL() +
    (includeCustomers ? buildCustomersSchemaSQL() : '') +
    (includeOrders ? buildOrdersSchemaSQL() : '')
  );
}

// Compat: costanti pre-generate (usate dal path legacy create-tables e dai test).
export const PRODUCTS_TABLE_SQL = buildProductsSchemaSQL();
export const CUSTOMERS_TABLE_SQL = buildCustomersSchemaSQL();
export const MERCHANT_TABLES_SQL = PRODUCTS_TABLE_SQL + CUSTOMERS_TABLE_SQL;
