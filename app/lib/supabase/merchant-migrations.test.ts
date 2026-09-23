import { describe, it, expect } from 'vitest';
import {
  MERCHANT_MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  needsSchemaUpdate,
  pendingMigrations,
  buildSchemaUpdateSQL,
} from './merchant-migrations';

describe('needsSchemaUpdate', () => {
  it('i collegamenti anteriori al meccanismo sono da aggiornare', () => {
    expect(needsSchemaUpdate(0)).toBe(true);
    expect(needsSchemaUpdate(null)).toBe(true);
    expect(needsSchemaUpdate(undefined)).toBe(true);
  });

  it('chi e’ alla versione corrente non ha nulla da fare', () => {
    expect(needsSchemaUpdate(LATEST_SCHEMA_VERSION)).toBe(false);
    expect(needsSchemaUpdate(LATEST_SCHEMA_VERSION + 1)).toBe(false);
  });
});

describe('pendingMigrations', () => {
  it('solo i passi non ancora applicati, in ordine', () => {
    const pending = pendingMigrations(0);
    expect(pending.map((m) => m.version)).toEqual(
      MERCHANT_MIGRATIONS.map((m) => m.version).sort((a, b) => a - b),
    );
  });

  it('chi e’ gia’ aggiornato non ripete nulla', () => {
    expect(pendingMigrations(LATEST_SCHEMA_VERSION)).toEqual([]);
  });

  it('le versioni sono uniche e non superano quella corrente', () => {
    const versions = MERCHANT_MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    versions.forEach((v) => expect(v).toBeLessThanOrEqual(LATEST_SCHEMA_VERSION));
  });
});

describe('buildSchemaUpdateSQL', () => {
  it('niente da fare → niente SQL', () => {
    expect(buildSchemaUpdateSQL(LATEST_SCHEMA_VERSION, true)).toBeNull();
  });

  it('parte dai passi espliciti, poi allinea le colonne, poi ricarica lo schema', () => {
    const sql = buildSchemaUpdateSQL(0, true)!;
    // La rinomina deve venire PRIMA della DDL additiva: al contrario si
    // ritroverebbe una email_address vuota accanto alla email popolata.
    const rename = sql.indexOf('RENAME COLUMN email TO email_address');
    const addColumn = sql.indexOf('ADD COLUMN IF NOT EXISTS email_address');
    const reload = sql.indexOf("NOTIFY pgrst, 'reload schema'");
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(addColumn).toBeGreaterThan(rename);
    // Senza la ricarica finale l'API REST continuerebbe con le colonne di prima.
    expect(reload).toBeGreaterThan(addColumn);
  });

  it('senza clienti nel piano non tocca la loro tabella', () => {
    const sql = buildSchemaUpdateSQL(0, false)!;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS products');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS customers');
  });

  it('gli indici rinominati non lasciano doppioni', () => {
    // Un indice che conserva il nome vecchio verrebbe ricreato dalla DDL con
    // quello nuovo: due indici identici sulla stessa colonna.
    const sql = buildSchemaUpdateSQL(0, true)!;
    expect(sql).toContain('ALTER INDEX IF EXISTS idx_customers_email RENAME TO');
  });
});

describe('numero di versione e cio che promette', () => {
  it('salta la 3, che e bruciata', () => {
    // La 3 e' stata pubblicata quando le tabelle degli ordini esistevano nel
    // codice ma la DDL non le creava: i progetti aggiornati in quei giorni si
    // sono presi il numero senza ricevere niente. Riusarla li lascerebbe senza
    // tabelle e senza modo di accorgersene.
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    expect(LATEST_SCHEMA_VERSION).not.toBe(3);
  });

  it('la 12 porta sugli ordini i dati di spedizione', () => {
    // Solo colonne aggiunte: basta alzare il numero, la DDL additiva fa il resto.
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
  });

  it('l aggiornamento porta le colonne dell indirizzo del cliente', () => {
    // Sono aggiunte, quindi non hanno un passo esplicito: le porta la DDL
    // idempotente, che pero' viaggia solo se il numero di versione e' salito.
    const sql = buildSchemaUpdateSQL(4, true, true);
    for (const column of ['country', 'address', 'zipcode', 'region', 'external_id', 'date_of_birth']) {
      expect(sql).toContain(column);
    }
  });

  it('quando gli ordini si accendono, l aggiornamento se li porta', () => {
    const sql = buildSchemaUpdateSQL(1, true, true);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS orders');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS order_lines');
  });

  it('senza ordini l aggiornamento non crea tabelle che nessuno riempira', () => {
    const sql = buildSchemaUpdateSQL(1, true);
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS orders');
  });
});

describe('formato dei campi che le piattaforme confrontano', () => {
  it('l aggiornamento porta la conversione della data di nascita', () => {
    // Un DATE non puo' contenere "19850423": il tipo va cambiato prima che
    // qualcuno cominci a scriverci.
    const sql = buildSchemaUpdateSQL(5, true, true);
    expect(sql).toContain('date_of_birth TYPE TEXT');
  });

  it('l aggiornamento ripulisce i telefoni gia sincronizzati', () => {
    // Senza, i clienti piu' vecchi resterebbero nella forma leggibile di
    // Shopify e fuori dai pubblici — e sono quelli che contano di piu'.
    const sql = buildSchemaUpdateSQL(5, true, true);
    expect(sql).toContain('regexp_replace');
    expect(sql).toContain('phone_number');
  });

  it('chi e gia alla versione corrente non riceve altri passi', () => {
    expect(pendingMigrations(LATEST_SCHEMA_VERSION)).toEqual([]);
  });
});

/**
 * Il passo che riempie le colonne nuove sulle righe d'ordine.
 *
 * E' l'unico passo che non aggiunge niente allo schema, e senza di lui
 * l'aggiornamento sarebbe un disastro silenzioso: il conto nuovo e'
 * `line_net_total - costo * current_quantity`, e su una riga storica quei due
 * valori sarebbero NULL e zero. Non profitto sbagliato di poco — profitto
 * azzerato, su tutto lo storico, il giorno dell'aggiornamento.
 */
describe('lo storico delle righe d ordine', () => {
  it('il passo gira DOPO la DDL, perche riempie colonne che la DDL aggiunge', () => {
    // Prima della DDL quelle colonne non esistono ancora, e l'UPDATE
    // fallirebbe portandosi dietro l'intero aggiornamento.
    const sql = buildSchemaUpdateSQL(8, true, true)!;
    expect(sql.indexOf('ADD COLUMN IF NOT EXISTS line_net_total')).toBeLessThan(
      sql.indexOf('SET line_net_total = ROUND'),
    );
  });

  it('riempie la quantita corrente con quella ordinata', () => {
    const sql = buildSchemaUpdateSQL(8, true, true)!;
    expect(sql).toContain('SET current_quantity = COALESCE(quantity, 0)');
  });

  it('quel che scrive e il VECCHIO conto, cioe i numeri di ieri', () => {
    // Provvisorio e dichiarato tale: non corregge i rimborsi — quel dato sta su
    // Shopify e non qui — ma non regala nemmeno un crollo a zero, che sarebbe
    // piu' falso di cio' che sostituisce.
    const sql = buildSchemaUpdateSQL(8, true, true)!;
    expect(sql).toContain('SET line_net_total = ROUND(unit_price * COALESCE(quantity, 0), 2)');
  });

  it('non calpesta le righe gia rilette da Shopify', () => {
    // Un merchant a meta' rilettura che ricevesse di nuovo questo SQL non deve
    // tornare indietro: si tocca solo cio' che e' ancora vuoto.
    const sql = buildSchemaUpdateSQL(8, true, true)!;
    expect(sql).toContain('WHERE line_net_total IS NULL');
  });

  it('non prova a toccare una tabella che quel negozio non ha', () => {
    // Gli ordini si sincronizzano solo per chi ha concesso il permesso: per gli
    // altri `order_lines` non esiste, e un UPDATE nudo farebbe fallire tutto
    // l'aggiornamento, colonne dei clienti comprese.
    const sql = buildSchemaUpdateSQL(8, true, true)!;
    expect(sql).toContain("to_regclass('public.order_lines') IS NULL");
  });

  it('la valuta di riga si prende dall ordine, che e l unica fonte che c e', () => {
    const sql = buildSchemaUpdateSQL(8, true, true)!;
    expect(sql).toContain('SET line_currency = o.currency');
  });
});

describe('la versione 7 porta i browser conosciuti', () => {
  it('chi si era collegato prima riceve la tabella users', () => {
    // Senza il numero alzato, la DDL idempotente non viaggerebbe e i progetti
    // gia' collegati resterebbero senza la tabella: il riconoscimento del
    // visitatore non partirebbe mai per nessuno di loro.
    const sql = buildSchemaUpdateSQL(6, true, true);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(sql).toContain('merged_into');
  });

  it('la porta anche a un piano che non sincronizza i clienti', () => {
    const sql = buildSchemaUpdateSQL(6, false);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS customers');
  });
});

describe('la versione 8 completa l anagrafica del cliente', () => {
  it('chi si era collegato prima riceve le cinque colonne nuove', () => {
    // Sono aggiunte pure, quindi non hanno un passo esplicito: le porta la DDL
    // idempotente, che pero' viaggia solo se il numero di versione e' salito.
    // Senza, le vedrebbero solo i negozi che si collegano da adesso in poi.
    const sql = buildSchemaUpdateSQL(7, true, true)!;
    for (const column of ['city', 'country_code', 'total_profit', 'fb_login_id', 'google_login_id']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column} `);
    }
  });

  it('nessun passo esplicito: cinque ADD COLUMN sarebbero un doppione', () => {
    // I passi di MERCHANT_MIGRATIONS servono a cio' che una DDL additiva non
    // sa fare — rinominare, cambiare tipo, spostare dati. Qui non c'e' niente
    // del genere, e un passo con dentro le stesse ADD COLUMN sarebbe solo una
    // copia da tenere allineata a mano.
    expect(MERCHANT_MIGRATIONS.some((m) => m.version === 8)).toBe(false);
  });

  it('su chi si era aggiunto city a mano non cambia niente', () => {
    // ADD COLUMN IF NOT EXISTS su una colonna TEXT gia' presente e' un'operazione
    // a vuoto: la colonna resta com'e', coi dati dentro.
    const sql = buildSchemaUpdateSQL(7, true)!;
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS city TEXT');
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/ALTER COLUMN city/i);
  });
});

/**
 * La riparazione delle righe che il bug aveva gia' rovinato.
 *
 * Inserendo per la prima volta il costo di un prodotto gia' venduto, l'app
 * congelava sul passato il costo di prima — che non c'era. Restava una riga
 * senza valore ma con la data del congelamento sopra: per il calcolo del
 * profitto vuol dire "conto chiuso", e nessun costo inserito dopo poteva piu'
 * farla rientrare. Il codice non lo fa piu', ma le righe gia' marcate
 * resterebbero invisibili per sempre: vanno sbloccate dove sono.
 */
describe('la versione 11 sblocca le assenze di costo congelate', () => {
  it('rimette a NULL la data dove un valore fissato non c e', () => {
    const sql = buildSchemaUpdateSQL(10, true, true)!;
    expect(sql).toContain('SET unit_cost_frozen_at = NULL');
    expect(sql).toContain('WHERE unit_cost_at_sale IS NULL');
    expect(sql).toContain('AND unit_cost_frozen_at IS NOT NULL');
  });

  it('non tocca le righe con un costo fissato davvero', () => {
    // Quelle conservano un passato vero — ho comprato a 3, adesso compro a 5 —
    // ed e' l'unica cosa che il congelamento serve a proteggere. La condizione
    // le esclude: senza `unit_cost_at_sale IS NULL` la riparazione diventerebbe
    // la cancellazione di cio' che il merchant aveva scelto di conservare.
    const passo = MERCHANT_MIGRATIONS.find((m) => m.version === 11)!;
    expect(passo.sql).toMatch(
      /SET unit_cost_frozen_at = NULL\s+WHERE unit_cost_at_sale IS NULL/,
    );
  });

  it('gira DOPO la DDL, perche le due colonne sono della 10', () => {
    // Un progetto che salta dalla 9 alla 11 le riceve dalla DDL di questo
    // stesso giro: prima di lei non esistono, e l'UPDATE farebbe fallire
    // l'intero aggiornamento.
    const passo = MERCHANT_MIGRATIONS.find((m) => m.version === 11)!;
    expect(passo.runAfterDDL).toBe(true);

    const sql = buildSchemaUpdateSQL(9, true, true)!;
    expect(sql.indexOf('ADD COLUMN IF NOT EXISTS unit_cost_frozen_at')).toBeLessThan(
      sql.indexOf('SET unit_cost_frozen_at = NULL'),
    );
  });

  it('non prova a riparare quel che quel negozio non ha', () => {
    // Senza permesso sugli ordini `order_lines` non esiste, e le due colonne
    // possono mancare anche a tabella presente (permesso ritirato dopo). Un
    // UPDATE nudo farebbe fallire tutto l'aggiornamento, clienti compresi.
    const passo = MERCHANT_MIGRATIONS.find((m) => m.version === 11)!;
    expect(passo.sql).toContain("to_regclass('public.order_lines') IS NULL");
    expect(passo.sql).toContain("column_name = 'unit_cost_frozen_at'");
  });

  it('chi era gia alla 10 lo riceve, e riceverlo due volte non fa niente', () => {
    // La combinazione riparata non si ricrea piu', quindi una seconda
    // esecuzione non trova righe: e' una tantum per davvero.
    expect(pendingMigrations(10).map((m) => m.version)).toEqual([11]);
    expect(pendingMigrations(11)).toEqual([]);
  });
});
