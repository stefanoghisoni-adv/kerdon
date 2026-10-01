/**
 * Il registro di Prisma (`_prisma_migrations`) e lo schema a cui portano le
 * migrazioni che ci sono scritte: i pezzi che servono sia al cancello sulla
 * deriva (expected-drift.ts) sia alla linea di base (linea-di-base.ts).
 *
 * PERCHE' "LO SCHEMA DELLE MIGRAZIONI" E NON `schema.prisma`. Prima di
 * `migrate deploy` il database e' per definizione INDIETRO rispetto a
 * `schema.prisma`: gli mancano proprio le migrazioni in attesa. Confrontarlo con
 * `schema.prisma` voleva dire fermarsi su ogni migrazione additiva in attesa —
 * una colonna nuova compariva come deriva inattesa e il workflow non arrivava
 * mai ad applicarla. La domanda giusta, prima, e': il database e' quello che le
 * migrazioni GIA' REGISTRATE dicono che sia? Per rispondere Prisma rigioca
 * quelle migrazioni su un database di appoggio vuoto e confronta.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * L'ultima migrazione che la linea di base puo' marcare. Quelle scritte dopo
 * non sono mai passate a mano: le applica solo `migrate deploy`.
 *
 * E' anche il punto in cui `0_init` e' fermo: da qui in poi `0_init` non
 * descrive piu' lo schema finale ma lo schema a questa migrazione, e le
 * migrazioni successive lo portano avanti (vedi prisma/migrations.test.ts).
 */
export const ULTIMA_DELLA_LINEA_DI_BASE = '20260926000000_plans_basic_growth_scale_core';

export const MIGRAZIONI = resolve(process.cwd(), 'prisma/migrations');

/** Le cartelle di migrazione, nell'ordine in cui Prisma le applica. */
export function cartelleMigrazioni(radice = MIGRAZIONI): string[] {
  return readdirSync(radice)
    .filter((nome) => statSync(resolve(radice, nome)).isDirectory())
    .sort();
}

/**
 * Una domanda al database che risponde con una sola parola. Iniettata, cosi' i
 * test la fanno a PGlite e gli script a psql.
 */
export type Esegui = (sql: string) => Promise<string>;

export function psql(url: string): Esegui {
  return async (sql) =>
    execFileSync('psql', [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** Cosa c'e' nel registro di Prisma. `null`: il registro non esiste. */
export interface Registro {
  concluse: string[];
  /** Iniziate e mai concluse, e non annullate: un `migrate deploy` interrotto. */
  fallite: string[];
}

export async function leggiRegistro(esegui: Esegui): Promise<Registro | null> {
  const esiste = await esegui(
    `SELECT CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN 'no' ELSE 'si' END`,
  );
  if (esiste.trim() !== 'si') return null;

  const elenco = async (condizione: string) =>
    (
      await esegui(
        `SELECT coalesce(string_agg("migration_name", ',' ORDER BY "migration_name"), '')
           FROM "_prisma_migrations" WHERE ${condizione}`,
      )
    )
      .trim()
      .split(',')
      .filter((nome) => nome.length > 0);

  return {
    concluse: await elenco(`"finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`),
    fallite: await elenco(`"finished_at" IS NULL AND "rolled_back_at" IS NULL`),
  };
}

/**
 * Le migrazioni che descrivono come il database DOVREBBE essere adesso: quelle
 * concluse nel registro, oppure — se il registro non c'e' ancora o e' vuoto,
 * cioe' prima della linea di base — tutte quelle fino alla linea di base, che e'
 * lo stato a cui il database owner e' stato portato a mano.
 */
export function migrazioniDiRiferimento(cartelle: string[], registro: Registro | null): string[] {
  if (!registro || registro.concluse.length === 0) {
    return cartelle.filter((nome) => nome <= ULTIMA_DELLA_LINEA_DI_BASE);
  }
  const concluse = new Set(registro.concluse);
  return cartelle.filter((nome) => concluse.has(nome));
}

/**
 * Il database di appoggio deve essere locale: Prisma lo SVUOTA prima di
 * rigiocarci sopra le migrazioni. Un indirizzo di produzione messo qui per
 * sbaglio vorrebbe dire cancellare la produzione, quindi non si accetta
 * nient'altro che questa macchina (o il container del job).
 */
export function controllaAppoggio(shadow: string | undefined): string {
  if (!shadow) {
    throw new Error('Manca SHADOW_DATABASE_URL: serve un Postgres vuoto e locale di appoggio.');
  }
  let host = '';
  try {
    host = new URL(shadow).hostname;
  } catch {
    throw new Error('SHADOW_DATABASE_URL non e\' un indirizzo valido.');
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(
      'SHADOW_DATABASE_URL deve puntare a localhost: Prisma svuota quel database prima di usarlo.',
    );
  }
  return shadow;
}

/**
 * Lo script che porterebbe il database allo schema prodotto da `cartelle`, e
 * solo da quelle: si copiano in una cartella temporanea e Prisma le rigioca sul
 * database di appoggio.
 */
export function diffVersoMigrazioni(
  url: string,
  cartelle: string[],
  shadow: string | undefined,
  radice = MIGRAZIONI,
): string {
  const appoggio = controllaAppoggio(shadow);
  const cartella = mkdtempSync(join(tmpdir(), 'kerdon-migrazioni-'));
  try {
    cpSync(join(radice, 'migration_lock.toml'), join(cartella, 'migration_lock.toml'));
    for (const nome of cartelle) cpSync(join(radice, nome), join(cartella, nome), { recursive: true });
    return execFileSync(
      'npx',
      [
        'prisma',
        'migrate',
        'diff',
        '--from-url',
        url,
        '--to-migrations',
        cartella,
        '--shadow-database-url',
        appoggio,
        '--script',
      ],
      // stderr passa: "Loaded Prisma config" finisce li', e mescolarlo allo
      // script lo renderebbe un'istruzione SQL inesistente.
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
  } finally {
    rmSync(cartella, { recursive: true, force: true });
  }
}
