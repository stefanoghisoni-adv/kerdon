// app/lib/webhooks/inbox-fake-store.ts
//
// Una posta in arrivo finta, con le due sole regole che contano davvero:
// l'indice unico su `webhook_id` e la presa condizionata sullo stato.
//
// Esiste perche' quelle due regole sono cio' che rende un evento consegnato due
// volte un effetto solo, e provarle con dei mock che dicono sempre di si'
// vorrebbe dire non provarle affatto. Non e' un mock: e' un'implementazione
// minima che rifiuta le stesse cose che rifiuta Postgres.
//
// Sta qui e non dentro un file di test perche' i file che ne hanno bisogno sono
// due — la posta in arrivo e la rotta che la usa — e una seconda copia sarebbe
// una copia libera di divergere proprio sulle regole che deve far rispettare.
// Non e' mai importata dal codice che gira in produzione.

export interface FakeWebhookRow {
  id: string;
  webhookId: string;
  topic: string;
  shopDomain: string;
  shopId: string | null;
  payload: unknown;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  receivedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Le colonne che questa posta in arrivo confronta con `lt`/`lte` sono tutte
 * istanti. Un valore assente diventa +Infinito, cosi' una riga senza data non
 * finisce mai per sbaglio dentro un "prima di": e' la stessa cosa che fa
 * Postgres, dove un confronto con NULL non e' vero.
 */
function istante(valore: unknown): number {
  if (valore instanceof Date) return valore.getTime();
  if (typeof valore === 'number') return valore;
  return Number.POSITIVE_INFINITY;
}

function corrisponde(riga: FakeWebhookRow, where: Record<string, unknown>): boolean {
  for (const [campo, atteso] of Object.entries(where)) {
    if (campo === 'OR') {
      const rami = atteso as Record<string, unknown>[];
      if (!rami.some((r) => corrisponde(riga, r))) return false;
      continue;
    }
    const valore = (riga as unknown as Record<string, unknown>)[campo];
    if (atteso !== null && typeof atteso === 'object') {
      const vincoli = atteso as Record<string, unknown>;
      if ('lt' in vincoli && !(istante(valore) < istante(vincoli.lt))) return false;
      if ('lte' in vincoli && !(istante(valore) <= istante(vincoli.lte))) return false;
      if ('in' in vincoli && !(vincoli.in as unknown[]).includes(valore)) return false;
      continue;
    }
    if (valore !== atteso) return false;
  }
  return true;
}

function applica(riga: FakeWebhookRow, data: Record<string, unknown>): void {
  for (const [campo, valore] of Object.entries(data)) {
    if (valore !== null && typeof valore === 'object' && 'increment' in (valore as object)) {
      const attuale = (riga as unknown as Record<string, number>)[campo] ?? 0;
      (riga as unknown as Record<string, number>)[campo] =
        attuale + (valore as { increment: number }).increment;
      continue;
    }
    (riga as unknown as Record<string, unknown>)[campo] = valore;
  }
}

export interface FakeWebhookStore {
  /** Le righe, per poterle guardare e manomettere dal test. */
  righe: FakeWebhookRow[];
  reset(): void;
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  findUnique(args: { where: Record<string, unknown> }): Promise<FakeWebhookRow | null>;
  findMany(args: {
    where?: Record<string, unknown>;
    take?: number;
  }): Promise<FakeWebhookRow[]>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<FakeWebhookRow>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

export function creaFakeWebhookStore(): FakeWebhookStore {
  const righe: FakeWebhookRow[] = [];
  let contatore = 0;

  return {
    righe,
    reset() {
      righe.length = 0;
      contatore = 0;
    },
    async create({ data }) {
      if (righe.some((r) => r.webhookId === data.webhookId)) {
        // Quello che Prisma lancia quando l'indice unico rifiuta la riga: e' il
        // caso su cui poggia tutta la deduplica, quindi il finto deve saperlo
        // fare esattamente come il vero.
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      const riga: FakeWebhookRow = {
        id: `evento-${++contatore}`,
        webhookId: data.webhookId as string,
        topic: data.topic as string,
        shopDomain: data.shopDomain as string,
        shopId: null,
        payload: data.payload,
        status: (data.status as string) ?? 'queued',
        attempts: 0,
        nextAttemptAt: new Date(0),
        lastError: null,
        receivedAt: new Date(contatore),
        startedAt: null,
        completedAt: null,
      };
      righe.push(riga);
      return { id: riga.id };
    },
    async findUnique({ where }) {
      return righe.find((r) => corrisponde(r, where)) ?? null;
    },
    async findMany({ where, take }) {
      const trovate = righe.filter((r) => (where ? corrisponde(r, where) : true));
      return (take ? trovate.slice(0, take) : trovate).map((r) => ({ ...r }));
    },
    async updateMany({ where, data }) {
      const colpite = righe.filter((r) => corrisponde(r, where));
      for (const riga of colpite) applica(riga, data);
      return { count: colpite.length };
    },
    async update({ where, data }) {
      const riga = righe.find((r) => corrisponde(r, where));
      if (!riga) throw new Error('riga assente');
      applica(riga, data);
      return { ...riga };
    },
    async deleteMany({ where }) {
      const colpite = righe.filter((r) => corrisponde(r, where));
      for (const riga of colpite) righe.splice(righe.indexOf(riga), 1);
      return { count: colpite.length };
    },
  };
}
