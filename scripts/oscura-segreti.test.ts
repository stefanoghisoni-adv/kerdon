import { describe, it, expect } from 'vitest';
import { oscura, pezziDaOscurare } from './oscura-segreti';

/**
 * Il registro di una migrazione si conserva fuori dal log di GitHub (artifact e
 * riepilogo del run), dove nessuno oscura niente per noi: qui si prova che
 * password, host e riferimento del progetto non ci arrivano.
 */

const DIRETTO = 'postgresql://postgres:S3greta%2Fvera@db.abcdefghijklmnop.supabase.co:5432/postgres?schema=public';
const POOLER = 'postgresql://postgres.abcdefghijklmnop:S3greta%2Fvera@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';

describe('oscura', () => {
  it('toglie l\'host dalla riga che stampa Prisma', () => {
    const riga = 'Datasource "db": PostgreSQL database "postgres", schema "public" at "db.abcdefghijklmnop.supabase.co:5432"';
    const pulita = oscura(riga, pezziDaOscurare(DIRETTO));
    expect(pulita).not.toContain('abcdefghijklmnop');
    expect(pulita).toContain('PostgreSQL database "postgres"');
  });

  it('toglie la password, anche decodificata', () => {
    const pezzi = pezziDaOscurare(DIRETTO);
    expect(oscura('password S3greta/vera e S3greta%2Fvera', pezzi)).toBe('password *** e ***');
  });

  it('toglie l\'indirizzo intero', () => {
    expect(oscura(`errore su ${DIRETTO}`, pezziDaOscurare(DIRETTO))).toBe('errore su ***');
  });

  it('dal pooler toglie l\'utente, che porta il riferimento del progetto', () => {
    const pulita = oscura('utente postgres.abcdefghijklmnop rifiutato', pezziDaOscurare(POOLER));
    expect(pulita).not.toContain('abcdefghijklmnop');
  });

  it('non tocca le parole corte e comuni', () => {
    expect(oscura('postgres 5432 public', pezziDaOscurare(DIRETTO))).toBe('postgres 5432 public');
  });

  it('senza indirizzo non oscura niente', () => {
    expect(pezziDaOscurare(undefined)).toEqual([]);
    expect(oscura('testo', [])).toBe('testo');
  });
});
