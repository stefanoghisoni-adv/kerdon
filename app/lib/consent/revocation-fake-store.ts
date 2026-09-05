// app/lib/consent/revocation-fake-store.ts
//
// Un registro delle revoche finto, con le tre sole regole che contano davvero:
// l'indice unico sull'impronta, la presa condizionata su stato e lease, e il
// rifiuto di scrivere per chi il lease non ce l'ha piu'.
//
// Esiste perche' quelle tre regole sono cio' che rende due revoche identiche un
// lavoro solo e cio' che impedisce a un'invocazione sopravvissuta a un deploy
// di dichiarare applicata una revoca che sta applicando un altro. Provarle con
// dei mock che dicono sempre di si' vorrebbe dire non provarle affatto. Non e'
// un mock: e' un'implementazione minima che rifiuta le stesse cose che rifiuta
// Postgres.
//
// E' la stessa forma di `webhooks/inbox-fake-store`, ed e' voluto: due registri
// con la stessa struttura si provano nello stesso modo. Non e' mai importata
// dal codice che gira in produzione.

export interface FakeRevocationRow {
  id: string;
  shopId: string | null;
  scope: string;
  idempotencyKey: string;
  subjectCipher: string | null;
  customerCipher: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  steps: unknown;
  lastError: string | null;
  requestedAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  subjectPurgedAt: Date | null;
}

/**
 * I confronti temporali trattano l'assenza come +Infinito, cosi' una riga senza
 * data non finisce mai per sbaglio dentro un "prima di": e' la stessa cosa che
 * fa Postgres, dove un confronto con NULL non e' vero.
 */
function istante(valore: unknown): number {
  if (valore instanceof Date) return valore.getTime();
  if (typeof valore === 'number') return valore;
  return Number.POSITIVE_INFINITY;
}

function corrisponde(riga: FakeRevocationRow, where: Record<string, unknown>): boolean {
  for (const [campo, atteso] of Object.entries(where)) {
    if (campo === 'OR') {
      const rami = atteso as Record<string, unknown>[];
      if (!rami.some((r) => corrisponde(riga, r))) return false;
      continue;
    }
    const valore = (riga as unknown as Record<string, unknown>)[campo];
    if (atteso !== null && typeof atteso === 'object' && !(atteso instanceof Date)) {
      const vincoli = atteso as Record<string, unknown>;
      if ('lt' in vincoli && !(istante(valore) < istante(vincoli.lt))) return false;
      if ('lte' in vincoli && !(istante(valore) <= istante(vincoli.lte))) return false;
      if ('in' in vincoli && !(vincoli.in as unknown[]).includes(valore)) return false;
      // `{ not: null }`: la colonna c'e' ancora. E' il filtro con cui il replay
      // tiene fuori le revoche a cui la ritenzione ha gia' portato via il
      // soggetto, e senza il quale rimetterebbe in lavorazione roba
      // irripetibile.
      if ('not' in vincoli && valore === vincoli.not) return false;
      continue;
    }
    if (valore !== atteso) return false;
  }
  return true;
}

function applica(riga: FakeRevocationRow, data: Record<string, unknown>, adesso: Date): void {
  for (const [campo, valore] of Object.entries(data)) {
    if (valore !== null && typeof valore === 'object' && 'increment' in (valore as object)) {
      const attuale = (riga as unknown as Record<string, number>)[campo] ?? 0;
      (riga as unknown as Record<string, number>)[campo] =
        attuale + (valore as { increment: number }).increment;
      continue;
    }
    (riga as unknown as Record<string, unknown>)[campo] = valore;
  }
  // `@updatedAt` lo scrive Prisma da se': la potatura della ritenzione breve
  // guarda proprio quella colonna, quindi il finto deve muoverla come il vero.
  riga.updatedAt = adesso;
}

/**
 * La proiezione di `select`.
 *
 * Non e' un dettaglio da finto diligente: `listDeadRevocations` seleziona le
 * colonne una per una PROPRIO per non far uscire il soggetto cifrato, e un
 * finto che restituisce la riga intera renderebbe quella scelta non provabile.
 */
function proietta(
  riga: FakeRevocationRow,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) return { ...riga };
  const fuori: Record<string, unknown> = {};
  for (const [campo, voluto] of Object.entries(select)) {
    if (voluto) fuori[campo] = (riga as unknown as Record<string, unknown>)[campo];
  }
  return fuori;
}

export interface FakeRevocationStore {
  /** Le righe, per poterle guardare e manomettere dal test. */
  righe: FakeRevocationRow[];
  /**
   * L'orologio del finto: e' l'istante che finisce in `requestedAt` alla
   * creazione e in `updatedAt` a ogni scrittura. Serve perche' la ritenzione
   * breve del soggetto si misura proprio da `updatedAt`, e righe nate
   * all'epoca zero sarebbero gia' scadute prima di esistere.
   */
  orologio: Date;
  reset(): void;
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  findUnique(args: {
    where: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<Record<string, unknown> | null>;
  findMany(args: {
    where?: Record<string, unknown>;
    take?: number;
    select?: Record<string, boolean>;
  }): Promise<Record<string, unknown>[]>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

export function creaFakeRevocationStore(): FakeRevocationStore {
  const righe: FakeRevocationRow[] = [];
  let contatore = 0;

  const store: FakeRevocationStore = {
    righe,
    orologio: new Date(0),
    reset() {
      righe.length = 0;
      contatore = 0;
    },
    async create({ data }) {
      if (righe.some((r) => r.idempotencyKey === data.idempotencyKey)) {
        // Quello che Prisma lancia quando l'indice unico rifiuta la riga: e' il
        // caso su cui poggia tutta la deduplica, quindi il finto deve saperlo
        // fare esattamente come il vero.
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      contatore++;
      const riga: FakeRevocationRow = {
        id: `revoca-${contatore}`,
        shopId: (data.shopId as string) ?? null,
        scope: data.scope as string,
        idempotencyKey: data.idempotencyKey as string,
        subjectCipher: (data.subjectCipher as string) ?? null,
        customerCipher: (data.customerCipher as string) ?? null,
        status: (data.status as string) ?? 'queued',
        attempts: 0,
        nextAttemptAt: new Date(0),
        leaseOwner: null,
        leaseExpiresAt: null,
        steps: null,
        lastError: null,
        requestedAt: new Date(store.orologio.getTime() + contatore),
        updatedAt: new Date(store.orologio.getTime() + contatore),
        startedAt: null,
        completedAt: null,
        subjectPurgedAt: null,
      };
      righe.push(riga);
      return { id: riga.id };
    },
    async findUnique({ where, select }) {
      const riga = righe.find((r) => corrisponde(r, where));
      return riga ? proietta(riga, select) : null;
    },
    async findMany({ where, take, select }) {
      const trovate = righe.filter((r) => (where ? corrisponde(r, where) : true));
      return (take ? trovate.slice(0, take) : trovate).map((r) => proietta(r, select));
    },
    async updateMany({ where, data }) {
      const colpite = righe.filter((r) => corrisponde(r, where));
      for (const riga of colpite) applica(riga, data, store.orologio);
      return { count: colpite.length };
    },
    async deleteMany({ where }) {
      const colpite = righe.filter((r) => corrisponde(r, where));
      for (const riga of colpite) righe.splice(righe.indexOf(riga), 1);
      return { count: colpite.length };
    },
  };

  return store;
}
