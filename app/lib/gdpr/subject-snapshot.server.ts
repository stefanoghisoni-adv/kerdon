// app/lib/gdpr/subject-snapshot.server.ts
//
// L'esportazione dei dati di una persona come fotografia di UN istante, invece
// che come lettura che scorre mentre il mondo si muove.
//
// IL GUASTO DA CUI NASCE. La raccolta faceva quattro letture in fila — cliente,
// ordini, righe d'ordine, browser — senza prendere il lucchetto del negozio.
// Una sincronizzazione avviata un istante prima scriveva proprio quelle
// tabelle: gli ordini uscivano com'erano alle 10:00, le loro righe com'erano
// alle 10:04, e il pacchetto consegnato al titolare del negozio metteva insieme
// due momenti diversi presentandoli come uno. Nel caso peggiore usciva un
// ordine i cui articoli non c'erano ancora, o degli articoli il cui ordine era
// gia' stato riscritto: un'esportazione internamente incoerente, che pero' a
// chi la legge sembra a posto.
//
// IL RIMEDIO, E DOV'E' IL CONFINE. Il lucchetto si prende per la
// MATERIALIZZAZIONE, non per lo scaricamento. Sotto lucchetto si legge una cosa
// sola e piccola: QUALI righe sono della persona, cioe' l'elenco delle loro
// chiavi. Quella e' la fotografia, e dura una manciata di richieste. Poi il
// lucchetto si molla e le righe si vanno a prendere per chiave, con calma,
// mentre la sincronizzazione riprende a lavorare.
//
// Tenere il lucchetto per tutto lo scaricamento sarebbe stato piu' semplice da
// scrivere e sbagliato da usare: un negozio con centomila righe d'ordine
// resterebbe fermo per minuti — niente sincronizzazione, niente webhook
// lavorati — ogni volta che qualcuno chiede i propri dati. Un diritto di
// accesso non deve costare al merchant l'indisponibilita' del suo negozio.
//
// PERCHE' IL CONFRONTO E' SU CONTEGGI *E* CHIAVI. Fra la fotografia e lo
// scaricamento passa del tempo, e in quel tempo qualcosa puo' cambiare. Un
// controllo sul solo numero di righe non se ne accorge: se una riga sparisce e
// un'altra entra, il totale torna e le righe non sono le stesse. Si confronta
// quindi l'insieme delle chiavi lette con quello fotografato, e se non
// coincidono la richiesta fallisce e si ritenta da capo — con una fotografia
// nuova. Meglio un'esportazione ritentata di una che mescola due istanti.
//
// PERCHE' NON UNA TABELLA NUOVA PER LA FOTOGRAFIA. Perche' non deve
// sopravvivere al tentativo: e' un elenco di chiavi valido per l'istante in cui
// e' stato preso, e un tentativo successivo non deve riusarlo — deve rifarlo.
// Scriverlo da qualche parte vorrebbe dire conservare, per giorni, l'elenco
// degli ordini di una persona identificata, cioe' aggiungere una copia dei suoi
// dati proprio nel modulo che esiste per consegnargliene una sola. Vive in
// memoria quanto il tentativo, e con il tentativo se ne va.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GdprStep } from './steps';
import { pagedStep, readAllByEq, readAllByIn, type PagedTable } from './paged-read';
import { orderKeyOf } from './subject-keys';
import { resolveIdentityGraph, USERS_TABLE } from './identity-graph.server';
import {
  ORDERS_TABLE,
  ORDER_LINES_TABLE,
  emptyCustomerDataPackage,
  type CustomerDataPackage,
} from './customer-record.server';

/**
 * Le chiavi delle righe che riguardano la persona, in un istante solo.
 *
 * Chiavi e non righe: sotto il lucchetto si sta fermo il meno possibile, e le
 * chiavi sono l'unica cosa che serve per andare a riprendere il resto.
 */
export interface SubjectSnapshot {
  takenAt: Date;
  customers: string[];
  orders: string[];
  orderLines: string[];
  users: string[];
}

export interface SubjectMaterialization {
  /** Null quando una delle letture non e' riuscita: la fotografia non c'e'. */
  snapshot: SubjectSnapshot | null;
  steps: GdprStep[];
}

const table = (id: PagedTable['id'], name: string): PagedTable => ({ id, name });

/**
 * La fotografia. Va chiamata SOTTO il lucchetto del negozio.
 *
 * Non lo prende lei, e non e' una dimenticanza: il lucchetto e' del negozio,
 * non della lettura, e chi lo tiene deve poterci fare anche altro dentro —
 * verificarne il possesso, decidere cosa fare se e' occupato. Qui resta il
 * lavoro, e chi chiama porta il titolo per farlo.
 *
 * Si esce alla prima lettura fallita senza fotografia: una fotografia a meta'
 * e' peggio di nessuna, perche' verrebbe usata come se fosse intera.
 */
export async function materializeSubject(
  supabase: SupabaseClient,
  customersTable: string,
  customerId: string,
  now: Date = new Date(),
): Promise<SubjectMaterialization> {
  const steps: GdprStep[] = [];
  const clienti = table('customers', customersTable);
  const ordini = table('orders', ORDERS_TABLE);
  const righe = table('order_lines', ORDER_LINES_TABLE);

  // Le sole chiavi, mai le righe intere: e' cio' che tiene corta la finestra in
  // cui il negozio e' fermo.
  const lettureClienti = await readAllByEq(
    supabase,
    clienti,
    'shopify_customer_id',
    customerId,
    orderKeyOf(clienti.id),
  );
  const passoClienti = pagedStep(customersTable, lettureClienti);
  steps.push(passoClienti);
  if (passoClienti.outcome === 'failed') return { snapshot: null, steps };

  // Degli ordini serve anche `shopify_order_id`: e' la strada per le righe
  // d'ordine, che dell'id del cliente non sanno niente.
  const lettureOrdini = await readAllByEq(
    supabase,
    ordini,
    'shopify_customer_id',
    customerId,
    `${orderKeyOf(ordini.id)},shopify_order_id`,
  );
  const passoOrdini = pagedStep(ORDERS_TABLE, lettureOrdini);
  steps.push(passoOrdini);
  if (passoOrdini.outcome === 'failed') return { snapshot: null, steps };

  const idOrdini = lettureOrdini.rows
    .map((riga) => riga.shopify_order_id)
    .filter((id): id is string | number => id !== null && id !== undefined);

  let chiaviRighe: string[] = [];
  if (idOrdini.length === 0) {
    steps.push({
      table: ORDER_LINES_TABLE,
      outcome: 'skipped',
      rows: 0,
      detail: 'nessun ordine da cui partire',
    });
  } else {
    const lettureRighe = await readAllByIn(
      supabase,
      righe,
      'shopify_order_id',
      idOrdini,
      orderKeyOf(righe.id),
    );
    const passoRighe = pagedStep(ORDER_LINES_TABLE, lettureRighe);
    steps.push(passoRighe);
    if (passoRighe.outcome === 'failed') return { snapshot: null, steps };
    chiaviRighe = lettureRighe.keys;
  }

  // I browser: si arriva alle righe indirette seguendo `merged_into`, quindi
  // non basta la lettura per `shopify_customer_id` che si farebbe d'istinto. Il
  // percorso sul grafo sta in identity-graph, e anche lui va fatto qui dentro:
  // e' una lettura del soggetto come le altre, e fuori dal lucchetto potrebbe
  // seguire un legame che nel frattempo e' stato riscritto.
  const grafo = await resolveIdentityGraph(supabase, customerId);
  steps.push(grafo.step);
  if (grafo.step.outcome === 'failed') return { snapshot: null, steps };

  return {
    snapshot: {
      takenAt: now,
      customers: lettureClienti.keys,
      orders: lettureOrdini.keys,
      orderLines: chiaviRighe,
      users: grafo.ids,
    },
    steps,
  };
}

/**
 * Le righe della fotografia, riprese per chiave. Va chiamata FUORI dal
 * lucchetto: e' la parte lunga, ed e' quella che il negozio non deve aspettare.
 *
 * Ogni tabella si legge per la sua chiave primaria e si confronta con l'elenco
 * fotografato. Il confronto e' su due cose, e servono entrambe:
 *
 *   - il conteggio, che dice se ne mancano;
 *   - l'identita' delle chiavi, che dice se sono LE STESSE. Una riga sparita e
 *     una comparsa lasciano il conteggio dov'era, e senza questo confronto
 *     l'esportazione uscirebbe con dentro una riga che nella fotografia non
 *     c'era, dichiarata coerente.
 */
export async function collectSubjectData(
  supabase: SupabaseClient,
  customersTable: string,
  snapshot: SubjectSnapshot,
): Promise<{ data: CustomerDataPackage; steps: GdprStep[] }> {
  const pack: CustomerDataPackage = emptyCustomerDataPackage();
  const steps: GdprStep[] = [];

  const clienti = await hydrate(supabase, table('customers', customersTable), snapshot.customers);
  pack.customer = (clienti.rows[0] ?? null) as Record<string, unknown> | null;
  steps.push(clienti.step);

  const ordini = await hydrate(supabase, table('orders', ORDERS_TABLE), snapshot.orders);
  pack.orders = ordini.rows;
  steps.push(ordini.step);

  const righe = await hydrate(
    supabase,
    table('order_lines', ORDER_LINES_TABLE),
    snapshot.orderLines,
  );
  pack.order_lines = righe.rows;
  steps.push(righe.step);

  const browser = await hydrate(supabase, table('users', USERS_TABLE), snapshot.users);
  pack.browsers = browser.rows;
  steps.push(browser.step);

  return { data: pack, steps };
}

/**
 * Una tabella ripresa per chiave, e il verdetto sul confronto.
 *
 * Zero chiavi non e' una lettura da fare: `.in()` con l'elenco vuoto e' una
 * query che non puo' che tornare vuota, e chiederla al progetto del merchant
 * sarebbe un giro di rete per sapere una cosa che sappiamo gia'.
 */
async function hydrate(
  supabase: SupabaseClient,
  source: PagedTable,
  chiavi: readonly string[],
): Promise<{ rows: Record<string, unknown>[]; step: GdprStep }> {
  if (chiavi.length === 0) {
    return {
      rows: [],
      step: {
        table: source.name,
        outcome: 'read',
        rows: 0,
        detail: 'nessuna riga di questa persona al momento della fotografia',
      },
    };
  }

  const key = orderKeyOf(source.id);
  const read = await readAllByIn(supabase, source, key, chiavi);
  const passo = pagedStep(source.name, read);
  if (passo.outcome === 'failed' || passo.outcome === 'skipped') {
    return { rows: read.rows, step: passo };
  }

  const divergenza = compareKeys(chiavi, read.keys);
  if (divergenza) {
    return {
      rows: read.rows,
      step: { table: source.name, outcome: 'failed', rows: read.rows.length, detail: divergenza },
    };
  }

  return { rows: read.rows, step: passo };
}

/**
 * Cosa e' cambiato fra la fotografia e la ripresa, o null se niente.
 *
 * Il messaggio dice i NUMERI, mai le chiavi: una chiave di questa tabella e'
 * l'identificativo di una riga di una persona identificata, e finirebbe in un
 * log e in una traccia di controllo che per regola non li contengono.
 */
export function compareKeys(atteso: readonly string[], letto: readonly string[]): string | null {
  const fotografate = new Set(atteso);
  const riprese = new Set(letto);

  let mancanti = 0;
  for (const chiave of fotografate) if (!riprese.has(chiave)) mancanti++;

  let inPiu = 0;
  for (const chiave of riprese) if (!fotografate.has(chiave)) inPiu++;

  if (mancanti === 0 && inPiu === 0) return null;

  return (
    `fotografate ${fotografate.size} righe, riprese ${riprese.size}: ` +
    `${mancanti} non ci sono piu' e ${inPiu} non c'erano. ` +
    'Il database e cambiato durante l esportazione: si rifa da capo'
  );
}
