/**
 * La deriva ammessa fra un database e `schema.prisma`, e il cancello che ferma
 * tutto il resto.
 *
 * `prisma migrate diff --from-url ... --to-schema-datamodel --exit-code` risponde
 * solo si'/no, e su questo repository risponde sempre "si', c'e' differenza":
 * il database in uso ha per scelta due chiavi esterne che lo schema non modella.
 * Un cancello che e' rosso comunque non e' un cancello — e' un allarme che si
 * impara a ignorare, ed e' proprio quello che sta succedendo al job `bootstrap`
 * della CI.
 *
 * Qui la domanda diventa un'altra: la differenza e' SOLO quella gia' conosciuta?
 * Se si', si passa. Se compare una riga in piu' — una colonna sparita, un indice
 * che non c'e', un tipo cambiato — ci si ferma e la si legge.
 *
 * Si usa in due punti:
 *   - la CI, contro il database appena costruito (bootstrap e migrazioni);
 *   - il workflow di migrazione, contro il database di produzione, PRIMA di
 *     applicare qualsiasi cosa.
 */

import { execFileSync } from 'node:child_process';

/**
 * Deriva VOLUTA: c'e' nel database, non c'e' nello schema, e deve restare cosi'.
 *
 * Sono le due chiavi esterne dal nome del piano scritto sul negozio al listino.
 * `schema.prisma` non modella la relazione fra shops e plans — Prisma vorrebbe
 * una relazione vera con i campi su entrambi i modelli, e qui il legame e' sul
 * NOME, non sull'id — ma il database ce l'ha e il codice ci conta: e' quello che
 * rende `current_plan` un elenco a tendina nel Table Editor invece di un campo
 * di testo libero, e che impedisce a un refuso di finire su un negozio.
 *
 * Chi applicasse alla lettera l'output di `migrate diff` le cancellerebbe. Non
 * vanno cancellate mai: questa lista serve anche a dirlo per iscritto, in un
 * posto che viene eseguito.
 */
export const DERIVA_VOLUTA = [
  'ALTER TABLE "shops" DROP CONSTRAINT "shops_current_plan_fkey";',
  'ALTER TABLE "shops" DROP CONSTRAINT "shops_last_synced_plan_fkey";',
];

/**
 * Deriva NOTA ma NON voluta: tollerata per non bloccare il cancello, in attesa
 * di una decisione. Non e' un posto dove parcheggiare le cose per sempre.
 *
 * `supabase_configs.supabase_db_password` e' stata aggiunta dalla migrazione
 * 20260716174127 e non l'ha mai tolta nessuno; il campo pero' e' sparito da
 * `schema.prisma`, quindi l'app non la legge e non la scrive piu'. E' una
 * colonna morta che contiene una password: va tolta con una migrazione scritta
 * apposta, non con un DROP eseguito a mano nell'SQL editor, e la decisione di
 * quando farlo e' del proprietario del database.
 *
 * Quando la migrazione ci sara', questa riga va via da qui: se resta, copre.
 */
export const DERIVA_DA_RISOLVERE = [
  'ALTER TABLE "supabase_configs" DROP COLUMN "supabase_db_password";',
];

/**
 * Le istruzioni di uno script SQL, una per riga, senza commenti e con gli spazi
 * normalizzati: la stessa istruzione scritta su tre righe e su una sola deve
 * risultare uguale, altrimenti il confronto con la lista dipenderebbe da come
 * Prisma va a capo.
 */
export function istruzioni(script: string): string[] {
  const senzaCommenti = script
    .split('\n')
    .filter((riga) => !riga.trimStart().startsWith('--'))
    .join('\n');

  return senzaCommenti
    .split(';')
    .map((istruzione) => istruzione.replace(/\s+/g, ' ').trim())
    .filter((istruzione) => istruzione.length > 0)
    .map((istruzione) => `${istruzione};`);
}

/** Cio' che il diff dice e che nessuna delle due liste conosce. */
export function derivaInattesa(script: string): string[] {
  const ammesse = new Set([...DERIVA_VOLUTA, ...DERIVA_DA_RISOLVERE].map((riga) => riga.trim()));
  return istruzioni(script).filter((istruzione) => !ammesse.has(istruzione));
}

/** La deriva voluta che il database NON ha piu': le chiavi esterne cancellate. */
export function derivaVolutaMancante(script: string): string[] {
  const presenti = new Set(istruzioni(script));
  return DERIVA_VOLUTA.filter((riga) => !presenti.has(riga));
}

/**
 * Lo script che porterebbe il database allo schema dichiarato.
 *
 * Due origini possibili: un database vero (`--from-url`) oppure la catena delle
 * migrazioni rigiocata su un database di appoggio (`--from-migrations`). La
 * seconda risponde alla domanda "le migrazioni scritte finora arrivano dove
 * dicono di arrivare?" senza bisogno di toccare niente di vero.
 */
function diff(origine: { url: string } | { migrazioni: string; shadow: string }): string {
  const argomenti =
    'url' in origine
      ? ['migrate', 'diff', '--from-url', origine.url]
      : [
          'migrate',
          'diff',
          '--from-migrations',
          origine.migrazioni,
          '--shadow-database-url',
          origine.shadow,
        ];

  return execFileSync(
    'npx',
    [
      'prisma',
      ...argomenti,
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ],
    // stderr passa: "Loaded Prisma config from prisma.config.ts." finisce li',
    // e mescolarlo allo script lo renderebbe un'istruzione SQL inesistente.
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

function principale(): void {
  const daMigrazioni = process.argv.includes('--from-migrations');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Manca DATABASE_URL.');
    process.exit(1);
  }

  const script = daMigrazioni
    ? diff({ migrazioni: 'prisma/migrations', shadow: databaseUrl })
    : diff({ url: databaseUrl });

  const origine = daMigrazioni
    ? 'la catena delle migrazioni'
    : 'il database indicato da DATABASE_URL';

  const inattesa = derivaInattesa(script);
  const mancante = daMigrazioni ? [] : derivaVolutaMancante(script);

  if (inattesa.length === 0 && mancante.length === 0) {
    console.log(`Nessuna deriva inattesa fra ${origine} e schema.prisma.`);
    if (!daMigrazioni) {
      console.log('Le due chiavi esterne sul nome del piano sono al loro posto.');
    }
    return;
  }

  if (mancante.length > 0) {
    console.error('');
    console.error('Chiavi esterne volute che il database non ha piu\':');
    for (const riga of mancante) {
      console.error(`  ${/"([a-z_0-9]+_fkey)"/.exec(riga)?.[1] ?? riga}`);
    }
    console.error('');
    console.error('Le ricrea la coda di prisma/owner-bootstrap.sql. Non applicare');
    console.error('un DROP CONSTRAINT su queste due: sono volute.');
  }

  if (inattesa.length > 0) {
    console.error('');
    console.error(`Deriva inattesa fra ${origine} e schema.prisma:`);
    for (const riga of inattesa) console.error(`  ${riga}`);
    console.error('');
    console.error('Per ognuna serve una decisione, non un DROP eseguito a mano:');
    console.error('  - se il database ha ragione, aggiornare schema.prisma;');
    console.error('  - se lo schema ha ragione, scrivere una migrazione;');
    console.error('  - se e\' una differenza voluta, aggiungerla a prisma/expected-drift.ts');
    console.error('    con scritto perche\'.');
    console.error('');
    console.error('Il percorso completo: docs/database-migrations.md');
  }

  process.exit(1);
}

// Solo quando lo si esegue, non quando il test lo importa.
if (process.argv[1]?.endsWith('expected-drift.ts')) {
  principale();
}
