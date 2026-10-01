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
 * Si usa in tre punti:
 *   - la CI, contro il database appena costruito (bootstrap e migrazioni);
 *   - il workflow di migrazione, contro il database di produzione, PRIMA di
 *     applicare qualsiasi cosa;
 *   - prisma/linea-di-base.ts, per cui questo confronto e' la prova che le
 *     migrazioni di sola struttura ci sono gia'.
 *
 * DUE RIFERIMENTI, a seconda della fase.
 *
 *   post (default)  il database contro `schema.prisma`: dopo le migrazioni, e
 *                   in CI, deve essere esattamente lo schema che l'app usa.
 *   pre             il database contro lo schema a cui portano le migrazioni
 *                   GIA' REGISTRATE in `_prisma_migrations` (o, prima della
 *                   linea di base, quelle fino alla linea di base), rigiocate
 *                   su un database di appoggio locale (SHADOW_DATABASE_URL).
 *                   Contro `schema.prisma` ogni migrazione additiva ancora in
 *                   attesa — una colonna, una tabella — compariva come deriva
 *                   inattesa, e il workflow si fermava qui senza mai arrivare
 *                   ad applicarla. Le migrazioni in attesa non sono deriva:
 *                   sono quello che `applica` sta per fare. In questa fase le
 *                   due chiavi esterne sul nome del piano sono nelle
 *                   migrazioni, quindi una loro assenza compare come
 *                   `ADD CONSTRAINT` inatteso e ferma tutto lo stesso.
 */

import { execFileSync } from 'node:child_process';
import {
  cartelleMigrazioni,
  diffVersoMigrazioni,
  leggiRegistro,
  migrazioniDiRiferimento,
  psql,
} from './registro';

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
 * Due righe per la stessa colonna, una per verso. Contro `schema.prisma` un
 * database che la ha mostra il DROP. Contro le migrazioni (fase `pre`) e' il
 * rovescio: le migrazioni la creano, e un database costruito con
 * owner-bootstrap.sql — che non la ha — mostra l'ADD. Averla o non averla e'
 * indifferente per l'app, e nessuna delle due cose deve fermare il cancello.
 *
 * Quando la migrazione ci sara', queste righe vanno via da qui: se restano,
 * coprono.
 */
export const DERIVA_DA_RISOLVERE = [
  'ALTER TABLE "supabase_configs" DROP COLUMN "supabase_db_password";',
  'ALTER TABLE "supabase_configs" ADD COLUMN "supabase_db_password" TEXT;',
];

/**
 * Quello che il database puo' avere in piu' PRIMA di `migrate deploy`, e solo
 * allora: lo stato di partenza che una migrazione in attesa sta per togliere.
 *
 * Non e' deriva tollerata. Nella fase `post` (dopo le migrazioni, e in CI)
 * queste righe tornano a essere deriva inattesa e fermano tutto: se ci sono
 * ancora vuol dire che la migrazione che doveva toglierle non e' passata.
 *
 * - `plans.max_orders`: aggiunta da 20260923000000_pricing_alignment (stato B)
 *   e tolta da 20260926000000_plans_basic_growth_scale_core. Gli ordini non
 *   hanno limite su nessun piano.
 */
export const STATO_PRIMA_DELLE_MIGRAZIONI = [
  'ALTER TABLE "plans" DROP COLUMN "max_orders";',
];

/** Prima di `migrate deploy` (`pre`) o dopo (`post`, il default). */
export type Fase = 'pre' | 'post';

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

  // `"public".` lo scrive Prisma solo in alcuni confronti (fra due database
  // si', fra database e schema no): la stessa istruzione deve risultare uguale.
  return senzaCommenti
    .replace(/"public"\./g, '')
    .split(';')
    .map((istruzione) => istruzione.replace(/\s+/g, ' ').trim())
    .filter((istruzione) => istruzione.length > 0)
    .map((istruzione) => `${istruzione};`);
}

/** Cio' che il diff dice e che nessuna delle due liste conosce. */
export function derivaInattesa(script: string, fase: Fase = 'post'): string[] {
  const ammesse = new Set(
    [
      ...DERIVA_VOLUTA,
      ...DERIVA_DA_RISOLVERE,
      ...(fase === 'pre' ? STATO_PRIMA_DELLE_MIGRAZIONI : []),
    ].map((riga) => riga.trim()),
  );
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

async function principale(): Promise<void> {
  const daMigrazioni = process.argv.includes('--from-migrations');
  // `--fase=pre` solo nel workflow di produzione, prima di `migrate deploy`.
  const fase: Fase = process.argv.includes('--fase=pre') ? 'pre' : 'post';

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Manca DATABASE_URL.');
    process.exit(1);
  }

  let script: string;
  let origine: string;
  let riferimento = 'schema.prisma';
  if (daMigrazioni) {
    script = diff({ migrazioni: 'prisma/migrations', shadow: databaseUrl });
    origine = 'la catena delle migrazioni';
  } else if (fase === 'pre') {
    const psqlUrl = process.env.PSQL_URL;
    if (!psqlUrl) {
      console.error('Manca PSQL_URL: in fase pre serve per leggere il registro delle migrazioni.');
      process.exit(1);
    }
    const cartelle = cartelleMigrazioni();
    const registro = await leggiRegistro(psql(psqlUrl));
    const elenco = migrazioniDiRiferimento(cartelle, registro);
    script = diffVersoMigrazioni(databaseUrl, elenco, process.env.SHADOW_DATABASE_URL);
    origine = 'il database indicato da DATABASE_URL';
    riferimento =
      !registro || registro.concluse.length === 0
        ? `le migrazioni fino alla linea di base (${elenco.length}, registro assente o vuoto)`
        : `le ${elenco.length} migrazioni registrate come applicate`;
    const inAttesa = cartelle.filter((nome) => !elenco.includes(nome));
    console.log(`Riferimento: ${riferimento}.`);
    if (inAttesa.length > 0) {
      console.log(`Non fanno parte del confronto, perche' in attesa (${inAttesa.length}):`);
      for (const nome of inAttesa) console.log(`  ${nome}`);
    }
  } else {
    script = diff({ url: databaseUrl });
    origine = 'il database indicato da DATABASE_URL';
  }

  const inattesa = derivaInattesa(script, fase);
  // Contro schema.prisma le due chiavi esterne volute compaiono come DROP: se
  // il DROP non c'e', le chiavi non ci sono. Contro le migrazioni invece ci
  // sono gia' nel riferimento, e la loro assenza e' un ADD inatteso.
  const controllaChiavi = !daMigrazioni && riferimento === 'schema.prisma';
  const mancante = controllaChiavi ? derivaVolutaMancante(script) : [];

  if (inattesa.length === 0 && mancante.length === 0) {
    console.log(`Nessuna deriva inattesa fra ${origine} e ${riferimento}.`);
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
    console.error(`Deriva inattesa fra ${origine} e ${riferimento}:`);
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
  principale().catch((errore) => {
    console.error(errore instanceof Error ? errore.message : errore);
    process.exit(1);
  });
}
