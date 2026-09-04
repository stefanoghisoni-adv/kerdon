import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Cosa deve essere vero della cartella delle migrazioni, senza toccare nessun
 * database.
 *
 * Il controllo vero — le migrazioni rigiocate su un Postgres vuoto — sta nel job
 * `migrations` della CI, che ha bisogno di un database. Qui c'e' quello che si
 * puo' chiedere ai soli file, e che quindi risponde in un secondo a ogni push:
 * la migrazione iniziale allineata allo script di bootstrap, il connettore
 * dichiarato, e — la piu' importante — nessuna tabella nuova senza RLS.
 */

const ROOT = resolve(__dirname, '..');
const MIGRAZIONI = resolve(ROOT, 'prisma/migrations');

function leggi(percorso: string): string {
  return readFileSync(percorso, 'utf8');
}

/**
 * Lo stesso file senza le righe di commento: in questo repository i commenti
 * sono lunghi e raccontano cosa fa la migrazione, quindi contengono le stesse
 * parole del codice ("il CREATE TABLE qui sopra non fa niente") e le farebbero
 * scambiare per istruzioni.
 */
function senzaCommenti(sql: string): string {
  return sql
    .split('\n')
    .filter((riga) => !riga.trimStart().startsWith('--'))
    .join('\n');
}

/** Le cartelle di migrazione, in ordine di applicazione (Prisma le ordina per nome). */
function cartelle(): string[] {
  return readdirSync(MIGRAZIONI)
    .filter((nome) => statSync(resolve(MIGRAZIONI, nome)).isDirectory())
    .sort();
}

describe('la migrazione iniziale', () => {
  /**
   * `0_init` e' la COPIA di `owner-bootstrap.sql`, non una seconda scrittura
   * della stessa cosa.
   *
   * Due file che descrivono lo stesso database sono due file da ricordarsi di
   * aggiornare, ed e' gia' successo due volte che uno dei due restasse indietro
   * in silenzio. Tenendoli identici byte per byte la domanda "sono allineati?"
   * ha una risposta sola, e `owner-bootstrap.test.ts` — che confronta il
   * bootstrap con lo schema — vale automaticamente anche per la migrazione.
   *
   * Quando si rigenera `owner-bootstrap.sql` si ricopia:
   *
   *   cp prisma/owner-bootstrap.sql prisma/migrations/0_init/migration.sql
   *
   * ATTENZIONE: dopo che un database e' stato messo in linea di base
   * (`prisma migrate resolve --applied 0_init`) Prisma confronta il file con
   * l'impronta registrata e rifiuta di procedere se e' cambiato. Da quel
   * momento `0_init` non si tocca piu': le modifiche allo schema diventano
   * migrazioni nuove. Il percorso sta in docs/database-migrations.md.
   */
  it('e\' identica a owner-bootstrap.sql', () => {
    const bootstrap = leggi(resolve(ROOT, 'prisma/owner-bootstrap.sql'));
    const init = leggi(resolve(MIGRAZIONI, '0_init/migration.sql'));

    expect(init).toBe(bootstrap);
  });

  it('e\' la prima che Prisma applica', () => {
    expect(cartelle()[0]).toBe('0_init');
  });
});

describe('migration_lock.toml', () => {
  /**
   * Mancava, e senza di lui `prisma migrate diff --from-migrations` si ferma con
   * "Could not determine the connector to use for the migrations": non c'era
   * modo di chiedere a Prisma se la catena delle migrazioni arriva dove dice.
   */
  it('dichiara postgresql', () => {
    const lock = leggi(resolve(MIGRAZIONI, 'migration_lock.toml'));
    expect(lock).toMatch(/^provider = "postgresql"$/m);
  });
});

describe('row level security', () => {
  /**
   * Ogni tabella nuova nasce con RLS attiva. Non e' una buona pratica generica:
   * Supabase pubblica lo schema `public` attraverso la Data API, quindi una
   * tabella senza RLS e' leggibile da chiunque abbia la chiave pubblica del
   * progetto — che sta nei browser e non e' un segreto.
   *
   * E' gia' successo: `compliance_requests` e' stata creata senza, e dentro ci
   * sono il corpo dei webhook GDPR (id e email della persona) e le
   * esportazioni complete dei suoi dati. `owner-bootstrap.sql` non ha il
   * problema perche' chiude con un ciclo su tutte le tabelle; chi arriva per
   * migrazioni invece deve dirlo tabella per tabella, e li' era stato
   * dimenticato.
   *
   * Il controllo a database vero c'e' gia' (`bootstrap-check.sql`, eseguito
   * dalla CI e dal workflow di migrazione). Questo lo anticipa al momento in cui
   * la migrazione viene scritta, che e' quando costa meno accorgersene.
   */
  const CICLO_SU_TUTTE = /FOR\s+\w+\s+IN\s+SELECT\s+tablename\s+FROM\s+pg_tables/i;

  it('e\' attivata da ogni migrazione che crea una tabella', () => {
    const scoperte: string[] = [];

    for (const cartella of cartelle()) {
      const sql = senzaCommenti(leggi(resolve(MIGRAZIONI, cartella, 'migration.sql')));

      // `0_init` (e chiunque faccia lo stesso) attiva RLS con un ciclo su tutte
      // le tabelle dello schema: nominarle una per una sarebbe piu' fragile.
      if (CICLO_SU_TUTTE.test(sql)) continue;

      const create = /CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_0-9]+)"?/gi;
      for (const trovata of sql.matchAll(create)) {
        const tabella = trovata[1];
        const attivata = new RegExp(
          `ALTER TABLE[^;]*"?${tabella}"?[^;]*ENABLE ROW LEVEL SECURITY`,
          'i',
        );
        if (!attivata.test(sql)) scoperte.push(`${cartella} → ${tabella}`);
      }
    }

    expect(scoperte).toEqual([]);
  });
});
