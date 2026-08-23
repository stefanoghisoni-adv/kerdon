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
    expect(LATEST_SCHEMA_VERSION).toBe(4);
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
