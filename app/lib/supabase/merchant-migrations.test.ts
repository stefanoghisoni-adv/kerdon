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
