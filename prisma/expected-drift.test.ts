import { describe, it, expect } from 'vitest';
import {
  DERIVA_VOLUTA,
  derivaInattesa,
  derivaVolutaMancante,
  istruzioni,
} from './expected-drift';

/**
 * Il cancello sulla deriva deve dire di si' solo alla differenza che gia'
 * conosciamo, e di no a tutto il resto. Se sbagliasse dal lato permissivo
 * lascerebbe passare in produzione una migrazione che cancella una colonna:
 * qui si prova che non lo fa.
 */

const DERIVA_NOTA = `-- DropForeignKey
ALTER TABLE "shops" DROP CONSTRAINT "shops_current_plan_fkey";

-- DropForeignKey
ALTER TABLE "shops" DROP CONSTRAINT "shops_last_synced_plan_fkey";

-- AlterTable
ALTER TABLE "supabase_configs" DROP COLUMN "supabase_db_password";
`;

describe('istruzioni', () => {
  it('toglie i commenti e le righe vuote', () => {
    expect(istruzioni('-- un commento\n\nSELECT 1;\n')).toEqual(['SELECT 1;']);
  });

  it('normalizza gli a capo: la stessa istruzione su piu\' righe e\' la stessa', () => {
    const suPiuRighe = 'ALTER TABLE "shops"\n  DROP CONSTRAINT\n  "shops_current_plan_fkey";';
    expect(istruzioni(suPiuRighe)).toEqual([DERIVA_VOLUTA[0]]);
  });

  it('non si fa ingannare da un punto e virgola dentro un commento', () => {
    expect(istruzioni('-- prima; poi\nSELECT 1;')).toEqual(['SELECT 1;']);
  });
});

describe('derivaInattesa', () => {
  it('non trova niente sulla deriva gia' + "' conosciuta", () => {
    expect(derivaInattesa(DERIVA_NOTA)).toEqual([]);
  });

  it('non trova niente su un diff vuoto', () => {
    expect(derivaInattesa('')).toEqual([]);
  });

  // Il caso che conta: una colonna che sparisce dal database e che il diff
  // proporrebbe di riaggiungere. Deve fermare tutto.
  it('trova una differenza che nessuna lista conosce', () => {
    const script = `${DERIVA_NOTA}\n-- AlterTable\nALTER TABLE "shops" ADD COLUMN "shop_currency" TEXT;\n`;
    expect(derivaInattesa(script)).toEqual(['ALTER TABLE "shops" ADD COLUMN "shop_currency" TEXT;']);
  });

  // Una DROP TABLE non e' mai deriva attesa: e' il caso in cui applicare il
  // diff alla lettera costerebbe dei dati.
  it('trova una tabella che il diff vorrebbe cancellare', () => {
    const script = 'DROP TABLE "compliance_requests";';
    expect(derivaInattesa(script)).toEqual(['DROP TABLE "compliance_requests";']);
  });
});

describe('derivaVolutaMancante', () => {
  it('non segnala niente quando le due chiavi esterne ci sono', () => {
    expect(derivaVolutaMancante(DERIVA_NOTA)).toEqual([]);
  });

  /**
   * Il rovescio, ed e' il motivo per cui questa funzione esiste: le due chiavi
   * esterne non sono nello schema, quindi se qualcuno le cancella dal database
   * il diff non se ne lamenta — semplicemente smette di nominarle. Senza questo
   * controllo la loro sparizione sarebbe silenziosa, e con essa la garanzia che
   * il piano scritto su un negozio esista davvero nel listino.
   */
  it('segnala una chiave esterna voluta che il database non ha piu\'', () => {
    const soloUna = 'ALTER TABLE "shops" DROP CONSTRAINT "shops_current_plan_fkey";';
    expect(derivaVolutaMancante(soloUna)).toEqual([DERIVA_VOLUTA[1]]);
  });

  it('le segnala entrambe su un diff vuoto', () => {
    expect(derivaVolutaMancante('')).toEqual(DERIVA_VOLUTA);
  });
});
