import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DERIVA_DA_RISOLVERE } from './expected-drift';
import { cartelleMigrazioni } from './linea-di-base';
import { DIFFERENZA_NOTA, FOTOGRAFIA_SQL, differenze, strutturaInattesa } from './percorsi-uguali';

/**
 * Script e migrazioni devono portare allo stesso database. La struttura la
 * confronta Prisma nel job `migrations` della CI; qui si prova il resto — dati
 * iniziali, RLS, vincoli — su due Postgres veri in memoria, e che il confronto
 * non lasci passare piu' di quanto dichiarato.
 */

const ROOT = resolve(__dirname, '..');
const MIGRAZIONI = resolve(ROOT, 'prisma/migrations');

async function fotografia(db: PGlite): Promise<string> {
  const esito = await db.query<Record<string, string>>(FOTOGRAFIA_SQL);
  return Object.values(esito.rows[0])[0];
}

describe('la differenza nota fra i due percorsi', () => {
  it('e\' la stessa colonna della deriva da risolvere, vista dall\'altro lato', () => {
    // Quando la migrazione che toglie la colonna ci sara', vanno via entrambe.
    const colonna = (riga: string) => /"supabase_configs"\s.*"([a-z_]+)"/.exec(riga)?.[1];
    expect(DIFFERENZA_NOTA.map(colonna)).toEqual(DERIVA_DA_RISOLVERE.map(colonna));
  });

  it('si riconosce anche con gli spazi che mette Prisma', () => {
    const script = `-- AlterTable
ALTER TABLE "public"."supabase_configs" ADD COLUMN     "supabase_db_password" TEXT;
`;
    expect(strutturaInattesa(script)).toEqual([]);
  });

  it('qualsiasi altra differenza di struttura passa come inattesa', () => {
    const script = 'ALTER TABLE "public"."shops" DROP COLUMN "locale";';
    expect(strutturaInattesa(script)).toEqual([script]);
  });
});

describe('differenze', () => {
  it('trova le righe che stanno da una parte sola', () => {
    expect(differenze('a\nb\nc', 'a\nc\nd')).toEqual({ soloDa: ['b'], soloA: ['d'] });
  });
});

describe('dati iniziali, RLS e vincoli', () => {
  it('lo script e le migrazioni lasciano la stessa fotografia', async () => {
    const daScript = new PGlite();
    await daScript.exec(readFileSync(resolve(ROOT, 'prisma/owner-bootstrap.sql'), 'utf8'));

    const daMigrazioni = new PGlite();
    for (const cartella of cartelleMigrazioni(MIGRAZIONI)) {
      await daMigrazioni.exec(readFileSync(resolve(MIGRAZIONI, cartella, 'migration.sql'), 'utf8'));
    }

    const a = await fotografia(daScript);
    const b = await fotografia(daMigrazioni);
    expect(a).toContain('Basic|');
    expect(differenze(a, b)).toEqual({ soloDa: [], soloA: [] });

    // E se un percorso resta indietro, la fotografia se ne accorge.
    await daMigrazioni.exec(`UPDATE "plans" SET "trial_days" = 7 WHERE "plan_name" = 'Basic'`);
    expect(differenze(a, await fotografia(daMigrazioni)).soloA).toHaveLength(1);

    await daScript.close();
    await daMigrazioni.close();
  }, 60_000);
});
