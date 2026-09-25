import { describe, it, expect } from 'vitest';
import {
  PRODUCTS_TABLE_SQL,
  CUSTOMERS_TABLE_SQL,
  MERCHANT_TABLES_SQL,
  buildMerchantSchemaSQL,
  buildOrdersSchemaSQL,
  buildUsersSchemaSQL,
} from './supabase-schema';

describe('supabase-schema', () => {
  it('MERCHANT_TABLES_SQL è la concatenazione di PRODUCTS + CUSTOMERS', () => {
    expect(MERCHANT_TABLES_SQL).toBe(PRODUCTS_TABLE_SQL + CUSTOMERS_TABLE_SQL);
  });

  it('il DDL products crea la tabella products con cost_per_item', () => {
    expect(PRODUCTS_TABLE_SQL).toContain('CREATE TABLE IF NOT EXISTS products');
    expect(PRODUCTS_TABLE_SQL).toContain('cost_per_item');
  });

  it('il DDL customers crea la tabella customers con shopify_customer_id', () => {
    expect(CUSTOMERS_TABLE_SQL).toContain('CREATE TABLE IF NOT EXISTS customers');
    expect(CUSTOMERS_TABLE_SQL).toContain('shopify_customer_id');
  });

  it('allinea gli schemi datati con ADD COLUMN IF NOT EXISTS senza DROP', () => {
    // Aggiorna colonne nuove su tabelle pre-esistenti senza toccare i dati.
    expect(PRODUCTS_TABLE_SQL).toContain(
      'ADD COLUMN IF NOT EXISTS cost_per_item',
    );
    expect(PRODUCTS_TABLE_SQL).toContain(
      'ADD COLUMN IF NOT EXISTS inventory_tracked',
    );
    // La PK non viene mai ri-aggiunta e non ci sono operazioni distruttive.
    expect(PRODUCTS_TABLE_SQL).not.toContain('ADD COLUMN IF NOT EXISTS id ');
    expect(PRODUCTS_TABLE_SQL).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });

  it('buildMerchantSchemaSQL include customers solo se il piano lo abilita', () => {
    const withCustomers = buildMerchantSchemaSQL(true);
    const withoutCustomers = buildMerchantSchemaSQL(false);
    expect(withCustomers).toContain('CREATE TABLE IF NOT EXISTS customers');
    expect(withoutCustomers).toContain('CREATE TABLE IF NOT EXISTS products');
    expect(withoutCustomers).not.toContain('CREATE TABLE IF NOT EXISTS customers');
  });
});

/**
 * Le colonne dei clienti che non arrivano dall'anagrafica di Shopify, piu' la
 * citta' che ci arrivava e non veniva scritta da nessuna parte.
 */
describe('colonne dei clienti', () => {
  it('la citta e una colonna, non un dato che si legge e si butta', () => {
    // Shopify la manda in ogni payload dell'indirizzo predefinito: era l'unico
    // pezzo dell'indirizzo a non arrivare dall'altra parte.
    expect(CUSTOMERS_TABLE_SQL).toContain('city TEXT');
    expect(CUSTOMERS_TABLE_SQL).toContain('ADD COLUMN IF NOT EXISTS city TEXT');
  });

  it('la sigla del paese sta ACCANTO al nome esteso, non al suo posto', () => {
    // Le piattaforme pubblicitarie confrontano `IT`, chi apre la tabella si
    // aspetta `Italy`: tenerne una sola vorrebbe dire dedurre l'altra da un
    // elenco di nazioni scritto a mano.
    expect(CUSTOMERS_TABLE_SQL).toContain('country TEXT');
    expect(CUSTOMERS_TABLE_SQL).toContain('country_code TEXT');
  });

  it('il profitto ha la colonna ma non il valore', () => {
    // Si calcola in SQL sugli ordini al momento della lettura: scriverlo qui
    // congelerebbe un numero che cambia da solo ogni volta che un costo viene
    // compilato.
    expect(CUSTOMERS_TABLE_SQL).toContain('total_profit NUMERIC(10, 2)');
  });

  it('i login di Meta e Google hanno il posto pronto prima del login', () => {
    // Restano vuoti finche' non ci sara' l'accesso con le due piattaforme: la
    // colonna c'e' per non dover fare una migrazione per due campi.
    expect(CUSTOMERS_TABLE_SQL).toContain('fb_login_id TEXT');
    expect(CUSTOMERS_TABLE_SQL).toContain('google_login_id TEXT');
  });

  it('arrivano anche su una tabella gia esistente, senza toccare i dati', () => {
    // Sono aggiunte pure: la DDL additiva basta, e su chi si era gia' aggiunto
    // `city` a mano la ADD COLUMN IF NOT EXISTS non fa niente.
    for (const column of ['city', 'country_code', 'total_profit', 'fb_login_id', 'google_login_id']) {
      expect(CUSTOMERS_TABLE_SQL).toContain(`ADD COLUMN IF NOT EXISTS ${column} `);
    }
    expect(CUSTOMERS_TABLE_SQL).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});

describe('tabelle degli ordini', () => {
  const sql = buildOrdersSchemaSQL();

  it('crea ordini e righe senza toccare quel che c e', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS orders');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS order_lines');
    expect(sql).not.toContain('DROP');
  });

  it('il costo corrente non sta nelle righe: si legge dai prodotti quando serve', () => {
    // E' la ragione per cui compilare un costo oggi aggiorna anche il profitto
    // di ieri: la riga d'ordine non porta un costo suo, lo va a prendere dal
    // prodotto nel momento in cui si guarda.
    expect(sql).not.toContain('cost_per_item');
    expect(sql).toContain('shopify_variant_id');
  });

  it('c e pero il posto per fermarlo, e resta vuoto finche nessuno lo chiede', () => {
    // Le due colonne non sono una copia del costo corrente: si riempiono solo
    // quando il merchant, cambiando un costo, dice che gli ordini gia'
    // registrati non devono seguirlo. Vuote vogliono dire "per questa riga il
    // costo non e' stato fissato", ed e' cosi' che nascono tutte: il costo del
    // giorno della vendita non lo conserva nessuno, Shopify compreso, e
    // riempirle all'indietro sarebbe inventarlo.
    expect(sql).toContain('unit_cost_at_sale');
    expect(sql).toContain('unit_cost_frozen_at');
    expect(sql).not.toContain('unit_cost_at_sale NUMERIC(10, 2) NOT NULL');
  });

  it('degli ordini non si prende un dato personale in piu del necessario', () => {
    // Nome e cognome servono a dire di chi si parla; indirizzi, telefoni ed
    // email no.
    expect(sql).toContain('customer_first_name');
    expect(sql).not.toContain('address');
    expect(sql).not.toContain('phone');
    expect(sql).not.toMatch(/\bemail\b/);
  });

  it('RLS accesa su entrambe, come per le altre tabelle', () => {
    expect(sql.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(2);
  });

  it('la riga porta i due valori su cui si fa il margine', () => {
    // `current_quantity` e `line_net_total` sono i due campi canonici: quanto
    // e' rimasto al cliente e quanto e' entrato in cassa. Senza di loro il conto
    // tornava a moltiplicare la quantita' ORDINATA per un prezzo unitario con
    // dentro sconti riferiti anche a unita' rimborsate.
    expect(sql).toContain('current_quantity INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('line_net_total NUMERIC(12, 2)');
    expect(sql).toContain('line_currency TEXT');
    expect(sql).toContain('source_updated_at TIMESTAMP');
  });

  it('le colonne nuove arrivano anche ai database gia esistenti', () => {
    // La DDL e' additiva: senza queste ALTER, le colonne le avrebbero solo i
    // progetti collegati da oggi in poi.
    for (const column of [
      'current_quantity',
      'line_net_total',
      'line_currency',
      'source_updated_at',
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column} `);
    }
  });

  it('la quantita corrente non puo essere NULL, e non e pignoleria', () => {
    // Una colonna NULL entrerebbe nella formula facendo sparire in silenzio il
    // contributo della riga: il default a zero la rende scritta, non assente,
    // e a rimettere i valori veri ci pensa la migrazione.
    expect(sql).toContain('current_quantity INTEGER NOT NULL DEFAULT 0');
  });

  it('il netto di riga tiene piu cifre degli altri importi', () => {
    // E' un TOTALE, non un prezzo unitario: una riga d'ingrosso da mille pezzi
    // supera il tetto di otto cifre intere che gli altri campi si permettono.
    expect(sql).toContain('line_net_total NUMERIC(12, 2)');
    expect(sql).not.toContain('line_net_total NUMERIC(10, 2)');
  });
});

describe('ordini: i dati di spedizione', () => {
  const sql = buildOrdersSchemaSQL();

  it('le sette colonne arrivano anche ai database gia esistenti', () => {
    for (const column of [
      'fulfillment_status TEXT',
      'shipping_country_code TEXT',
      'total_weight_grams INTEGER',
      'item_count INTEGER',
      'returned_at TIMESTAMP',
      'packaging_category TEXT',
      'logistics_cost NUMERIC(10, 2)',
      'shipping_method TEXT',
      'package_count INTEGER',
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
  });
});

describe('buildMerchantSchemaSQL', () => {
  it('gli ordini si creano solo quando li si potra riempire', () => {
    expect(buildMerchantSchemaSQL(true)).not.toContain('CREATE TABLE IF NOT EXISTS orders');
    expect(buildMerchantSchemaSQL(true, true)).toContain('CREATE TABLE IF NOT EXISTS orders');
  });
});

/**
 * La tabella dei browser conosciuti.
 *
 * Una riga per BROWSER, non per persona: chi compra dal telefono, dal tablet e
 * dal portatile ha tre righe qui e una sola in `customers`.
 */
describe('tabella users', () => {
  const sql = buildUsersSchemaSQL();

  it('la chiave e l identificativo stesso, non un numero inventato', () => {
    // Arriva dal browser in ogni richiesta: averlo come chiave vuol dire che il
    // ritorno e' un upsert su una chiave che il chiamante conosce gia'.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(sql).toContain('external_id TEXT PRIMARY KEY');
  });

  it('browser e dispositivo sono COLONNE, non pezzi dell identificativo', () => {
    // Il dispositivo e' una supposizione (iPadOS si dichiara Macintosh) e
    // l'identificativo e' per sempre: una supposizione sbagliata dentro l id
    // non si corregge piu', in una colonna si riscrive alla visita dopo.
    expect(sql).toContain('browser TEXT');
    expect(sql).toContain('device_type TEXT');
  });

  it('la prima comparsa ha un DEFAULT, perche non viaggia mai nel corpo', () => {
    // E' cio' che permette all upsert del ritorno di non riscriverla.
    expect(sql).toContain('first_seen_at TIMESTAMP DEFAULT NOW()');
    expect(sql).toContain('last_seen_at TIMESTAMP DEFAULT NOW()');
  });

  it('merged_into c e, perche una riga unita non si cancella', () => {
    // Gli eventi gia' partiti sotto quell identificativo vivono dentro Meta e
    // GA4: cancellare la riga li lascerebbe orfani per sempre.
    expect(sql).toContain('merged_into TEXT');
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });

  it('un indice per i browser di un cliente e uno per la potatura', () => {
    expect(sql).toContain('idx_users_customer');
    expect(sql).toContain('idx_users_anonymous_last_seen');
  });

  it('si allinea anche su una tabella gia esistente', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS shopify_customer_id');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS merged_into');
    // La chiave primaria non si ri-aggiunge mai.
    expect(sql).not.toContain('ADD COLUMN IF NOT EXISTS external_id ');
  });

  it('non dipende ne dal piano ne dai permessi', () => {
    // E' l'unica tabella che, se non la si tiene da subito, non si puo'
    // ricostruire dopo: gli eventi passati sotto un identificativo mai scritto
    // non tornano.
    expect(buildMerchantSchemaSQL(false)).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(buildMerchantSchemaSQL(true, true)).toContain('CREATE TABLE IF NOT EXISTS users');
  });
});
