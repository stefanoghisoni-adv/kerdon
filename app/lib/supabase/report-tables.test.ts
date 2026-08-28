import { describe, it, expect } from 'vitest';
import {
  CUSTOMERS_REPORT_TABLES,
  existingReportTablesSQL,
  missingReportTables,
  missingReportTablesSQL,
} from './report-tables';

describe('existingReportTablesSQL', () => {
  it('chiede a information_schema tutte le tabelle che la tab legge', () => {
    const sql = existingReportTablesSQL();
    for (const table of CUSTOMERS_REPORT_TABLES) {
      expect(sql).toContain(`'${table}'`);
    }
  });
});

describe('missingReportTablesSQL', () => {
  it('con tutte le tabelle al loro posto non c e niente da fare', () => {
    expect(missingReportTablesSQL([...CUSTOMERS_REPORT_TABLES])).toBeNull();
  });

  // Il caso vero visto in produzione: il collegamento crea gli ordini solo se
  // il negozio aveva gia' concesso di leggerli, e chi concede il permesso dopo
  // resta senza quelle due tabelle. La query le cercava lo stesso.
  it('mancano gli ordini: crea ordini e righe, non il resto', () => {
    const sql = missingReportTablesSQL(['products', 'customers']) ?? '';
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS orders');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS order_lines');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS products');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS customers');
  });

  it('manca solo la tabella dei clienti: crea quella', () => {
    const sql = missingReportTablesSQL(['products', 'orders', 'order_lines']) ?? '';
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS customers');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS orders');
  });

  // Senza, la tabella esiste nel database ma l'API REST — che lavora su una
  // copia in cache dello schema — continuerebbe a non vederla, e la prima
  // sincronizzazione fallirebbe su una tabella che c'e'.
  it('chiude sempre con la ricarica dello schema', () => {
    expect(missingReportTablesSQL([])).toContain('reload schema');
  });
});

describe('missingReportTables', () => {
  it('dice quali mancano, per scriverlo nei log invece di farlo indovinare', () => {
    expect(missingReportTables(['products'])).toEqual(['orders', 'order_lines', 'customers']);
  });
});
