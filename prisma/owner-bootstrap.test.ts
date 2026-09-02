import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Il guardiano di `owner-bootstrap.sql`.
 *
 * Quel file e' l'unica strada per ricostruire il database dell'app da zero:
 * non c'e' una migration iniziale, quindi `prisma migrate deploy` su un
 * database vuoto non arriva da nessuna parte. Ed e' anche l'unico file che
 * nessuno esegue mai — un ambiente si ricostruisce una volta l'anno — quindi
 * quando resta indietro non lo scopre nessuno.
 *
 * Era gia' successo due volte. La prima mancavano tre tabelle intere. La
 * seconda, dopo che il file era stato rigenerato, il contenuto vecchio era
 * rimasto sotto quello nuovo: nove tabelle dichiarate due volte, e la seconda
 * dichiarazione senza le colonne aggiunte dal billing. Su un database vuoto lo
 * script si sarebbe fermato al primo `CREATE TABLE` ripetuto, lasciando lo
 * schema a meta'.
 *
 * Questo test confronta il file con cio' che Prisma genera dallo schema, che e'
 * la fonte di verita'. Non pretende che siano identici — nel file ci sono
 * anche i dati iniziali e i commenti, che non si generano — ma pretende che
 * ogni tabella, colonna, indice e vincolo dello schema ci sia, una volta sola.
 */

const ROOT = resolve(__dirname, '..');
const BOOTSTRAP = readFileSync(resolve(ROOT, 'prisma/owner-bootstrap.sql'), 'utf8');

/** La DDL che Prisma produce dallo schema. Non serve nessun database. */
function generatedDdl(): string {
  return execFileSync(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
}

/** Tabelle e colonne dichiarate in uno script SQL. */
function tables(sql: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const create = /CREATE TABLE (?:IF NOT EXISTS )?"([a-z_0-9]+)"\s*\(([\s\S]*?)\n\);/g;

  for (const match of sql.matchAll(create)) {
    const columns = new Set<string>();
    for (const line of match[2].split('\n')) {
      const column = /^"([A-Za-z_0-9]+)"\s/.exec(line.trim());
      if (column) columns.add(column[1]);
    }
    // Deliberatamente `set` e non un accumulo: una tabella dichiarata due volte
    // e' proprio il caso che questo test deve poter vedere, e lo vede il
    // controllo sui doppioni piu' sotto.
    found.set(match[1], columns);
  }

  return found;
}

/** Quante volte ogni tabella viene creata. */
function creationCount(sql: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([a-z_0-9]+)"/g)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return counts;
}

describe('owner-bootstrap.sql resta allineato allo schema', () => {
  it('crea tutte le tabelle dello schema, con tutte le loro colonne', () => {
    const atteso = tables(generatedDdl());
    const presente = tables(BOOTSTRAP);

    expect(atteso.size).toBeGreaterThan(0);

    const tabelleMancanti = [...atteso.keys()].filter((t) => !presente.has(t));
    expect(tabelleMancanti).toEqual([]);

    const colonneMancanti: string[] = [];
    for (const [tabella, colonne] of atteso) {
      const qui = presente.get(tabella);
      if (!qui) continue;
      for (const colonna of colonne) {
        if (!qui.has(colonna)) colonneMancanti.push(`${tabella}.${colonna}`);
      }
    }
    expect(colonneMancanti).toEqual([]);
  }, 120_000);

  // Su Postgres il secondo `CREATE TABLE` con lo stesso nome non e' un
  // doppione innocuo: e' un errore che ferma lo script a meta'.
  it('non dichiara nessuna tabella due volte', () => {
    const ripetute = [...creationCount(BOOTSTRAP)]
      .filter(([, volte]) => volte > 1)
      .map(([tabella]) => tabella);

    expect(ripetute).toEqual([]);
  });

  it('crea tutti gli indici e i vincoli dello schema', () => {
    const generato = generatedDdl();

    const indiciMancanti = [...generato.matchAll(/CREATE (?:UNIQUE )?INDEX "([a-z_0-9]+)"/g)]
      .map((m) => m[1])
      .filter((nome) => !BOOTSTRAP.includes(`"${nome}"`));
    expect(indiciMancanti).toEqual([]);

    const vincoliMancanti = [...generato.matchAll(/ADD CONSTRAINT "([a-z_0-9]+)"/g)]
      .map((m) => m[1])
      .filter((nome) => !BOOTSTRAP.includes(`"${nome}"`));
    expect(vincoliMancanti).toEqual([]);
  }, 120_000);
});
