import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ULTIMA_DELLA_LINEA_DI_BASE } from './registro';

/** L'impronta di `0_init` alla linea di base: lo sha256 che Prisma registra. */
const IMPRONTA_0_INIT = '601463ed9a4421d5c221fe3b8d8b85adc4c7527da325d7e63338bfb3e262d9cb';

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
   * `0_init` e' FERMO: e' la fotografia dello schema alla linea di base
   * (ULTIMA_DELLA_LINEA_DI_BASE), e da qui in poi non si tocca piu'.
   *
   * Finora era la copia byte per byte di `owner-bootstrap.sql`, e il test li
   * voleva identici. Ma il database owner sta per essere messo in linea di base
   * con `migrate resolve --applied 0_init`, e due cose dipendono dal fatto che
   * `0_init` non cambi:
   *
   *   - Prisma registra l'impronta (sha256) del file e rifiuta ogni
   *     `migrate deploy` successivo se cambia ("migration file has been
   *     modified");
   *   - la prova di struttura della linea di base (prisma/linea-di-base.ts)
   *     confronta la produzione con lo schema delle migrazioni fino alla linea
   *     di base. Se `0_init` venisse rigenerato con una migrazione successiva
   *     dentro, quello schema la conterrebbe, la produzione no, e la linea di
   *     base non si potrebbe piu' fare.
   *
   * Quindi: una modifica allo schema e' una migrazione NUOVA, e
   * `owner-bootstrap.sql` si rigenera per descrivere lo stato finale (le
   * istruzioni sono nella sua intestazione). Che le due strade portino allo
   * stesso database lo provano il job `migrations` della CI
   * (prisma/percorsi-uguali.ts) e i test PGlite, non piu' un confronto di testo.
   */
  it('ha l\'impronta della linea di base, e non cambia', () => {
    const init = readFileSync(resolve(MIGRAZIONI, '0_init/migration.sql'));
    expect(createHash('sha256').update(init).digest('hex')).toBe(IMPRONTA_0_INIT);
  });

  /**
   * Finche' dopo la linea di base non c'e' nessuna migrazione, lo schema finale
   * e' quello della linea di base: lo script e `0_init` sono lo stesso testo.
   * Dalla prima migrazione successiva lo script va avanti e `0_init` no.
   */
  it('coincide con owner-bootstrap.sql finche\' non ci sono migrazioni dopo la linea di base', () => {
    const dopo = cartelle().filter((nome) => nome > ULTIMA_DELLA_LINEA_DI_BASE);
    if (dopo.length > 0) return;
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
