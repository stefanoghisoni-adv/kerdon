import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MAX_MERGE_DEPTH,
  collectLinkedBrowsers,
  eraseBrowsersOfCustomer,
  resolveIdentityGraph,
} from './identity-graph.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Il grafo dei browser, quello che prima non veniva ne' consegnato ne'
 * cancellato.
 *
 * Le righe di `users` legano un browser a una persona, e si legano fra loro con
 * `merged_into` quando la stessa persona torna da un browser diverso. Finche'
 * questa tabella restava fuori dal GDPR succedevano due cose, entrambe brutte:
 * una richiesta di accesso non diceva alla persona da quali browser l'avevamo
 * riconosciuta, e una cancellazione lasciava righe vive che continuavano a
 * portare scritto il suo id Shopify.
 *
 * Il finto Supabase qui sotto tiene una tabella in memoria e risponde alle tre
 * sole forme di interrogazione che il modulo usa: per `shopify_customer_id`,
 * per `external_id` e per `merged_into`. Non e' un database, ed e' voluto: cio'
 * che va provato e' il percorso sul grafo, non PostgREST.
 */

interface Row {
  external_id: string;
  shopify_customer_id?: string | null;
  merged_into?: string | null;
}

interface Failures {
  select?: { code: string; message: string };
  update?: { code: string; message: string };
  delete?: { code: string; message: string };
}

function fakeSupabase(rows: Row[], failures: Failures = {}) {
  const table = [...rows];
  const log: string[] = [];

  const match = (column: string, values: string[]) =>
    table.filter((r) => {
      const value = (r as any)[column];
      return value !== null && value !== undefined && values.includes(String(value));
    });

  const client = {
    from: () => ({
      select: () => ({
        eq: async (column: string, value: string) => {
          log.push(`select ${column}`);
          if (failures.select) return { data: null, error: failures.select };
          return { data: match(column, [value]), error: null };
        },
        in: async (column: string, values: string[]) => {
          log.push(`select ${column} in`);
          if (failures.select) return { data: null, error: failures.select };
          return { data: match(column, values), error: null };
        },
      }),
      update: (values: Record<string, unknown>) => ({
        in: async (column: string, list: string[]) => {
          log.push(`update ${column}`);
          if (failures.update) return { data: null, error: failures.update, count: null };
          const hit = match(column, list);
          for (const row of hit) Object.assign(row, values);
          return { data: null, error: null, count: hit.length };
        },
      }),
      delete: () => ({
        in: async (column: string, list: string[]) => {
          log.push(`delete ${column}`);
          if (failures.delete) return { data: null, error: failures.delete, count: null };
          const hit = match(column, list);
          for (const row of hit) table.splice(table.indexOf(row), 1);
          return { data: null, error: null, count: hit.length };
        },
      }),
    }),
  };

  return { client: client as any, table, log };
}

const step = (steps: any[], table: string) => steps.find((s) => s.table === table);

let warnSpy: any;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('quante righe trova il grafo', () => {
  it('nessun browser: non e un errore, e una risposta', async () => {
    const { client } = fakeSupabase([]);
    const graph = await resolveIdentityGraph(client, '4021');

    expect(graph.ids).toEqual([]);
    expect(graph.step.outcome).toBe('read');
  });

  it('un browser solo', async () => {
    const { client } = fakeSupabase([{ external_id: 'a', shopify_customer_id: '4021' }]);
    const graph = await resolveIdentityGraph(client, '4021');

    expect(graph.ids).toEqual(['a']);
  });

  it('piu browser che portano lo stesso id: escono tutti', async () => {
    const { client } = fakeSupabase([
      { external_id: 'a', shopify_customer_id: '4021' },
      { external_id: 'b', shopify_customer_id: '4021' },
      { external_id: 'c', shopify_customer_id: '4021' },
      { external_id: 'estraneo', shopify_customer_id: '9999' },
    ]);
    const graph = await resolveIdentityGraph(client, '4021');

    expect(graph.ids.sort()).toEqual(['a', 'b', 'c']);
  });

  it('il browser anonimo unito a uno riconosciuto viene raggiunto', async () => {
    // Il caso vero: la persona ha navigato da Safari senza essere nessuno, poi
    // ha comprato da Chrome. La riga di Safari non porta l id Shopify, e senza
    // seguire `merged_into` all indietro resterebbe fuori da tutto.
    const { client } = fakeSupabase([
      { external_id: 'chrome', shopify_customer_id: '4021' },
      { external_id: 'safari', shopify_customer_id: null, merged_into: 'chrome' },
    ]);
    const graph = await resolveIdentityGraph(client, '4021');

    expect(graph.ids.sort()).toEqual(['chrome', 'safari']);
  });

  it('si sale anche in avanti, verso il canonico dichiarato', async () => {
    const { client } = fakeSupabase([
      { external_id: 'nuovo', shopify_customer_id: '4021', merged_into: 'vecchio' },
      { external_id: 'vecchio', shopify_customer_id: null },
    ]);
    const graph = await resolveIdentityGraph(client, '4021');

    expect(graph.ids.sort()).toEqual(['nuovo', 'vecchio']);
  });

  it('una catena di unioni si percorre fino in fondo', async () => {
    const { client } = fakeSupabase([
      { external_id: 'a', shopify_customer_id: '4021' },
      { external_id: 'b', merged_into: 'a' },
      { external_id: 'c', merged_into: 'b' },
      { external_id: 'd', merged_into: 'c' },
    ]);
    const graph = await resolveIdentityGraph(client, '4021');

    expect(graph.ids.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(graph.truncated).toBe(false);
  });

  it('un anello non fa girare a vuoto: si chiude e si dichiara', async () => {
    const { client } = fakeSupabase([
      { external_id: 'a', shopify_customer_id: '4021', merged_into: 'b' },
      { external_id: 'b', merged_into: 'a' },
    ]);
    const graph = await resolveIdentityGraph(client, '4021');

    expect(graph.ids.sort()).toEqual(['a', 'b']);
    expect(graph.truncated).toBe(false);
  });

  it(`oltre ${MAX_MERGE_DEPTH} salti ci si ferma e lo si dice`, async () => {
    // Una catena piu lunga del tetto. Chi legge la traccia deve sapere che il
    // percorso e stato interrotto, invece di leggere un conteggio che sembra
    // completo.
    const rows: Row[] = [{ external_id: 'n0', shopify_customer_id: '4021' }];
    for (let i = 1; i <= MAX_MERGE_DEPTH + 3; i++) {
      rows.push({ external_id: `n${i}`, merged_into: `n${i - 1}` });
    }
    const { client } = fakeSupabase(rows);
    const graph = await resolveIdentityGraph(client, '4021');

    expect(graph.truncated).toBe(true);
    expect(graph.step.detail).toContain('possibile anello');
  });

  it('una lettura fallita si dichiara fallita, non vuota', async () => {
    const { client } = fakeSupabase([{ external_id: 'a', shopify_customer_id: '4021' }], {
      select: { code: '57014', message: 'statement timeout' },
    });
    const graph = await resolveIdentityGraph(client, '4021');

    expect(graph.step.outcome).toBe('failed');
  });
});

describe('cosa esce in una richiesta di accesso', () => {
  it('le righe escono cosi come sono scritte', async () => {
    const { client } = fakeSupabase([
      { external_id: 'a', shopify_customer_id: '4021' },
      { external_id: 'b', merged_into: 'a' },
    ]);
    const { rows, step: read } = await collectLinkedBrowsers(client, '4021');

    expect(rows).toHaveLength(2);
    expect(read.rows).toBe(2);
  });

  it('persona senza browser: esportazione vuota, non un errore', async () => {
    const { client } = fakeSupabase([]);
    const { rows, step: read } = await collectLinkedBrowsers(client, '4021');

    expect(rows).toEqual([]);
    expect(read.outcome).not.toBe('failed');
  });
});

describe('cosa resta dopo la cancellazione', () => {
  it('nessuna riga sopravvive con l id della persona', async () => {
    const { client, table } = fakeSupabase([
      { external_id: 'a', shopify_customer_id: '4021' },
      { external_id: 'b', merged_into: 'a' },
      { external_id: 'estraneo', shopify_customer_id: '9999' },
    ]);
    const steps = await eraseBrowsersOfCustomer(client, '4021');

    expect(table.map((r) => r.external_id)).toEqual(['estraneo']);
    expect(steps.some((s) => s.outcome === 'failed')).toBe(false);
  });

  it("non si anonimizza: si cancella", async () => {
    // Svuotare `shopify_customer_id` e lasciare la riga non sarebbe una
    // cancellazione: l identificativo vive ancora dentro il browser di quella
    // persona, e la riga tornerebbe raggiungibile alla prima visita.
    const { client, table } = fakeSupabase([{ external_id: 'a', shopify_customer_id: '4021' }]);
    await eraseBrowsersOfCustomer(client, '4021');

    expect(table).toEqual([]);
  });

  it('i riferimenti che entravano nel gruppo dall esterno vengono sciolti', async () => {
    const { client, table, log } = fakeSupabase([
      { external_id: 'a', shopify_customer_id: '4021' },
      { external_id: 'fuori', merged_into: 'a' },
    ]);
    await eraseBrowsersOfCustomer(client, '4021');

    // `fuori` era nel gruppo e se n e andato con gli altri; cio che conta e che
    // lo scioglimento venga prima della cancellazione.
    expect(log.indexOf('update merged_into')).toBeLessThan(log.indexOf('delete external_id'));
    expect(table.every((r) => r.merged_into !== 'a')).toBe(true);
  });

  it('ripetere la cancellazione non fa danno ne rumore', async () => {
    const { client } = fakeSupabase([{ external_id: 'a', shopify_customer_id: '4021' }]);
    await eraseBrowsersOfCustomer(client, '4021');
    const second = await eraseBrowsersOfCustomer(client, '4021');

    expect(second.every((s) => s.outcome !== 'failed')).toBe(true);
    expect(second[0].rows).toBe(0);
  });

  it('lettura fallita: non si cancella al buio', async () => {
    // Cancellare per il solo id lascerebbe indietro proprio le righe che la
    // lettura non e riuscita a elencare: sembra fatto e non lo e.
    const { client, table } = fakeSupabase([{ external_id: 'a', shopify_customer_id: '4021' }], {
      select: { code: '57014', message: 'statement timeout' },
    });
    const steps = await eraseBrowsersOfCustomer(client, '4021');

    expect(steps.some((s) => s.outcome === 'failed')).toBe(true);
    expect(table).toHaveLength(1);
  });

  it('scioglimento fallito: non si cancella, cosi il ritentativo ritrova il grafo intero', async () => {
    const { client, table } = fakeSupabase([{ external_id: 'a', shopify_customer_id: '4021' }], {
      update: { code: '57014', message: 'statement timeout' },
    });
    const steps = await eraseBrowsersOfCustomer(client, '4021');

    expect(steps.some((s) => s.outcome === 'failed')).toBe(true);
    expect(table).toHaveLength(1);
  });

  it('cancellazione fallita: la richiesta risulta fallita', async () => {
    const { client } = fakeSupabase([{ external_id: 'a', shopify_customer_id: '4021' }], {
      delete: { code: '57014', message: 'statement timeout' },
    });
    const steps = await eraseBrowsersOfCustomer(client, '4021');

    expect(steps.some((s) => s.outcome === 'failed')).toBe(true);
  });

  it('tabella assente: niente da cancellare, e non e un guasto', async () => {
    const { client } = fakeSupabase([]);
    const steps = await eraseBrowsersOfCustomer(client, '4021');

    expect(steps).toHaveLength(1);
    expect(steps[0].outcome).toBe('skipped');
  });

  it('un grafo troppo profondo si segnala ma non fa fallire la richiesta', async () => {
    const rows: Row[] = [{ external_id: 'n0', shopify_customer_id: '4021' }];
    for (let i = 1; i <= MAX_MERGE_DEPTH + 3; i++) {
      rows.push({ external_id: `n${i}`, merged_into: `n${i - 1}` });
    }
    const { client } = fakeSupabase(rows);
    const steps = await eraseBrowsersOfCustomer(client, '4021');

    expect(steps.some((s) => s.outcome === 'failed')).toBe(false);
    expect(step(steps, 'users')?.detail ?? steps.at(-1)?.detail).toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
