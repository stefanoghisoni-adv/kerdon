import { describe, it, expect } from 'vitest';
import { collectSubjectData, compareKeys, materializeSubject } from './subject-snapshot.server';
import { stepsFailed, type GdprStep } from './steps';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * L'esportazione come fotografia di un istante, invece che come lettura che
 * scorre mentre il mondo si muove.
 *
 * Il guasto che queste prove difendono e' silenzioso per costruzione: la
 * raccolta leggeva le quattro tabelle in fila senza lucchetto, e una
 * sincronizzazione in corso le riscriveva sotto. Ne usciva un pacchetto che
 * metteva insieme gli ordini delle 10:00 e le loro righe delle 10:04
 * presentandoli come visti insieme — e a chi lo legge sembra a posto.
 *
 * Adesso il lavoro e' in due tempi: sotto lucchetto si fissa QUALI righe sono
 * della persona, fuori dal lucchetto si vanno a prendere per chiave, e alla
 * fine si confronta. Il confronto e' su conteggi E chiavi, perche' una riga
 * sparita e una comparsa lasciano il conteggio dov'era.
 */

interface Riga extends Record<string, unknown> {
  id?: string;
  external_id?: string;
}

interface Chiamata {
  table: string;
  select: string;
  column: string;
}

interface Opzioni {
  /** Tabelle che rispondono con un errore invece che con delle righe. */
  errori?: Record<string, { code: string; message: string }>;
  /** Un conteggio dichiarato diverso da quello vero: esportazione parziale. */
  conteggi?: Record<string, number>;
  /** Il tetto di righe per risposta del progetto, tabella per tabella. */
  maxRows?: Record<string, number>;
}

function fakeSupabase(tabelle: Record<string, Riga[]>, opzioni: Opzioni = {}) {
  const chiamate: Chiamata[] = [];

  const client = {
    from: (table: string) => ({
      select: (select: string) => {
        const filtro = (column: string, valori: unknown[]) => {
          chiamate.push({ table, select, column });

          let after: string | null = null;
          let chiave = 'id';

          const chain: any = {
            gt: (col: string, valore: unknown) => {
              chiave = col;
              after = String(valore);
              return chain;
            },
            order: (col: string) => {
              chiave = col;
              return chain;
            },
            limit: (quante: number) => {
              const errore = opzioni.errori?.[table];
              const base = errore
                ? { data: null, error: errore, count: null }
                : pagina(table, column, valori, chiave, after, quante);

              return {
                ...base,
                then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
                  Promise.resolve(base).then(ok, ko),
              };
            },
          };

          return chain;
        };

        return {
          eq: (column: string, valore: unknown) => filtro(column, [valore]),
          in: (column: string, valori: unknown[]) => filtro(column, valori),
        };
      },
    }),
  };

  function pagina(
    table: string,
    column: string,
    valori: unknown[],
    chiave: string,
    after: string | null,
    quante: number,
  ) {
    const tutte = (tabelle[table] ?? []).filter((r) =>
      valori.map(String).includes(String(r[column])),
    );
    const ordinate = [...tutte].sort((a, b) =>
      String(a[chiave]).localeCompare(String(b[chiave])),
    );
    const dopo =
      after === null ? ordinate : ordinate.filter((r) => String(r[chiave]) > (after as string));
    const cap = opzioni.maxRows?.[table] ?? Infinity;

    return {
      data: dopo.slice(0, Math.min(quante, cap)),
      error: null,
      // Il conteggio dichiarato puo' essere diverso da quello vero: e' cosi'
      // che un progetto racconta di avere piu' righe di quante ne consegna.
      count: opzioni.conteggi?.[table] ?? tutte.length,
    };
  }

  return { client: client as any, tabelle, chiamate };
}

const ordine = (n: number, cliente = '4021'): Riga => ({
  id: `ord-${String(n).padStart(4, '0')}`,
  shopify_order_id: 900 + n,
  shopify_customer_id: cliente,
  total_price: '1.00',
});

const rigaOrdine = (n: number, ordineN: number): Riga => ({
  id: `lin-${String(n).padStart(4, '0')}`,
  shopify_line_id: n,
  shopify_order_id: 900 + ordineN,
  title: 'Tazza',
});

const step = (steps: GdprStep[], table: string) => steps.find((s) => s.table === table);

function negozio(over: Partial<Record<string, Riga[]>> = {}) {
  return {
    customers: [{ id: 'cli-1', shopify_customer_id: '4021', email_address: 'chi@esempio.it' }],
    orders: [ordine(0), ordine(1)],
    order_lines: [rigaOrdine(1, 0)],
    users: [],
    ...over,
  } as Record<string, Riga[]>;
}

describe('la fotografia', () => {
  it('legge le sole chiavi, non le righe intere', async () => {
    // E' cio' che tiene corta la finestra in cui il negozio resta fermo: sotto
    // lucchetto si stabilisce QUALI righe sono della persona, e basta.
    const { client, chiamate } = fakeSupabase(negozio());

    await materializeSubject(client, 'customers', '4021');

    const clienti = chiamate.find((c) => c.table === 'customers');
    const ordini = chiamate.find((c) => c.table === 'orders');
    const righe = chiamate.find((c) => c.table === 'order_lines');

    expect(clienti?.select).toBe('id');
    // Degli ordini serve anche l'id Shopify: e' la strada per le righe
    // d'ordine, che dell'id del cliente non sanno niente.
    expect(ordini?.select).toBe('id,shopify_order_id');
    expect(righe?.select).toBe('id');
  });

  it('fissa le chiavi di ogni tabella', async () => {
    const { client } = fakeSupabase(negozio());

    const { snapshot } = await materializeSubject(client, 'customers', '4021');

    expect(snapshot?.customers).toEqual(['cli-1']);
    expect(snapshot?.orders).toEqual(['ord-0000', 'ord-0001']);
    expect(snapshot?.orderLines).toEqual(['lin-0001']);
  });

  it('una tabella che non risponde: nessuna fotografia, e si riprova', async () => {
    // Una fotografia a meta' e' peggio di nessuna, perche' verrebbe usata come
    // se fosse intera.
    const { client } = fakeSupabase(negozio(), {
      errori: { orders: { code: '57014', message: 'statement timeout' } },
    });

    const { snapshot, steps } = await materializeSubject(client, 'customers', '4021');

    expect(snapshot).toBeNull();
    expect(stepsFailed(steps)).toBe(true);
  });

  it('se il database ne dichiara piu di quante ne consegna, non si fotografa', async () => {
    const { client } = fakeSupabase(negozio(), { conteggi: { orders: 1200 } });

    const { snapshot, steps } = await materializeSubject(client, 'customers', '4021');

    expect(snapshot).toBeNull();
    expect(step(steps, 'orders')?.detail).toContain('incompleta');
  });

  it('persona mai sincronizzata: fotografia vuota, non un errore', async () => {
    const { client } = fakeSupabase(negozio({ customers: [], orders: [], order_lines: [] }));

    const { snapshot, steps } = await materializeSubject(client, 'customers', '4021');

    expect(snapshot).toEqual({
      takenAt: expect.any(Date),
      customers: [],
      orders: [],
      orderLines: [],
      users: [],
    });
    expect(stepsFailed(steps)).toBe(false);
  });
});

describe('lo scaricamento della fotografia', () => {
  it('consegna cliente, ordini e righe degli ordini', async () => {
    const { client } = fakeSupabase(negozio());

    const { snapshot } = await materializeSubject(client, 'customers', '4021');
    const { data, steps } = await collectSubjectData(client, 'customers', snapshot!);

    expect(data.customer).toMatchObject({ email_address: 'chi@esempio.it' });
    expect(data.orders).toHaveLength(2);
    expect(data.order_lines).toHaveLength(1);
    expect(stepsFailed(steps)).toBe(false);
  });

  it('riprende ogni tabella per la sua chiave primaria', async () => {
    const { client, chiamate } = fakeSupabase(negozio());

    const { snapshot } = await materializeSubject(client, 'customers', '4021');
    chiamate.length = 0;
    await collectSubjectData(client, 'customers', snapshot!);

    expect(chiamate.find((c) => c.table === 'orders')?.column).toBe('id');
    expect(chiamate.find((c) => c.table === 'order_lines')?.column).toBe('id');
    // I browser hanno l'identificativo stesso come chiave primaria.
    expect(chiamate.filter((c) => c.table === 'users').map((c) => c.column)).not.toContain('id');
  });

  it('mille ordini escono tutti, non i primi cinquecento', async () => {
    const ordini = Array.from({ length: 1000 }, (_, i) => ordine(i));
    const { client } = fakeSupabase(negozio({ orders: ordini }));

    const { snapshot } = await materializeSubject(client, 'customers', '4021');
    const { data, steps } = await collectSubjectData(client, 'customers', snapshot!);

    expect(data.orders).toHaveLength(1000);
    expect(stepsFailed(steps)).toBe(false);
  });

  it('un progetto con un tetto piu basso della pagina non perde le righe in mezzo', async () => {
    const ordini = Array.from({ length: 350 }, (_, i) => ordine(i));
    const { client } = fakeSupabase(negozio({ orders: ordini }), { maxRows: { orders: 100 } });

    const { snapshot } = await materializeSubject(client, 'customers', '4021');
    const { data, steps } = await collectSubjectData(client, 'customers', snapshot!);

    expect(data.orders).toHaveLength(350);
    expect(stepsFailed(steps)).toBe(false);
  });

  it('le righe d ordine si chiedono a lotti quando gli ordini sono tanti', async () => {
    const ordini = Array.from({ length: 250 }, (_, i) => ordine(i));
    const { client, chiamate } = fakeSupabase(negozio({ orders: ordini }));

    await materializeSubject(client, 'customers', '4021');

    // 250 id, 100 per lotto: tre richieste, non una con un URL che il proxy
    // rifiuta. (Ogni lotto chiude con una pagina vuota, quindi non si contano
    // le richieste ma i lotti distinti.)
    const perLotto = chiamate.filter((c) => c.table === 'order_lines');
    expect(perLotto.length).toBeGreaterThanOrEqual(3);
  });
});

describe('il confronto fra la fotografia e cio che si e ripreso', () => {
  /**
   * IL CASO CHE IL SOLO CONTEGGIO NON VEDE. Fra la fotografia e lo scaricamento
   * una riga sparisce e un'altra compare: il totale torna, e le righe non sono
   * le stesse. Senza il confronto sulle chiavi, l'esportazione uscirebbe con
   * dentro una riga che nella fotografia non c'era, dichiarata coerente.
   */
  it('conteggi uguali ma chiavi diverse: il confronto fallisce', async () => {
    const { client, tabelle } = fakeSupabase(negozio());

    const { snapshot } = await materializeSubject(client, 'customers', '4021');

    // Uno esce, uno entra. Il conteggio resta due.
    tabelle.orders = [ordine(1), ordine(2)];

    const { steps } = await collectSubjectData(client, 'customers', snapshot!);

    expect(stepsFailed(steps)).toBe(true);
    expect(step(steps, 'orders')?.detail).toContain('cambiato durante l esportazione');
  });

  it('una riga sparita dopo la fotografia rende incoerente l esportazione', async () => {
    const { client, tabelle } = fakeSupabase(negozio());

    const { snapshot } = await materializeSubject(client, 'customers', '4021');
    tabelle.orders = [ordine(0)];

    const { steps } = await collectSubjectData(client, 'customers', snapshot!);

    expect(stepsFailed(steps)).toBe(true);
  });

  it('niente da riprendere non e una lettura da fare', async () => {
    // `.in()` con l'elenco vuoto e' un giro di rete per sapere una cosa che
    // sappiamo gia'.
    const { client, chiamate } = fakeSupabase(negozio({ orders: [], order_lines: [] }));

    const { snapshot } = await materializeSubject(client, 'customers', '4021');
    chiamate.length = 0;
    const { steps } = await collectSubjectData(client, 'customers', snapshot!);

    expect(chiamate.filter((c) => c.table === 'orders')).toHaveLength(0);
    expect(stepsFailed(steps)).toBe(false);
  });

  it('il messaggio dice i numeri, mai le chiavi', () => {
    // Una chiave di queste tabelle identifica una riga di una persona
    // identificata, e finirebbe in un log e in una traccia di controllo che per
    // regola non li contengono.
    const motivo = compareKeys(['ord-0001', 'ord-0002'], ['ord-0001', 'ord-0003']);

    expect(motivo).not.toBeNull();
    expect(motivo).not.toContain('ord-0002');
    expect(motivo).not.toContain('ord-0003');
    expect(motivo).toContain('1 non ci sono piu');
  });

  it('stesse chiavi in ordine diverso: nessuna divergenza', () => {
    expect(compareKeys(['a', 'b'], ['b', 'a'])).toBeNull();
  });
});
