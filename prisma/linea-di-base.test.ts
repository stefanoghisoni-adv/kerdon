import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PROVE,
  PRIMA_CHE_PUO_MANCARE,
  RLS_E_CHIAVI_SQL,
  ULTIMA_DELLA_LINEA_DI_BASE,
  cartelleMigrazioni,
  decidi,
  eseguiProve,
  leggiRegistro,
  provateDa,
  statoRegistro,
  type Esegui,
} from './linea-di-base';
import { controllaAppoggio, migrazioniDiRiferimento } from './registro';

/**
 * La linea di base marca come applicato solo cio' che si dimostra presente, e
 * si ferma invece di scegliere quando lo stato non e' uno di quelli previsti.
 * Se sbagliasse dal lato permissivo dichiarerebbe applicata in produzione una
 * migrazione mai eseguita, che da quel momento nessuno eseguirebbe piu'.
 */

const ROOT = resolve(__dirname, '..');
const MIGRAZIONI = resolve(ROOT, 'prisma/migrations');
const CARTELLE = cartelleMigrazioni(MIGRAZIONI);
const FINO_ALLA_BASE = CARTELLE.filter((nome) => nome <= ULTIMA_DELLA_LINEA_DI_BASE);

const GUARDIA = '20260922000000_pricing_alignment_guard';
const PRICING_ALIGNMENT = '20260923000000_pricing_alignment';
const LISTINO_NUOVO = '20260926000000_plans_basic_growth_scale_core';

function sql(cartella: string): string {
  return readFileSync(resolve(MIGRAZIONI, cartella, 'migration.sql'), 'utf8');
}

/** Un database come la produzione: migrazioni incollate a mano, nessun registro. */
async function databaseMigratoAMano(): Promise<PGlite> {
  const db = new PGlite();
  for (const cartella of CARTELLE) await db.exec(sql(cartella));
  return db;
}

function eseguiSu(db: PGlite): Esegui {
  return async (domanda) => {
    const esito = await db.query<Record<string, unknown>>(domanda);
    const riga = esito.rows[0];
    return riga ? String(Object.values(riga)[0] ?? '') : '';
  };
}

async function esitiSu(db: PGlite) {
  return eseguiProve(eseguiSu(db));
}

/** Il listino com'era prima del 23 settembre (stato A), con un negozio sopra. */
const STATO_A = `
  DELETE FROM "plan_prices";
  DELETE FROM "plans" WHERE "plan_name" <> 'Lifetime';
  INSERT INTO "plans" ("id", "plan_name", "max_products", "max_customers", "max_sync_frequency_hours", "custom_fields_limit", "support_level", "customers_sync_enabled", "product_feeds_enabled", "trial_days") VALUES
    (gen_random_uuid()::text, 'Free',       50,  200, 168,    3, 'community', false, false, 14),
    (gen_random_uuid()::text, 'Pro',       200,  500,  96,   10, 'email',     true,  true,  14),
    (gen_random_uuid()::text, 'Business', 1000, 2000,  48,   50, 'priority',  true,  true,  14),
    (gen_random_uuid()::text, 'Enterprise',NULL, NULL,  24, NULL, 'dedicated', true,  true,  14);
  INSERT INTO "plan_prices" ("id", "plan_name", "currency", "price_monthly", "price_yearly")
    SELECT gen_random_uuid()::text, "plan_name", 'USD', 0, 0 FROM "plans";
  INSERT INTO "shops" ("id", "shop_domain", "access_token", "scopes", "current_plan")
    VALUES ('s1', 's1.myshopify.com', 'x', 'x', 'Pro');
`;

describe('le prove', () => {
  it('ce n\'e\' una per ogni migrazione fino alla linea di base, e nessuna dopo', () => {
    expect(Object.keys(PROVE).sort()).toEqual(FINO_ALLA_BASE);
  });

  it('i due confini sono cartelle vere, nell\'ordine giusto', () => {
    expect(CARTELLE).toContain(ULTIMA_DELLA_LINEA_DI_BASE);
    expect(CARTELLE).toContain(PRIMA_CHE_PUO_MANCARE);
    expect(PRIMA_CHE_PUO_MANCARE <= ULTIMA_DELLA_LINEA_DI_BASE).toBe(true);
  });

  it('le migrazioni che toccano il listino non si accontentano della struttura', () => {
    // Il confronto con schema.prisma non vede i dati: per queste servirebbe a
    // poco, e una marcatura sbagliata qui e' quella che costa di piu'.
    for (const nome of [GUARDIA, PRICING_ALIGNMENT, LISTINO_NUOVO]) {
      expect(PROVE[nome].come).toBe('sql');
    }
  });
});

describe('decidi', () => {
  const tutte = new Set(FINO_ALLA_BASE);
  const senza = (...nomi: string[]) => new Set([...tutte].filter((n) => !nomi.includes(n)));

  it('tutto provato e nessun registro: si marca tutto fino alla linea di base', () => {
    const d = decidi(CARTELLE, tutte, null);
    expect(d.fermati).toBeNull();
    expect(d.daMarcare).toEqual(FINO_ALLA_BASE);
    expect(d.inAttesa).toEqual(CARTELLE.filter((n) => n > ULTIMA_DELLA_LINEA_DI_BASE));
  });

  it('listino ancora da cambiare: si marca fino alla guardia, il resto lo applica deploy', () => {
    const d = decidi(CARTELLE, senza(PRICING_ALIGNMENT, LISTINO_NUOVO), null);
    expect(d.fermati).toBeNull();
    expect(d.daMarcare.at(-1)).toBe(GUARDIA);
    expect(d.inAttesa[0]).toBe(PRICING_ALIGNMENT);
    expect(d.inAttesa).toContain(LISTINO_NUOVO);
  });

  it('mai marcata una migrazione che viene dopo una non provata', () => {
    // 20260923 rigiocata sopra il listino finale riscriverebbe i limiti di Core.
    const d = decidi(CARTELLE, senza(PRICING_ALIGNMENT), null);
    expect(d.daMarcare).not.toContain(LISTINO_NUOVO);
    expect(d.inAttesa).toContain(LISTINO_NUOVO);
  });

  it('manca qualcosa che non puo\' mancare: non si marca niente', () => {
    const d = decidi(CARTELLE, senza('20260826120000_trial_on_every_plan'), null);
    expect(d.fermati).toMatch(/20260826120000_trial_on_every_plan/);
    expect(d.daMarcare).toEqual([]);
  });

  it('struttura diversa da schema.prisma: non si marca niente, nemmeno 0_init', () => {
    const d = decidi(CARTELLE, provateDa(false, new Map()), null);
    expect(d.fermati).toMatch(/0_init/);
    expect(d.daMarcare).toEqual([]);
  });

  it('una migrazione fallita nel registro ferma tutto', () => {
    const d = decidi(CARTELLE, tutte, { concluse: ['0_init'], fallite: ['20260714165105_add_connection_verified_at'] });
    expect(d.fermati).toMatch(/mai conclusa/);
    expect(d.daMarcare).toEqual([]);
  });

  it('registro gia\' completo: linea di base gia\' stabilita', () => {
    const d = decidi(CARTELLE, tutte, { concluse: FINO_ALLA_BASE, fallite: [] });
    expect(d.giaStabilita).toBe(true);
    expect(d.daMarcare).toEqual([]);
  });

  it('registro che va oltre il tratto provato (c\'e\' passato deploy): niente da fare', () => {
    const d = decidi(CARTELLE, senza(PRICING_ALIGNMENT, LISTINO_NUOVO), {
      concluse: FINO_ALLA_BASE,
      fallite: [],
    });
    expect(d.giaStabilita).toBe(true);
    expect(d.daMarcare).toEqual([]);
  });

  it('linea di base fatta sul listino A: il resto e\' in attesa, e va bene', () => {
    const finoAllaGuardia = FINO_ALLA_BASE.filter((n) => n <= GUARDIA);
    const d = decidi(CARTELLE, senza(PRICING_ALIGNMENT, LISTINO_NUOVO), {
      concluse: finoAllaGuardia,
      fallite: [],
    });
    expect(d.fermati).toBeNull();
    expect(d.giaStabilita).toBe(true);
    expect(d.inAttesa[0]).toBe(PRICING_ALIGNMENT);
  });

  it('registro fermo prima di cio\' che non puo\' mancare, e niente da riprendere: ci si ferma', () => {
    // Le prove non dimostrano piu' quello che il registro non ha: `migrate
    // deploy` rigiocherebbe migrazioni di mesi fa su un database di oggi.
    const d = decidi(CARTELLE, new Set(), { concluse: FINO_ALLA_BASE.slice(0, 5), fallite: [] });
    expect(d.giaStabilita).toBe(false);
    expect(d.fermati).toMatch(new RegExp(FINO_ALLA_BASE[5]));
  });

  it('linea di base interrotta a meta\': si riprende da dove era arrivata', () => {
    const fatte = FINO_ALLA_BASE.slice(0, 10);
    const d = decidi(CARTELLE, tutte, { concluse: fatte, fallite: [] });
    expect(d.giaStabilita).toBe(false);
    expect(d.giaRegistrate).toEqual(fatte);
    expect(d.daMarcare).toEqual(FINO_ALLA_BASE.slice(10));
  });

  it('un registro con dei buchi ferma tutto, e dice quali', () => {
    const d = decidi(CARTELLE, tutte, { concluse: [FINO_ALLA_BASE[3]], fallite: [] });
    expect(d.giaStabilita).toBe(false);
    expect(d.fermati).toMatch(/buchi/);
    expect(d.inAttesa).toEqual(FINO_ALLA_BASE.slice(0, 3));
    expect(d.daMarcare).toEqual([]);
  });

  it('il buco che conta: 20260923 assente con 20260926 registrata', () => {
    // `migrate deploy` la rigiocherebbe sopra il listino finale e riscriverebbe
    // i limiti di Core con quelli del vecchio Core da 29 euro.
    const d = decidi(CARTELLE, tutte, {
      concluse: FINO_ALLA_BASE.filter((n) => n !== PRICING_ALIGNMENT),
      fallite: [],
    });
    expect(d.giaStabilita).toBe(false);
    expect(d.fermati).toMatch(new RegExp(PRICING_ALIGNMENT));
    expect(d.inAttesa).toEqual([PRICING_ALIGNMENT]);
  });

  it('una migrazione registrata che nel repository non c\'e\' ferma tutto', () => {
    const d = decidi(CARTELLE, tutte, { concluse: [...FINO_ALLA_BASE, '29990101000000_dal_futuro'], fallite: [] });
    expect(d.fermati).toMatch(/dal_futuro/);
  });
});

describe('le prove su un Postgres vero (PGlite)', () => {
  let finale: PGlite;

  beforeAll(async () => {
    finale = await databaseMigratoAMano();
  }, 60_000);

  afterAll(async () => {
    await finale.close();
  });

  it('sul listino finale ogni prova risponde si\'', async () => {
    const esiti = await esitiSu(finale);
    for (const [nome, esito] of esiti) {
      expect({ nome, ...esito }).toEqual({ nome, vera: true });
    }
    expect(await eseguiSu(finale)(`SELECT CASE WHEN ${RLS_E_CHIAVI_SQL} THEN 'si' ELSE 'no' END`)).toBe('si');

    const d = decidi(CARTELLE, provateDa(true, esiti), await leggiRegistro(eseguiSu(finale)));
    expect(d.daMarcare).toEqual(FINO_ALLA_BASE);
  });

  it('senza registro, leggiRegistro risponde null', async () => {
    expect(await leggiRegistro(eseguiSu(finale))).toBeNull();
  });

  it('una tabella senza RLS fa cadere la prova di struttura', async () => {
    const db = await databaseMigratoAMano();
    await db.exec('ALTER TABLE "shop_locks" DISABLE ROW LEVEL SECURITY');
    expect(await eseguiSu(db)(`SELECT CASE WHEN ${RLS_E_CHIAVI_SQL} THEN 'si' ELSE 'no' END`)).toBe('no');
    await db.close();
  }, 60_000);

  it('dallo stato A: provata la guardia, non il cambio di listino', async () => {
    const db = await databaseMigratoAMano();
    // Lo stato A non ha `max_orders`: la toglie la migrazione del 26, che qui
    // e' gia' passata.
    await db.exec(STATO_A);
    const esiti = await esitiSu(db);
    expect(esiti.get(GUARDIA)?.vera).toBe(true);
    expect(esiti.get(PRICING_ALIGNMENT)?.vera).toBe(false);
    expect(esiti.get(LISTINO_NUOVO)?.vera).toBe(false);

    const d = decidi(CARTELLE, provateDa(true, esiti), null);
    expect(d.fermati).toBeNull();
    expect(d.daMarcare.at(-1)).toBe(GUARDIA);
    expect(d.inAttesa[0]).toBe(PRICING_ALIGNMENT);
    await db.close();
  }, 60_000);

  it('dallo stato B: provato pricing_alignment, non il listino finale', async () => {
    const db = await databaseMigratoAMano();
    await db.exec(STATO_A);
    await db.exec(sql(PRICING_ALIGNMENT));
    const esiti = await esitiSu(db);
    expect(esiti.get(PRICING_ALIGNMENT)?.vera).toBe(true);
    expect(esiti.get(LISTINO_NUOVO)?.vera).toBe(false);

    const d = decidi(CARTELLE, provateDa(true, esiti), null);
    expect(d.inAttesa[0]).toBe('20260926000000_plans_basic_growth_scale_core');
    await db.close();
  }, 60_000);

  it('un nome vecchio rimasto su un addebito: il listino finale non e\' provato', async () => {
    const db = await databaseMigratoAMano();
    await db.exec(`
      INSERT INTO "shops" ("id", "shop_domain", "access_token", "scopes", "current_plan")
        VALUES ('s1', 's1.myshopify.com', 'x', 'x', 'Basic');
      INSERT INTO "billing_charges" ("id", "shop_id", "plan_type", "status")
        VALUES ('b1', 's1', 'Pro', 'active');
    `);
    expect((await esitiSu(db)).get(LISTINO_NUOVO)?.vera).toBe(false);
    await db.close();
  }, 60_000);

  it('legge il registro: concluse e fallite', async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE "_prisma_migrations" (
        "migration_name" text, "finished_at" timestamptz, "rolled_back_at" timestamptz
      );
      INSERT INTO "_prisma_migrations" VALUES
        ('0_init', now(), NULL),
        ('20260714165105_add_connection_verified_at', NULL, NULL),
        ('20260715002631_add_supabase_oauth_tokens', NULL, now());
    `);
    expect(await leggiRegistro(eseguiSu(db))).toEqual({
      concluse: ['0_init'],
      fallite: ['20260714165105_add_connection_verified_at'],
    });
    await db.close();
  });
});

describe('il riferimento della fase pre e il database di appoggio', () => {
  it('senza registro: le migrazioni fino alla linea di base, non oltre', () => {
    const conUnaNuova = [...CARTELLE, '29990101000000_colonna_nuova'];
    expect(migrazioniDiRiferimento(conUnaNuova, null)).toEqual(FINO_ALLA_BASE);
    expect(migrazioniDiRiferimento(conUnaNuova, { concluse: [], fallite: [] })).toEqual(FINO_ALLA_BASE);
  });

  it('con il registro: solo le registrate, quindi una migrazione in attesa non e\' deriva', () => {
    const conUnaNuova = [...CARTELLE, '29990101000000_colonna_nuova'];
    const registro = { concluse: FINO_ALLA_BASE, fallite: [] };
    expect(migrazioniDiRiferimento(conUnaNuova, registro)).toEqual(FINO_ALLA_BASE);
    expect(statoRegistro(conUnaNuova, registro).buchi).toEqual([]);
  });

  it('il database di appoggio deve essere locale: Prisma lo svuota', () => {
    expect(controllaAppoggio('postgresql://ci:ci@localhost:5432/ombra')).toContain('localhost');
    expect(controllaAppoggio('postgresql://ci:ci@127.0.0.1:5432/ombra')).toContain('127.0.0.1');
    expect(() => controllaAppoggio('postgresql://postgres:x@db.abcdefgh.supabase.co:5432/postgres')).toThrow(/localhost/);
    expect(() => controllaAppoggio(undefined)).toThrow(/SHADOW_DATABASE_URL/);
  });
});
