import { describe, it, expect } from 'vitest';
import { PAGE_SIZE, readAllByEq, readAllByIn, type PagedTable } from './paged-read';
import { isGdprTableId, orderKeyOf, type GdprTableId } from './subject-keys';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * L'impaginazione, che prima poteva perdere righe e ripeterle senza dirlo.
 *
 * `.range(from, to)` senza `ORDER BY` chiede la fetta n-esima di un ordine che
 * il database non ha promesso. Con delle scritture in corso quella fetta si
 * sposta: una riga inserita prima del cursore fa scorrere in avanti tutto il
 * resto, e la riga che stava al confine esce due volte o non esce affatto. Il
 * confronto con il conteggio non se ne accorgeva, perche' un doppione e una
 * riga persa insieme fanno tornare il totale.
 *
 * Il finto PostgREST qui sotto e' scritto apposta per poter mostrare quel
 * guasto: le righe si possono cambiare FRA una pagina e l'altra, che e' la cosa
 * che nella vita vera succede e nei test non succede quasi mai.
 */

interface Riga extends Record<string, unknown> {
  id: string;
  owner: string;
}

interface Opzioni {
  /** Il tetto di righe per risposta del progetto, se piu' basso della pagina. */
  maxRows?: number;
  /** Un progetto che il conteggio non lo manda: si va avanti a occhio. */
  senzaConteggio?: boolean;
  /** Cosa succede al database dopo che una pagina e' stata servita. */
  fraLePagine?: (tabella: Riga[], pagina: number) => void;
}

function fakeSupabase(tabella: Riga[], opzioni: Opzioni = {}) {
  const richieste: { column: string; ascending: boolean; after: string | null }[] = [];
  let pagine = 0;

  const chain = (filtro: (riga: Riga) => boolean) => {
    let after: string | null = null;
    let column = '';
    let ascending = false;

    const builder: any = {
      gt: (col: string, valore: unknown) => {
        column = col;
        after = String(valore);
        return builder;
      },
      order: (col: string, opts: { ascending: boolean }) => {
        column = col;
        ascending = opts.ascending;
        return builder;
      },
      limit: (quante: number) => {
        richieste.push({ column, ascending, after });

        const tutte = tabella.filter(filtro);
        const ordinate = [...tutte].sort((a, b) => String(a[column]).localeCompare(String(b[column])));
        const dopo =
          after === null ? ordinate : ordinate.filter((r) => String(r[column]) > (after as string));
        const data = dopo.slice(0, Math.min(quante, opzioni.maxRows ?? Infinity));

        // Il conteggio e' quello VERO della tabella adesso, non quello della
        // pagina: e' la differenza che permette di accorgersi di una lettura
        // fermata a meta'.
        const risultato = {
          data,
          error: null,
          count: opzioni.senzaConteggio ? null : tutte.length,
        };

        pagine++;
        opzioni.fraLePagine?.(tabella, pagine);

        return {
          ...risultato,
          then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
            Promise.resolve(risultato).then(ok, ko),
        };
      },
    };

    return builder;
  };

  const client = {
    from: () => ({
      select: () => ({
        eq: (col: string, valore: unknown) =>
          chain((riga) => String(riga[col]) === String(valore)),
        in: (col: string, valori: unknown[]) =>
          chain((riga) => valori.map(String).includes(String(riga[col]))),
      }),
    }),
  };

  return { client: client as any, richieste };
}

const ORDINI: PagedTable = { id: 'orders', name: 'orders' };

const riga = (id: string, owner = '4021'): Riga => ({ id, owner });

/** Cento righe con id ordinabili come stringhe: id-000 ... id-099. */
function molte(quante: number, owner = '4021'): Riga[] {
  return Array.from({ length: quante }, (_, i) => riga(`id-${String(i).padStart(3, '0')}`, owner));
}

describe('la chiave con cui si impagina', () => {
  it('viene da una mappa nostra, tabella per tabella', () => {
    expect(orderKeyOf('orders')).toBe('id');
    expect(orderKeyOf('order_lines')).toBe('id');
    expect(orderKeyOf('customers')).toBe('id');
    // I browser non hanno un UUID generato: la chiave primaria e'
    // l'identificativo stesso.
    expect(orderKeyOf('users')).toBe('external_id');
  });

  /**
   * IL PUNTO DELLA MAPPA. Il nome della chiave finisce dentro `ORDER BY` e
   * dentro il confronto del cursore, cioe' in due posti dove il database si
   * aspetta un identificatore. Un nome che venisse da fuori sarebbe un pezzo di
   * query scritto da qualcun altro.
   */
  it('una tabella che non sta nella mappa non arriva mai dentro una query', async () => {
    const { client, richieste } = fakeSupabase(molte(3));

    await expect(
      readAllByEq(client, { id: 'tabella_inventata' as GdprTableId, name: 'x' }, 'owner', '4021'),
    ).rejects.toThrow(/mappa delle chiavi/);

    // E il lancio arriva PRIMA di qualunque andata e ritorno.
    expect(richieste).toHaveLength(0);
  });

  it('nemmeno una proprieta che ogni oggetto ha per conto suo', () => {
    // `ORDER_KEYS['constructor']` non e' undefined: con un accesso diretto
    // sarebbe passata, e sarebbe finita in un ORDER BY.
    expect(isGdprTableId('constructor')).toBe(false);
    expect(isGdprTableId('__proto__')).toBe(false);
    expect(() => orderKeyOf('constructor' as GdprTableId)).toThrow();
  });
});

describe('ogni pagina dice da dove riparte', () => {
  it('chiede un ordinamento esplicito, crescente, sulla chiave', async () => {
    const { client, richieste } = fakeSupabase(molte(3));

    await readAllByEq(client, ORDINI, 'owner', '4021');

    expect(richieste[0].column).toBe('id');
    expect(richieste[0].ascending).toBe(true);
  });

  it('la prima pagina non ha cursore, le successive si', async () => {
    // Tre pagine: il tetto del progetto e' piu' basso della pagina chiesta.
    const { client, richieste } = fakeSupabase(molte(5), { maxRows: 2 });

    const read = await readAllByEq(client, ORDINI, 'owner', '4021');

    expect(read.rows).toHaveLength(5);
    expect(richieste[0].after).toBeNull();
    expect(richieste[1].after).toBe('id-001');
    expect(richieste[2].after).toBe('id-003');
  });

  /**
   * Il tetto di righe per risposta e' del progetto, non nostro. Fermarsi alla
   * prima pagina piu' corta di quella chiesta avrebbe troncato la lettura al
   * primo giro dichiarandola intera.
   */
  it('non smette su una pagina corta: il tetto e del progetto, non nostro', async () => {
    const { client, richieste } = fakeSupabase(molte(4), { maxRows: 2 });

    const read = await readAllByEq(client, ORDINI, 'owner', '4021');

    expect(read.rows).toHaveLength(4);
    expect(richieste.length).toBeGreaterThan(1);
  });

  it('raccolte tutte quelle dichiarate, non si chiede la pagina dopo', async () => {
    const { client, richieste } = fakeSupabase(molte(4), { maxRows: 2 });

    await readAllByEq(client, ORDINI, 'owner', '4021');

    // Il database ne aveva dichiarate quattro e quattro ne sono arrivate: la
    // pagina successiva sarebbe vuota, e chiederla e' un'andata e ritorno per
    // sentirselo dire.
    expect(richieste).toHaveLength(2);
  });

  it('senza conteggio si va avanti fino alla pagina vuota', async () => {
    // Un progetto che il conteggio non lo manda non permette di indovinare
    // quando si e finito: l unica prova e una pagina vuota.
    const { client, richieste } = fakeSupabase(molte(4), { maxRows: 2, senzaConteggio: true });

    const read = await readAllByEq(client, ORDINI, 'owner', '4021');

    expect(read.rows).toHaveLength(4);
    expect(richieste).toHaveLength(3);
  });

  it('restituisce anche le chiavi lette, non solo le righe', async () => {
    const { client } = fakeSupabase(molte(3));

    const read = await readAllByEq(client, ORDINI, 'owner', '4021');

    expect(read.keys).toEqual(['id-000', 'id-001', 'id-002']);
  });
});

describe('scritture concorrenti durante l impaginazione', () => {
  /**
   * IL GUASTO STORICO. Con lo scostamento, una riga inserita PRIMA del cursore
   * fa scorrere in avanti tutto il resto: la riga che stava al confine fra la
   * prima e la seconda pagina esce due volte. Con il cursore per chiave non
   * puo' succedere, perche' la seconda pagina chiede "cio' che viene dopo
   * questa chiave" e non "cio' che sta dalla posizione 2 in poi".
   */
  it('una riga inserita prima del cursore non produce doppioni', async () => {
    const tabella = molte(4);
    const { client } = fakeSupabase(tabella, {
      maxRows: 2,
      fraLePagine: (t, pagina) => {
        // Dopo la prima pagina entra una riga che si ordina PRIMA di tutte.
        if (pagina === 1) t.push(riga('id-aaa'));
      },
    });

    const read = await readAllByEq(client, ORDINI, 'owner', '4021');

    expect(new Set(read.keys).size).toBe(read.keys.length);
    // La riga entrata dopo l'inizio puo' non uscire — non c'era quando la
    // lettura e' cominciata — ma nessuna di quelle che c'erano si perde.
    for (const originale of ['id-000', 'id-001', 'id-002', 'id-003']) {
      expect(read.keys).toContain(originale);
    }
  });

  it('una riga cancellata prima del cursore non fa saltare quelle dopo', async () => {
    const tabella = molte(6);
    const { client } = fakeSupabase(tabella, {
      maxRows: 2,
      fraLePagine: (t, pagina) => {
        // Con lo scostamento questa cancellazione faceva scorrere indietro la
        // finestra, e la riga successiva al confine non usciva mai.
        if (pagina === 1) t.splice(0, 1);
      },
    });

    const read = await readAllByEq(client, ORDINI, 'owner', '4021');

    for (const rimasta of ['id-001', 'id-002', 'id-003', 'id-004', 'id-005']) {
      expect(read.keys).toContain(rimasta);
    }
    expect(new Set(read.keys).size).toBe(read.keys.length);
  });
});

describe('quando la lettura non torna', () => {
  it('una riga senza chiave ferma tutto invece di essere saltata', async () => {
    // Senza chiave non c'e' da dove ripartire: proseguire vorrebbe dire o
    // rileggere in eterno la stessa pagina o saltare tutto quello che viene
    // dopo, e la seconda finirebbe in un'esportazione dichiarata completa.
    const { client } = fakeSupabase([{ id: undefined as never, owner: '4021' }]);

    const read = await readAllByEq(client, ORDINI, 'owner', '4021');

    expect((read.error as any)?.code).toBe('GDPR_CHIAVE_MANCANTE');
  });
});

describe('le letture a lotti', () => {
  it('impaginano ogni lotto per chiave come le altre', async () => {
    const { client, richieste } = fakeSupabase(molte(3), { maxRows: 2 });

    const read = await readAllByIn(client, ORDINI, 'id', ['id-000', 'id-001', 'id-002']);

    expect(read.keys).toEqual(['id-000', 'id-001', 'id-002']);
    expect(richieste.every((r) => r.column === 'id' && r.ascending)).toBe(true);
  });

  it('la pagina chiesta resta quella dichiarata', async () => {
    const { client, richieste } = fakeSupabase(molte(2));

    await readAllByEq(client, ORDINI, 'owner', '4021');

    expect(PAGE_SIZE).toBe(500);
    // Due righe su duecento dichiarate come due: una richiesta sola basta.
    expect(richieste).toHaveLength(1);
  });
});
