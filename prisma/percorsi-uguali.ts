/**
 * Il database costruito con lo script e quello costruito con le migrazioni sono
 * lo stesso database?
 *
 * La CI li confrontava gia' tutti e due con `schema.prisma`, ognuno per conto
 * suo, attraverso expected-drift.ts. Ma quel confronto tollera la deriva nota,
 * e la tolleranza nascondeva proprio una differenza fra i due percorsi: la
 * colonna morta `supabase_configs.supabase_db_password` c'e' su chi arriva
 * dalle migrazioni e non su chi arriva dallo script. Due database "uguali allo
 * schema, a meno della deriva nota" non sono per forza uguali fra loro.
 *
 * Qui il confronto e' diretto, e su due piani:
 *
 *   1. la struttura, con `prisma migrate diff --from-url --to-url`: ammessa
 *      solo la differenza scritta in DIFFERENZA_NOTA;
 *   2. quello che `migrate diff` non vede: le righe iniziali (piani, listino,
 *      partner), RLS tabella per tabella e i nomi dei vincoli — FOTOGRAFIA_SQL,
 *      eseguita sui due database e confrontata riga per riga.
 *
 * Variabili (sono quelle del job `migrations` della CI):
 *   BASE_DATABASE_URL, BASE_PSQL_URL  il database costruito da owner-bootstrap.sql
 *   DATABASE_URL, PSQL_URL            il database costruito da `migrate deploy`
 */

import { execFileSync } from 'node:child_process';
import { istruzioni } from './expected-drift';

/**
 * Quello che il percorso delle migrazioni ha in piu' dello script, e perche'.
 *
 * E' la stessa colonna di DERIVA_DA_RISOLVERE in expected-drift.ts, vista dal
 * lato opposto: va via insieme a quella, con la migrazione che la toglie.
 */
export const DIFFERENZA_NOTA = [
  'ALTER TABLE "public"."supabase_configs" ADD COLUMN "supabase_db_password" TEXT;',
];

/**
 * Una fotografia testuale di cio' che `migrate diff` non confronta. Niente id e
 * niente date: i prezzi e il partner iniziale nascono con `gen_random_uuid()`,
 * quindi gli id sono diversi per costruzione.
 */
export const FOTOGRAFIA_SQL = `
SELECT concat_ws(E'\\n',
  '-- piani',
  (SELECT string_agg(concat_ws('|', "plan_name", "max_products", "max_customers",
            "max_sync_frequency_hours", "custom_fields_limit", "support_level",
            "customers_sync_enabled", "product_feeds_enabled", "trial_days"),
          E'\\n' ORDER BY "plan_name") FROM "plans"),
  '-- listino',
  (SELECT string_agg(concat_ws('|', "plan_name", "currency", "price_monthly", "price_yearly"),
          E'\\n' ORDER BY "plan_name", "currency") FROM "plan_prices"),
  '-- partner',
  (SELECT string_agg(concat_ws('|', "name", "label"), E'\\n' ORDER BY "name") FROM "partners"),
  '-- rls',
  (SELECT string_agg(concat_ws('|', tablename, rowsecurity), E'\\n' ORDER BY tablename)
     FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'),
  '-- vincoli',
  (SELECT string_agg(c.conname, E'\\n' ORDER BY c.conname)
     FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.conrelid <> coalesce(to_regclass('public._prisma_migrations')::oid, 0::oid))
)`;

/** Le righe che stanno in una fotografia e non nell'altra. */
export function differenze(da: string, a: string): { soloDa: string[]; soloA: string[] } {
  const righeDa = da.split('\n');
  const righeA = a.split('\n');
  return {
    soloDa: righeDa.filter((riga) => !righeA.includes(riga)),
    soloA: righeA.filter((riga) => !righeDa.includes(riga)),
  };
}

/** Le istruzioni del diff strutturale che DIFFERENZA_NOTA non spiega. */
export function strutturaInattesa(script: string): string[] {
  const nota = new Set(DIFFERENZA_NOTA);
  return istruzioni(script).filter((istruzione) => !nota.has(istruzione));
}

function principale(): void {
  const { BASE_DATABASE_URL, BASE_PSQL_URL, DATABASE_URL, PSQL_URL } = process.env;
  if (!BASE_DATABASE_URL || !BASE_PSQL_URL || !DATABASE_URL || !PSQL_URL) {
    console.error('Servono BASE_DATABASE_URL, BASE_PSQL_URL, DATABASE_URL e PSQL_URL.');
    process.exit(1);
  }

  const script = execFileSync(
    'npx',
    ['prisma', 'migrate', 'diff', '--from-url', BASE_DATABASE_URL, '--to-url', DATABASE_URL, '--script'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const inattesa = strutturaInattesa(script);

  const fotografa = (url: string) =>
    execFileSync('psql', [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', FOTOGRAFIA_SQL], {
      encoding: 'utf8',
    }).trim();
  const { soloDa, soloA } = differenze(fotografa(BASE_PSQL_URL), fotografa(PSQL_URL));

  if (inattesa.length === 0 && soloDa.length === 0 && soloA.length === 0) {
    console.log('Script e migrazioni portano allo stesso database (a meno di DIFFERENZA_NOTA).');
    return;
  }

  if (inattesa.length > 0) {
    console.error('Struttura diversa fra lo script e le migrazioni:');
    for (const riga of inattesa) console.error(`  ${riga}`);
  }
  if (soloDa.length > 0 || soloA.length > 0) {
    console.error('Dati iniziali, RLS o vincoli diversi:');
    for (const riga of soloDa) console.error(`  solo dallo script:     ${riga}`);
    for (const riga of soloA) console.error(`  solo dalle migrazioni: ${riga}`);
  }
  console.error('');
  console.error('Uno dei due percorsi e\' rimasto indietro: owner-bootstrap.sql o una migrazione.');
  process.exit(1);
}

if (process.argv[1]?.endsWith('percorsi-uguali.ts')) {
  principale();
}
