import { describe, it, expect } from 'vitest';
import { InvalidIdentifierError } from './identifiers';
import {
  MERCHANT_DROP_ORDER,
  buildDropTransactionSQL,
  buildExistenceCheckSQL,
  orderForDrop,
  remainingResources,
  type ManagedResource,
} from './managed-resources';

function table(resourceName: string, schemaName = 'public'): ManagedResource {
  return { schemaName, resourceName, resourceKind: 'table' };
}

const FULL_INSTALL = ['products', 'users', 'customers', 'orders', 'order_lines'].map((n) =>
  table(n),
);

describe('ordine di eliminazione', () => {
  it('le righe d ordine cadono prima degli ordini', () => {
    // Nella DDL non c'e' nessuna foreign key fra le due, ma il database e' del
    // merchant e niente gli vieta di averne aggiunta una: con l'ordine
    // sbagliato il DROP verrebbe rifiutato e l'eliminazione fallirebbe tutta.
    const ordered = orderForDrop(FULL_INSTALL).map((r) => r.resourceName);

    expect(ordered.indexOf('order_lines')).toBeLessThan(ordered.indexOf('orders'));
    expect(ordered).toEqual([...MERCHANT_DROP_ORDER]);
  });

  it('un nome che la DDL non conosce va per primo', () => {
    // Puo' essere una dipendente di una delle nostre; non puo' essere una da
    // cui le nostre dipendono, perche' la DDL non la nomina.
    const ordered = orderForDrop([table('products'), table('vecchia_tabella')]);

    expect(ordered.map((r) => r.resourceName)).toEqual(['vecchia_tabella', 'products']);
  });
});

describe('il DDL di eliminazione', () => {
  it('e una transazione sola con tutte e cinque le tabelle', () => {
    // L'esito dev'essere uno per tutte: se la terza viene rifiutata, le due
    // gia' cadute devono tornare.
    const sql = buildDropTransactionSQL(FULL_INSTALL);

    expect(sql).toBe(
      [
        'BEGIN;',
        'DROP TABLE IF EXISTS "public"."order_lines";',
        'DROP TABLE IF EXISTS "public"."orders";',
        'DROP TABLE IF EXISTS "public"."customers";',
        'DROP TABLE IF EXISTS "public"."users";',
        'DROP TABLE IF EXISTS "public"."products";',
        'COMMIT;',
      ].join('\n'),
    );
  });

  it('mai CASCADE', () => {
    // CASCADE porterebbe via anche gli oggetti del merchant che dipendono
    // dalle nostre tabelle: una sua vista, una sua chiave esterna. Non sono
    // nostri.
    expect(buildDropTransactionSQL(FULL_INSTALL)).not.toContain('CASCADE');
  });

  it('senza niente da eliminare non produce SQL', () => {
    expect(buildDropTransactionSQL([])).toBe('');
  });

  it('un nome malformato viene rifiutato PRIMA che esista una riga di SQL', () => {
    // E' il punto di tutto: il rifiuto arriva alla costruzione, non
    // all'esecuzione. A meta' di un DROP non c'e' piu' niente da salvare.
    expect(() =>
      buildDropTransactionSQL([table('products"; DROP TABLE clienti; --')]),
    ).toThrow(InvalidIdentifierError);

    expect(() => buildDropTransactionSQL([table('products', 'public; --')])).toThrow(
      InvalidIdentifierError,
    );
  });
});

describe('la verifica dopo il COMMIT', () => {
  it('chiede a information_schema, con i nomi come valori', () => {
    // Come VALORI, apice singolo: qui il nome non e' un identificatore ma una
    // stringa da confrontare, e confondere le due citazioni produce una
    // verifica che sembra funzionare e non confronta niente.
    const sql = buildExistenceCheckSQL([table('products'), table('users')]);

    expect(sql).toContain("table_schema = 'public'");
    expect(sql).toContain("table_name IN ('products', 'users')");
    expect(sql).not.toContain('"products"');
  });

  it('schemi diversi restano separati', () => {
    const sql = buildExistenceCheckSQL([table('products'), table('users', 'kerdon')]);

    expect(sql).toContain("(table_schema = 'public' AND table_name IN ('products'))");
    expect(sql).toContain("(table_schema = 'kerdon' AND table_name IN ('users'))");
    expect(sql).toContain(' OR ');
  });

  it('nessuna riga di ritorno = sparite tutte', () => {
    expect(remainingResources(FULL_INSTALL, [])).toEqual([]);
  });

  it('una tabella ancora viva viene riportata', () => {
    const remaining = remainingResources(FULL_INSTALL, [
      { table_schema: 'public', table_name: 'order_lines' },
    ]);

    expect(remaining.map((r) => r.resourceName)).toEqual(['order_lines']);
  });

  it('lo stesso nome in uno schema diverso non conta', () => {
    // Il merchant puo' avere una sua `products` altrove: non e' quella che
    // dovevamo eliminare, e trovarla non deve far dichiarare un fallimento.
    const remaining = remainingResources(FULL_INSTALL, [
      { table_schema: 'archivio', table_name: 'products' },
    ]);

    expect(remaining).toEqual([]);
  });
});
