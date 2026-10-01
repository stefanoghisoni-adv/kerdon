/**
 * La linea di base di Prisma su un database che esiste gia', senza marcature
 * alla cieca.
 *
 * IL PROBLEMA. Il database owner (Live e Test) e' stato costruito incollando le
 * migrazioni a mano nell'editor di Supabase: lo schema c'e', ma manca
 * `_prisma_migrations`, il registro in cui Prisma scrive cosa e' gia' passato.
 * Senza registro `prisma migrate deploy` si rifiuta di partire (P3005, "the
 * database schema is not empty"). La soluzione di Prisma e' `migrate resolve
 * --applied <nome>`: scrive nel registro "questa c'e' gia'", SENZA eseguirla.
 *
 * Ed e' proprio li' il rischio. Una migrazione dichiarata applicata e mai
 * eseguita e' persa per sempre: da quel momento `migrate deploy` la salta, e
 * nessun controllo successivo chiede piu' se c'e' davvero. La procedura di
 * prima era un ciclo con l'elenco delle eccezioni scritto a mano nei documenti:
 * bastava che la produzione fosse in uno stato diverso da quello immaginato da
 * chi aveva scritto l'elenco — e lo e', perche' le migrazioni sono state
 * incollate a mano in momenti diversi — per marcare qualcosa che non c'era.
 *
 * QUI SI MARCA SOLO CIO' CHE SI DIMOSTRA. Ogni migrazione fino a
 * ULTIMA_DELLA_LINEA_DI_BASE ha una prova in PROVE:
 *
 *   - `struttura`: tutto quello che fa e' struttura (tabelle, colonne, indici,
 *     chiavi esterne, tipi) piu' l'attivazione di RLS. La prova e' il confronto
 *     del database con `schema.prisma` (lo stesso di expected-drift.ts, fase
 *     `pre`) piu' RLS su ogni tabella e le due chiavi esterne sul nome del piano.
 *     Vale perche' la CI dimostra a ogni commit che la catena delle migrazioni
 *     arriva esattamente a `schema.prisma` (job `migrations`): un database
 *     uguale a `schema.prisma` contiene l'effetto di ognuna.
 *   - `sql`: la migrazione tocca anche i DATI (il listino, il partner iniziale,
 *     i giorni di prova), che il confronto con lo schema non vede. La prova e'
 *     una domanda al database sullo stato che la migrazione lascia.
 *
 * Si marca il tratto INIZIALE di migrazioni provate, e ci si ferma alla prima
 * che non lo e': tutto cio' che viene dopo resta in attesa e lo applichera'
 * `migrate deploy`. Mai marcare una migrazione che viene dopo una non provata:
 * Prisma applica quelle in attesa in ordine, e la non provata girerebbe sopra
 * lo stato di una successiva gia' marcata — e' il caso di 20260923 rigiocata
 * sopra il listino finale di 20260926, che riscrive i limiti del piano Core con
 * quelli del vecchio Core da 29 euro.
 *
 * E se in attesa resta qualcosa che in produzione DEVE esserci (tutto cio' che
 * precede PRIMA_CHE_PUO_MANCARE), non si marca niente: e' uno stato che nessuno
 * ha previsto, e la risposta e' fermarsi e guardarlo, non scegliere da soli.
 *
 * Uso:
 *   npx tsx prisma/linea-di-base.ts           # solo il resoconto, non scrive
 *   npx tsx prisma/linea-di-base.ts --marca   # scrive nel registro le provate
 *   npx tsx prisma/linea-di-base.ts --deve-esserci  # fallisce se la linea di base manca
 *
 * Vuole DATABASE_URL (per Prisma, con `?schema=public`) e PSQL_URL (lo stesso
 * database, senza `schema=`). Si esegue dal workflow
 * `.github/workflows/migrate-production.yml` (azione `verifica` per il
 * resoconto, `linea-di-base` per scrivere): docs/database-migrations.md.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { derivaInattesa, derivaVolutaMancante, diff } from './expected-drift';

/**
 * L'ultima migrazione che la linea di base puo' marcare. Quelle scritte dopo
 * non sono mai passate a mano: le applica solo `migrate deploy`, quindi non
 * c'e' niente da dichiarare e nessuna prova da scrivere.
 */
export const ULTIMA_DELLA_LINEA_DI_BASE = '20260926000000_plans_basic_growth_scale_core';

/**
 * Da qui in poi una migrazione puo' legittimamente mancare in produzione: e' il
 * cambio di listino (23 e 26 settembre) e quello che sta in mezzo. Tutto cio'
 * che viene prima l'app lo usa da settimane: se non risulta presente, qualcosa
 * non torna e non si marca niente.
 */
export const PRIMA_CHE_PUO_MANCARE = '20260923000000_pricing_alignment';

export type Prova =
  | { come: 'struttura'; nota?: string }
  | { come: 'sql'; cosa: string; sql: string };

/** Le tabelle dell'app, cioe' tutte quelle di `public` tranne il registro di Prisma. */
const TABELLE_APP = `pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;

function piano(nome: string): string {
  return `EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" = '${nome}')`;
}

function colonna(tabella: string, nome: string): string {
  return `EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '${tabella}' AND column_name = '${nome}')`;
}

const NOMI_VECCHI = `('Free', 'Pro', 'Business', 'Enterprise')`;

/**
 * Il listino finale, quello che lascia 20260926000000_plans_basic_growth_scale_core:
 * i quattro piani nuovi e Lifetime, nessun nome vecchio (ne' sui piani ne' su
 * negozi, addebiti e prezzi riservati), niente `max_orders`, e un prezzo in euro
 * e uno in dollari per ognuno dei quattro.
 */
const LISTINO_FINALE = `(
  ${['Basic', 'Growth', 'Scale', 'Core', 'Lifetime'].map(piano).join(' AND ')}
  AND NOT EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" IN ${NOMI_VECCHI})
  AND NOT EXISTS (SELECT 1 FROM "billing_charges" WHERE "plan_type" IN ${NOMI_VECCHI})
  AND NOT EXISTS (SELECT 1 FROM "partner_plan_prices" WHERE "plan_name" IN ${NOMI_VECCHI})
  AND NOT ${colonna('plans', 'max_orders')}
  AND NOT EXISTS (
    SELECT 1
      FROM unnest(ARRAY['Basic', 'Growth', 'Scale', 'Core']) AS p(nome)
     CROSS JOIN unnest(ARRAY['EUR', 'USD']) AS v(valuta)
     WHERE NOT EXISTS (
       SELECT 1 FROM "plan_prices" pp WHERE pp."plan_name" = p.nome AND pp."currency" = v.valuta
     )
  )
)`;

/**
 * Lo stato intermedio che lascia 20260923000000_pricing_alignment (stato B):
 * Free/Core/Growth/Scale, la colonna `max_orders`, nessun nome del listino A.
 */
const LISTINO_B = `(
  ${['Free', 'Core', 'Growth', 'Scale'].map(piano).join(' AND ')}
  AND NOT EXISTS (SELECT 1 FROM "plans" WHERE "plan_name" IN ('Pro', 'Business', 'Enterprise'))
  AND ${colonna('plans', 'max_orders')}
)`;

const STRUTTURA: Prova = { come: 'struttura' };

/**
 * Come si dimostra che ogni migrazione c'e'. Un test pretende una voce per ogni
 * cartella fino a ULTIMA_DELLA_LINEA_DI_BASE e nessuna dopo.
 *
 * Le note spiegano i casi in cui `struttura` potrebbe sembrare poco: sono le
 * migrazioni che oltre allo schema hanno toccato dei dati SENZA lasciare uno
 * stato controllabile oggi.
 */
export const PROVE: Record<string, Prova> = {
  '0_init': {
    come: 'struttura',
    nota: 'crea lo schema finale: la prova e\' che il database lo abbia gia\'. Non si puo\' rieseguire (CREATE TABLE senza IF NOT EXISTS), quindi va marcata o non si parte',
  },
  '20260714165105_add_connection_verified_at': STRUTTURA,
  '20260715002631_add_supabase_oauth_tokens': STRUTTURA,
  '20260716174127_add_supabase_project_fields': STRUTTURA,
  '20260717090000_add_authorization_and_trial_days': STRUTTURA,
  '20260720230000_add_read_proxy_token': STRUTTURA,
  '20260723190000_authorization_enum': STRUTTURA,
  '20260724100000_add_shop_timezone': STRUTTURA,
  '20260724180000_add_last_synced_plan': STRUTTURA,
  '20260802120000_add_tracking_authorization': {
    come: 'struttura',
    nota: 'la copia di authorization in tracking_authorization valeva per i negozi di allora e oggi non lascia uno stato da controllare: un negozio puo\' aver riavuto il tracciamento dopo',
  },
  '20260803090000_add_schema_version': STRUTTURA,
  '20260803100000_add_shop_primary_domain': STRUTTURA,
  '20260804120000_add_sync_job_events': STRUTTURA,
  '20260804160000_plan_name_foreign_keys': {
    come: 'struttura',
    nota: 'le due chiavi esterne sul nome del piano sono nella prova di struttura; esistono solo se ogni negozio ha un piano valido, che e\' il dato che la migrazione sistemava',
  },
  '20260804170000_active_charge_id_is_text': STRUTTURA,
  '20260807170000_partner_pricing': {
    come: 'sql',
    cosa: 'il partner iniziale own_partner',
    sql: `EXISTS (SELECT 1 FROM "partners" WHERE "name" = 'own_partner')`,
  },
  '20260807180000_partner_by_name': {
    come: 'struttura',
    nota: 'il travaso da partner_id a partner_name e\' provato da partner_name NOT NULL, che e\' nello schema',
  },
  '20260807220000_dismissed_tracking_sources': STRUTTURA,
  '20260813190000_tracking_setup': STRUTTURA,
  '20260814030000_plan_confirmed_at': STRUTTURA,
  '20260814040000_tracking_checked_at': STRUTTURA,
  '20260815010000_shop_locale': STRUTTURA,
  '20260815020000_detected_locale': STRUTTURA,
  '20260817120000_plan_prices_and_billing_currency': STRUTTURA,
  '20260818130000_preferred_currency': STRUTTURA,
  '20260818190000_setup_completed_and_project_name': {
    come: 'struttura',
    nota: 'setup_completed_at riempito per i negozi gia\' configurati allora; oggi un negozio a meta\' configurazione e\' un caso normale, quindi non c\'e\' uno stato da controllare',
  },
  '20260824120000_integration_platforms': {
    come: 'struttura',
    nota: 'la tabella e i suoi dati li toglie 20260824210000_drop_integrations: la prova e\' che non ci siano',
  },
  '20260824190000_meta_connection': {
    come: 'struttura',
    nota: 'tolta da 20260824210000_drop_integrations, come sopra',
  },
  '20260824210000_drop_integrations': STRUTTURA,
  '20260825100000_product_feeds': STRUTTURA,
  '20260825120000_product_feeds_plan': STRUTTURA,
  '20260825140000_feed_field_mappings': STRUTTURA,
  '20260825160000_plan_prices_backfill_base': {
    come: 'sql',
    cosa: 'ogni piano ha il suo prezzo in dollari',
    sql: `NOT EXISTS (
      SELECT 1 FROM "plans" p
       WHERE NOT EXISTS (
         SELECT 1 FROM "plan_prices" pp WHERE pp."plan_name" = p."plan_name" AND pp."currency" = 'USD'
       )
    )`,
  },
  '20260825170000_drop_plan_price_columns': STRUTTURA,
  '20260826120000_trial_on_every_plan': {
    come: 'sql',
    cosa: 'ogni piano tranne Lifetime ha dei giorni di prova',
    // Non "= 14": se in seguito qualcuno ha deciso un'altra durata, la
    // migrazione c'e' stata e rieseguirla gliela cancellerebbe.
    sql: `NOT EXISTS (
      SELECT 1 FROM "plans"
       WHERE "plan_name" <> 'Lifetime' AND coalesce("trial_days", 0) <= 0
    )`,
  },
  '20260827120000_customer_birthdate_metafield': STRUTTURA,
  '20260829120000_billing_callback_nonce': STRUTTURA,
  '20260829180000_compliance_requests': STRUTTURA,
  '20260904120000_row_level_security_everywhere': {
    come: 'struttura',
    nota: 'RLS su ogni tabella dell\'app e\' gia\' nella prova di struttura',
  },
  '20260904160000_supabase_managed_resources': STRUTTURA,
  '20260905120000_sync_request_queue': STRUTTURA,
  '20260905190000_sync_repairs': STRUTTURA,
  '20260905220000_webhook_inbox': STRUTTURA,
  '20260905240000_consent_revocation_register': STRUTTURA,
  '20260905260000_shop_erasure_proof': STRUTTURA,
  '20260906120000_product_scope': STRUTTURA,
  '20260910180000_tracking_install': STRUTTURA,
  '20260910200000_compliance_request_lease': STRUTTURA,
  '20260911120000_tracking_ingest_keys': STRUTTURA,
  '20260911140000_rename_created_by_kerdon': STRUTTURA,
  '20260918120000_supabase_auto_resume': STRUTTURA,
  '20260920120000_birthdate_notice_dismissal': STRUTTURA,
  '20260922000000_pricing_alignment_guard': {
    come: 'sql',
    cosa: 'la guardia non avrebbe niente da fare: Basic non c\'e\' (listini di prima) oppure il listino e\' gia\' quello finale',
    sql: `(NOT ${piano('Basic')} OR ${LISTINO_FINALE})`,
  },
  '20260923000000_pricing_alignment': {
    come: 'sql',
    cosa: 'il listino e\' allo stato B (Free/Core/Growth/Scale con max_orders) o a quello finale',
    sql: `(${LISTINO_B} OR ${LISTINO_FINALE})`,
  },
  '20260923120000_shipping_costs': STRUTTURA,
  '20260924100000_shipping_options': STRUTTURA,
  '20260926000000_plans_basic_growth_scale_core': {
    come: 'sql',
    cosa: 'il listino finale Basic/Growth/Scale/Core, senza nomi vecchi da nessuna parte e senza max_orders',
    sql: LISTINO_FINALE,
  },
};

/**
 * La parte della prova di struttura che `migrate diff` non vede, in una domanda
 * sola: RLS su ogni tabella dell'app e le due chiavi esterne sul nome del piano.
 */
export const RLS_E_CHIAVI_SQL = `(
  NOT EXISTS (SELECT 1 FROM ${TABELLE_APP} AND NOT rowsecurity)
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_current_plan_fkey')
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_last_synced_plan_fkey')
)`;

/**
 * Una domanda al database che risponde con una sola parola. Iniettata, cosi' i
 * test la fanno a PGlite e lo script a psql.
 */
export type Esegui = (sql: string) => Promise<string>;

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

/** L'esito di ogni prova `sql`: vera, falsa, o un errore (che non e' una prova). */
export async function eseguiProve(
  esegui: Esegui,
): Promise<Map<string, { vera: boolean; errore?: string }>> {
  const esiti = new Map<string, { vera: boolean; errore?: string }>();
  for (const [nome, prova] of Object.entries(PROVE)) {
    if (prova.come !== 'sql') continue;
    try {
      const risposta = await esegui(`SELECT CASE WHEN ${prova.sql} THEN 'si' ELSE 'no' END`);
      esiti.set(nome, { vera: risposta.trim() === 'si' });
    } catch (errore) {
      esiti.set(nome, {
        vera: false,
        errore: errore instanceof Error ? errore.message.split('\n')[0] : String(errore),
      });
    }
  }
  return esiti;
}

export interface Decisione {
  /** Le migrazioni da scrivere nel registro adesso, in ordine. */
  daMarcare: string[];
  /** Gia' nel registro (una linea di base interrotta a meta' e ripresa). */
  giaRegistrate: string[];
  /** Restano in attesa: le applichera' `migrate deploy`. */
  inAttesa: string[];
  /** Quando non e' null non si marca niente, e il motivo e' questo. */
  fermati: string | null;
  /** La linea di base c'e' gia' e il registro va avanti da solo: niente da fare. */
  giaStabilita: boolean;
}

/**
 * La decisione, senza toccare niente: dalle cartelle, dalle prove e dal
 * registro, cosa si marca e cosa resta in attesa.
 */
export function decidi(
  cartelle: string[],
  provate: Set<string>,
  registro: Registro | null,
): Decisione {
  const vuota = { daMarcare: [], giaRegistrate: [], inAttesa: [] };

  if (registro && registro.fallite.length > 0) {
    return {
      ...vuota,
      giaStabilita: false,
      fermati:
        `nel registro c'e' una migrazione iniziata e mai conclusa (${registro.fallite.join(', ')}). ` +
        'Vedi "Come si torna indietro" in docs/database-migrations.md prima di qualsiasi altra cosa.',
    };
  }

  // Il tratto iniziale provato.
  const prefisso: string[] = [];
  for (const nome of cartelle) {
    if (nome > ULTIMA_DELLA_LINEA_DI_BASE || !provate.has(nome)) break;
    prefisso.push(nome);
  }
  const inAttesa = cartelle.slice(prefisso.length);

  const registrate = new Set(registro?.concluse ?? []);

  // Un registro che non e' vuoto vuol dire linea di base gia' fatta, con una
  // sola eccezione: una linea di base interrotta a meta'. `migrate resolve` le
  // scrive una alla volta e in ordine, quindi un'interruzione lascia nel
  // registro esattamente le prime k cartelle, con k minore del tratto provato:
  // in quel caso si riprende da dove si era arrivati. In ogni altro caso — il
  // registro contiene il tratto per intero, o c'e' gia' passato un
  // `migrate deploy` — il registro va avanti da solo e qui non c'e' niente da
  // fare.
  if (registrate.size > 0) {
    const k = registrate.size;
    const interrotta =
      k < prefisso.length && cartelle.slice(0, k).every((nome) => registrate.has(nome));
    if (!interrotta) return { ...vuota, giaStabilita: true, fermati: null };
  }

  const nonPreviste = inAttesa.filter((nome) => nome < PRIMA_CHE_PUO_MANCARE);
  if (nonPreviste.length > 0) {
    return {
      ...vuota,
      inAttesa,
      giaStabilita: false,
      fermati:
        `${nonPreviste[0]} non risulta presente nel database, e non e' fra quelle che possono mancare ` +
        `(da ${PRIMA_CHE_PUO_MANCARE} in poi). Non si marca niente: serve una decisione.`,
    };
  }

  return {
    daMarcare: prefisso.filter((nome) => !registrate.has(nome)),
    giaRegistrate: prefisso.filter((nome) => registrate.has(nome)),
    inAttesa,
    fermati: null,
    giaStabilita: false,
  };
}

/** Le cartelle di migrazione, nell'ordine in cui Prisma le applica. */
export function cartelleMigrazioni(radice = resolve(process.cwd(), 'prisma/migrations')): string[] {
  return readdirSync(radice)
    .filter((nome) => statSync(resolve(radice, nome)).isDirectory())
    .sort();
}

/**
 * Dalle prove alla lista delle provate. Le `struttura` valgono tutte insieme:
 * o il database e' quello di `schema.prisma` con RLS e chiavi esterne, o
 * nessuna e' provata.
 */
export function provateDa(
  strutturaOk: boolean,
  esitiSql: Map<string, { vera: boolean }>,
): Set<string> {
  const provate = new Set<string>();
  for (const [nome, prova] of Object.entries(PROVE)) {
    if (prova.come === 'struttura' ? strutturaOk : esitiSql.get(nome)?.vera === true) {
      provate.add(nome);
    }
  }
  return provate;
}

function psql(url: string): Esegui {
  return async (sql) =>
    execFileSync('psql', [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

async function principale(): Promise<void> {
  const marca = process.argv.includes('--marca');
  const databaseUrl = process.env.DATABASE_URL;
  const psqlUrl = process.env.PSQL_URL;
  if (!databaseUrl || !psqlUrl) {
    console.error('Mancano DATABASE_URL o PSQL_URL.');
    process.exit(1);
  }
  const esegui = psql(psqlUrl);

  const registro = await leggiRegistro(esegui);
  console.log(
    registro === null
      ? 'Registro delle migrazioni (_prisma_migrations): non esiste ancora.'
      : `Registro delle migrazioni: ${registro.concluse.length} concluse, ${registro.fallite.length} fallite.`,
  );

  // La prova di struttura: lo stesso confronto di expected-drift.ts in fase
  // `pre`, piu' RLS e le chiavi esterne sul nome del piano.
  const script = diff({ url: databaseUrl });
  const inattesa = derivaInattesa(script, 'pre');
  const fkMancanti = derivaVolutaMancante(script);
  const rlsEChiavi = (await esegui(`SELECT CASE WHEN ${RLS_E_CHIAVI_SQL} THEN 'si' ELSE 'no' END`)).trim() === 'si';
  const strutturaOk = inattesa.length === 0 && fkMancanti.length === 0 && rlsEChiavi;

  console.log('');
  console.log(
    strutturaOk
      ? 'Struttura: il database corrisponde a schema.prisma, RLS ovunque, chiavi esterne sul piano presenti.'
      : 'Struttura: NON corrisponde (deriva inattesa, RLS mancante o chiavi esterne sul piano assenti).',
  );
  for (const riga of inattesa) console.log(`  deriva: ${riga}`);
  if (fkMancanti.length > 0) console.log('  mancano le chiavi esterne sul nome del piano');
  if (!rlsEChiavi) console.log('  RLS spenta su almeno una tabella, o chiavi esterne sul piano assenti');

  const esitiSql = await eseguiProve(esegui);
  const provate = provateDa(strutturaOk, esitiSql);
  const cartelle = cartelleMigrazioni();

  console.log('');
  console.log('Migrazione per migrazione:');
  for (const nome of cartelle) {
    const prova = PROVE[nome];
    if (!prova) {
      console.log(`  ${nome}: dopo la linea di base, la applica migrate deploy`);
      continue;
    }
    const esito = provate.has(nome) ? 'PROVATA' : 'NON PROVATA';
    const come =
      prova.come === 'struttura'
        ? 'struttura'
        : `${prova.cosa}${esitiSql.get(nome)?.errore ? ` — errore: ${esitiSql.get(nome)?.errore}` : ''}`;
    console.log(`  ${nome}: ${esito} (${come})`);
  }

  const decisione = decidi(cartelle, provate, registro);

  console.log('');
  if (decisione.giaStabilita) {
    console.log('La linea di base c\'e\' gia\': niente da marcare.');
    return;
  }
  // Con `applica`: senza linea di base `migrate deploy` si fermerebbe comunque
  // (P3005), ma con un messaggio che parla di schema non vuoto. Meglio dirlo qui.
  if (process.argv.includes('--deve-esserci')) {
    console.error('FERMATI: la linea di base non c\'e\' ancora. Prima l\'azione "linea-di-base".');
    process.exit(1);
  }
  if (decisione.fermati) {
    console.error(`FERMATI: ${decisione.fermati}`);
    process.exit(1);
  }

  console.log(`Da marcare come applicate (${decisione.daMarcare.length}):`);
  for (const nome of decisione.daMarcare) console.log(`  ${nome}`);
  if (decisione.giaRegistrate.length > 0) {
    console.log(`Gia' nel registro, da una linea di base interrotta (${decisione.giaRegistrate.length}).`);
  }
  console.log(`Restano in attesa, le applichera' l'azione "applica" (${decisione.inAttesa.length}):`);
  for (const nome of decisione.inAttesa) console.log(`  ${nome}`);

  if (!marca) {
    console.log('');
    console.log('Solo resoconto: non e\' stato scritto niente. Per scrivere: azione "linea-di-base".');
    return;
  }

  console.log('');
  for (const nome of decisione.daMarcare) {
    // `migrate resolve --applied` non esegue SQL: scrive una riga nel registro.
    execFileSync('npx', ['prisma', 'migrate', 'resolve', '--applied', nome], { stdio: 'inherit' });
  }

  // Il registro l'ha appena creato Prisma, e lo crea senza RLS. Su Supabase una
  // tabella di `public` senza RLS e' leggibile E SCRIVIBILE con la chiave
  // pubblica del progetto: chiunque potrebbe dichiarare applicata una
  // migrazione mai eseguita. Sul percorso delle migrazioni ci pensa
  // 20260904120000_row_level_security_everywhere, che gira dopo che il registro
  // esiste; qui quella migrazione viene marcata, non eseguita.
  await esegui('ALTER TABLE public."_prisma_migrations" ENABLE ROW LEVEL SECURITY');
  console.log('RLS attivata sul registro delle migrazioni.');
}

// Solo quando lo si esegue, non quando il test lo importa.
if (process.argv[1]?.endsWith('linea-di-base.ts')) {
  principale().catch((errore) => {
    console.error(errore instanceof Error ? errore.message : errore);
    process.exit(1);
  });
}
