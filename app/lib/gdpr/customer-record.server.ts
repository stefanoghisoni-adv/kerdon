// app/lib/gdpr/customer-record.server.ts
//
// Tutto quello che di una persona resta scritto da qualche parte, e cosa
// farne quando Shopify ci dice che quella persona ha chiesto i suoi dati o la
// loro cancellazione.
//
// Il punto di partenza e' un elenco, e va tenuto aggiornato: cancellare "il
// cliente" non vuol dire cancellare una riga della tabella clienti, vuol dire
// togliere il riferimento alla persona da ogni tabella che ce l'ha. Finche'
// una sola tabella lo conserva, l'erasure non e' avvenuto.
//
// Dove sta il riferimento, database per database:
//
//   nel progetto del merchant
//     customers     shopify_customer_id + nome, cognome, email, telefono,
//                   indirizzo, data di nascita → dato personale puro
//     orders        shopify_customer_id + customer_first_name/last_name
//     order_lines   nessun riferimento alla persona: pendono da
//                   shopify_order_id, e dentro hanno prodotto, quantita',
//                   prezzo. Anonimizzato l'ordine, la riga non e' piu'
//                   riconducibile a nessuno.
//
//   nel nostro database
//     sync_job_events   righe storiche con entity='customer' e l'id Shopify
//                       della persona (oggi il tipo non le lascia piu'
//                       scrivere, ma le vecchie sono li')
//     sync_jobs.errors  il JSON di un fallimento poteva portarsi dentro il
//                       customer_id in chiaro
//     customer_data_access_logs  niente: per come e' fatto, quel registro
//                       tiene esito e stato HTTP e nient'altro
//
// LA SCELTA SUGLI ORDINI: si anonimizzano, non si cancellano.
//
// Cancellare gli ordini di una persona vorrebbe dire cancellare le vendite dal
// database del merchant: il fatturato di quei giorni cambierebbe, e con lui il
// profitto per prodotto, le medie, i totali dell'anno. Il merchant ha
// l'obbligo di conservare quelle scritture — sono documenti contabili e
// fiscali — e il GDPR lo dice esplicitamente: il diritto alla cancellazione
// non si applica quando il trattamento serve ad adempiere un obbligo legale o
// ad accertare un diritto in giudizio (art. 17(3), lettere b ed e).
//
// Quello che va tolto e' il legame con la persona, non il fatto che una
// vendita sia avvenuta. Si azzerano quindi shopify_customer_id, nome e
// cognome: la riga resta e continua a contare nei totali, ma diventa
// indistinguibile da un acquisto fatto senza account — un caso che la tabella
// gia' prevede (shopify_customer_id e' nullable proprio per gli ordini come
// ospite) e che tutte le query trattano correttamente, perche' l'indice per
// cliente e' parziale su WHERE shopify_customer_id IS NOT NULL.
//
// Il risultato e' quello che il GDPR chiede davvero: nessun dato che riporti
// alla persona, e nessuna contabilita' distrutta per ottenerlo.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';

/**
 * Cos'e' successo a una tabella. Una richiesta GDPR e' fatta di piu' passi su
 * database diversi, e l'unica risposta onesta e' l'elenco di come e' andato
 * ognuno: e' quello che finisce nella traccia di controllo, ed e' quello che
 * decide se rispondere "fatto" oppure no.
 */
export interface GdprStep {
  /** Nome della tabella nel database, come si chiama davvero. */
  table: string;
  /**
   * 'deleted'    righe cancellate
   * 'anonymized' righe rimaste, riferimento alla persona rimosso
   * 'read'       righe lette per comporre l'esportazione
   * 'skipped'    niente da fare qui, e il perche' sta in `detail`
   * 'failed'     non riuscito: la richiesta NON e' completa
   */
  outcome: 'deleted' | 'anonymized' | 'read' | 'skipped' | 'failed';
  /** Quante righe sono state toccate, o lette. */
  rows: number;
  /** Il perche', quando l'esito da solo non basta a capirlo. */
  detail?: string;
}

/**
 * Basta un passo fallito perche' la richiesta sia fallita.
 *
 * E' la regola che impedisce a una cancellazione parziale di passare per
 * riuscita: se la tabella clienti si e' svuotata ma gli ordini portano ancora
 * il nome della persona, quello che e' successo non e' un erasure.
 */
export function stepsFailed(steps: GdprStep[]): boolean {
  return steps.some((step) => step.outcome === 'failed');
}

/** Riassunto leggibile dei soli passi andati male. */
export function failureMessage(steps: GdprStep[]): string {
  return steps
    .filter((step) => step.outcome === 'failed')
    .map((step) => `${step.table}: ${step.detail ?? 'errore sconosciuto'}`)
    .join('; ');
}

// I nomi che la DDL crea per ordini e righe. Non sono configurabili come lo e'
// la tabella clienti: chi scrive gli ordini (webhook e sync) li usa cablati, e
// qui si deve leggere esattamente dove si e' scritto.
export const ORDERS_TABLE = 'orders';
export const ORDER_LINES_TABLE = 'order_lines';

// Le colonne degli ordini che riportano alla persona: sono queste tre e
// basta — indirizzi, email e note negli ordini non li abbiamo mai copiati.
const ANONYMOUS_ORDER = {
  shopify_customer_id: null,
  customer_first_name: null,
  customer_last_name: null,
};

interface QueryError {
  message?: string;
  code?: string;
}

/**
 * La tabella non c'e'.
 *
 * Succede per davvero e non e' un guasto: gli ordini esistono solo se il
 * negozio ci ha dato il permesso di leggerli, i clienti solo se il piano li
 * include. Una tabella che non e' mai stata creata non contiene dati della
 * persona, quindi non c'e' niente da cancellare e la richiesta non deve
 * fallire per questo. Ogni altro errore, invece, e' un fallimento vero.
 */
function isTableMissing(error: QueryError | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const message = error.message ?? '';
  // 42P01 e' l'"undefined_table" di Postgres; PGRST205 e' il modo in cui l'API
  // REST dice che la tabella non e' nella sua copia dello schema.
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /does not exist|could not find the table/i.test(message)
  );
}

function toStep(
  table: string,
  done: GdprStep['outcome'],
  result: { error?: QueryError | null; count?: number | null },
): GdprStep {
  if (result.error) {
    if (isTableMissing(result.error)) {
      return {
        table,
        outcome: 'skipped',
        rows: 0,
        detail: 'tabella non presente in questo progetto',
      };
    }
    return {
      table,
      outcome: 'failed',
      rows: 0,
      detail: result.error.message ?? result.error.code ?? 'errore sconosciuto',
    };
  }
  return { table, outcome: done, rows: result.count ?? 0 };
}

/**
 * Toglie la persona dal database del merchant.
 *
 * Ripetibile senza danno: Shopify ritenta i webhook che non rispondono 200, e
 * una seconda passata trova zero righe da cancellare e zero da anonimizzare
 * invece di rompere qualcosa. E' il motivo per cui si lavora per id e non per
 * differenza.
 */
export async function eraseCustomerFromMerchant(
  supabase: SupabaseClient,
  customersTable: string,
  customerId: string,
): Promise<GdprStep[]> {
  const steps: GdprStep[] = [];

  // I clienti si cancellano e basta: quella tabella esiste per il marketing,
  // e per il marketing non c'e' nessun interesse legittimo che sopravviva a
  // una richiesta di cancellazione.
  const deleted = await supabase
    .from(customersTable)
    .delete({ count: 'exact' })
    .eq('shopify_customer_id', customerId);
  steps.push(toStep(customersTable, 'deleted', deleted));

  // Gli ordini restano, senza piu' la persona dentro (il perche' e' in cima al
  // file). Si tenta sempre, anche se oggi il negozio non ha piu' il permesso
  // sugli ordini: le righe scritte quando ce l'aveva sono ancora li'.
  const anonymized = await supabase
    .from(ORDERS_TABLE)
    .update(ANONYMOUS_ORDER, { count: 'exact' })
    .eq('shopify_customer_id', customerId);
  steps.push(toStep(ORDERS_TABLE, 'anonymized', anonymized));

  // Le righe d'ordine si dichiarano lo stesso, con zero lavoro fatto: chi
  // legge la traccia deve vedere che la tabella e' stata considerata e perche'
  // e' stata lasciata stare, non doverlo dedurre dal silenzio.
  steps.push({
    table: ORDER_LINES_TABLE,
    outcome: 'skipped',
    rows: 0,
    detail:
      'nessun riferimento alla persona: le righe pendono da shopify_order_id, ' +
      'e l ordine e appena stato anonimizzato',
  });

  return steps;
}

/** L'esportazione: tutto quello che il database del merchant sa della persona. */
export interface CustomerDataPackage {
  customer: Record<string, unknown> | null;
  orders: Record<string, unknown>[];
  order_lines: Record<string, unknown>[];
}

/**
 * Raccoglie i dati della persona per una richiesta di accesso.
 *
 * Le stesse tabelle della cancellazione, lette invece che svuotate: se una
 * tabella conta per l'erasure conta anche qui, altrimenti staremmo
 * consegnando meno di quello che teniamo.
 *
 * Le righe d'ordine si raggiungono passando per gli ordini: non hanno l'id del
 * cliente, ma dicono cosa la persona ha comprato, e quella e' informazione che
 * la riguarda.
 */
export async function collectCustomerData(
  supabase: SupabaseClient,
  customersTable: string,
  customerId: string,
): Promise<{ data: CustomerDataPackage; steps: GdprStep[] }> {
  const steps: GdprStep[] = [];
  const pack: CustomerDataPackage = { customer: null, orders: [], order_lines: [] };

  const customers = await supabase
    .from(customersTable)
    .select('*')
    .eq('shopify_customer_id', customerId);
  // Volutamente senza .single(): una persona che non abbiamo mai sincronizzato
  // — perche' non ha dato consenso al marketing, o perche' il piano non include
  // i clienti — non e' un errore da far ritentare a Shopify. E' una risposta
  // legittima, ed e' "di questa persona non abbiamo niente".
  const customerRows = (customers.data ?? []) as Record<string, unknown>[];
  pack.customer = customerRows[0] ?? null;
  steps.push(
    toStep(customersTable, 'read', { error: customers.error, count: customerRows.length }),
  );

  const orders = await supabase
    .from(ORDERS_TABLE)
    .select('*')
    .eq('shopify_customer_id', customerId);
  pack.orders = (orders.data ?? []) as Record<string, unknown>[];
  steps.push(toStep(ORDERS_TABLE, 'read', { error: orders.error, count: pack.orders.length }));

  const orderIds = pack.orders
    .map((order) => order.shopify_order_id)
    .filter((id): id is string | number => id !== null && id !== undefined);

  if (orderIds.length === 0) {
    steps.push({
      table: ORDER_LINES_TABLE,
      outcome: 'skipped',
      rows: 0,
      detail: 'nessun ordine da cui partire',
    });
  } else {
    const lines = await supabase
      .from(ORDER_LINES_TABLE)
      .select('*')
      .in('shopify_order_id', orderIds);
    pack.order_lines = (lines.data ?? []) as Record<string, unknown>[];
    steps.push(
      toStep(ORDER_LINES_TABLE, 'read', { error: lines.error, count: pack.order_lines.length }),
    );
  }

  return { data: pack, steps };
}

/**
 * La stessa cancellazione, nel nostro database.
 *
 * E' la meta' che si dimentica: i dati della persona stanno nel progetto del
 * merchant, ma qualche riferimento e' finito anche da noi, nel registro delle
 * sincronizzazioni. Poco, e per lo piu' storico — ma "poco" non e' una
 * categoria che il GDPR conosca.
 *
 * `ref` e' l'impronta con cui il customer_id in chiaro viene sostituito nelle
 * righe di controllo: la riga continua a dire che quel fallimento riguardava
 * una persona precisa, senza piu' dire quale.
 */
export async function eraseCustomerFromAppDatabase(
  shopId: string,
  customerId: string,
  ref: string,
): Promise<GdprStep[]> {
  const steps: GdprStep[] = [];

  // Righe di dettaglio con l'id Shopify della persona. Oggi il collettore
  // accetta solo entity 'product', ma le corse vecchie hanno lasciato righe
  // 'customer' e quelle vanno via.
  try {
    const numeric = /^\d+$/.test(customerId) ? BigInt(customerId) : null;
    if (numeric === null) {
      steps.push({
        table: 'sync_job_events',
        outcome: 'skipped',
        rows: 0,
        detail: 'id cliente non numerico: nessuna riga puo corrispondere',
      });
    } else {
      const removed = await prisma.syncJobEvent.deleteMany({
        where: { entity: 'customer', shopifyId: numeric, syncJob: { shopId } },
      });
      steps.push({ table: 'sync_job_events', outcome: 'deleted', rows: removed.count });
    }
  } catch (error) {
    steps.push({
      table: 'sync_job_events',
      outcome: 'failed',
      rows: 0,
      detail: error instanceof Error ? error.message : 'errore sconosciuto',
    });
  }

  // Il customer_id in chiaro dentro sync_jobs.errors: ce lo abbiamo messo noi,
  // registrando i fallimenti delle richieste GDPR precedenti. Non si cancella
  // la riga — e' la prova che quella richiesta e' arrivata ed e' andata male —
  // si toglie l'identificatore e si lascia l'impronta.
  try {
    const marked = await prisma.syncJob.findMany({
      where: {
        shopId,
        OR: [
          // Puo' essere stato salvato come numero o come stringa, a seconda di
          // com'e' arrivato nel payload: si cercano tutti e due.
          { errors: { path: ['customer_id'], equals: Number(customerId) } },
          { errors: { path: ['customer_id'], equals: customerId } },
        ],
      },
      select: { id: true, errors: true },
    });

    for (const job of marked) {
      const previous =
        job.errors && typeof job.errors === 'object' && !Array.isArray(job.errors)
          ? (job.errors as Record<string, unknown>)
          : {};
      const { customer_id: _dropped, ...rest } = previous;
      await prisma.syncJob.update({
        where: { id: job.id },
        data: { errors: { ...rest, customer_ref: ref } as Prisma.InputJsonValue },
      });
    }

    steps.push({ table: 'sync_jobs', outcome: 'anonymized', rows: marked.length });
  } catch (error) {
    steps.push({
      table: 'sync_jobs',
      outcome: 'failed',
      rows: 0,
      detail: error instanceof Error ? error.message : 'errore sconosciuto',
    });
  }

  // Il registro degli accessi non ha niente da cancellare, ed e' un pregio del
  // suo disegno, non una dimenticanza: tiene chi ha letto, com'e' andata e
  // quando, mai il dato letto ne' la query. Si dichiara comunque, perche' una
  // tabella che si chiama "accessi ai dati dei clienti" e non compare nella
  // traccia sembra una tabella dimenticata.
  steps.push({
    table: 'customer_data_access_logs',
    outcome: 'skipped',
    rows: 0,
    detail: 'per costruzione non contiene identificatori delle persone',
  });

  return steps;
}
