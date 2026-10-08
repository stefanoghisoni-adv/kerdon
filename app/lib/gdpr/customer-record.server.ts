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
//     orders        shopify_customer_id + customer_first_name/last_name,
//                   e shipping_country_code (ricavato dall'indirizzo di
//                   spedizione). Gli altri dati logistici descrivono il
//                   pacco, non la persona: vedi ANONYMOUS_ORDER.
//     order_lines   nessun riferimento alla persona: pendono da
//                   shopify_order_id, e dentro hanno prodotto, quantita',
//                   prezzo. Anonimizzato l'ordine, la riga non e' piu'
//                   riconducibile a nessuno.
//     users         shopify_customer_id + l'identificativo del browser, il
//                   browser, il tipo di dispositivo, la prima e l'ultima
//                   visita, e `merged_into` che lega fra loro i dispositivi
//                   della stessa persona. Non c'e' dentro un nome, e per un
//                   pezzo e' bastato quello a lasciarla fuori da questo
//                   elenco: era sbagliato. Una riga qui dice quali
//                   dispositivi usa una persona identificata e quando li ha
//                   usati — e lo dice di sua iniziativa, perche' e' l'unico
//                   dato di questa app che Shopify non ci ha dato lei.
//
//   nel nostro database
//     sync_job_events   righe storiche con entity='customer' e l'id Shopify
//                       della persona (oggi il tipo non le lascia piu'
//                       scrivere, ma le vecchie sono li')
//     sync_jobs.errors  il JSON di un fallimento poteva portarsi dentro il
//                       customer_id in chiaro
//     integration_conflicts  shopify_customer_id + la data di nascita nostra
//                       e quella letta da Klaviyo. Al `shop/redact` se ne va
//                       per cascata da `shops`, come le altre tabelle
//                       integration_*, che non portano dati delle persone
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
//
// LA SCELTA SUI BROWSER: si cancellano, e con loro i legami che li univano.
//
// E' la decisione opposta a quella sugli ordini, e per la ragione opposta.
// Dietro un ordine c'e' un obbligo di conservazione — e' una scrittura
// contabile — mentre dietro `users` non c'e' niente del genere: quella tabella
// esiste per riconoscere chi torna sul negozio, cioe' per marketing, che e'
// esattamente il trattamento che una richiesta di cancellazione fa cessare.
// Non c'e' nessun art. 17(3) da invocare, quindi le righe se ne vanno.
//
// La via di mezzo — tenere la riga e azzerare `shopify_customer_id` — e' stata
// scartata apposta, e va detto perche' sembrava ragionevole: l'identificativo
// del browser e' una stringa casuale, quindi "pseudonimo, quindi non
// personale". Non regge. Quella stringa vive ancora dentro il browser di quella
// persona: alla prima visita successiva la riga tornerebbe raggiungibile
// partendo da lei, con la data della prima comparsa e tutta la sua storia
// dentro. Un identificativo che il titolare puo' ricollegare a un individuo e'
// dato personale (art. 4(1) e 4(5)); conservarlo per via del suo aspetto
// casuale sarebbe una cancellazione solo all'apparenza. E vale a maggior
// ragione per `shopify_customer_id`, che non e' pseudonimo per niente.
//
// Il come — l'ordine dei passi, il grafo di `merged_into`, il tetto ai salti —
// sta in lib/gdpr/identity-graph.server.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import type { GdprStep, QueryError } from './steps';
import { toStep } from './steps';
import { eraseBrowsersOfCustomer } from './identity-graph.server';
import { ORDER_COLUMNS_CLEARED_ON_ERASURE } from '~/lib/supabase-schema';

// Il vocabolario dei passi vive in `steps.ts` — ci arriva anche il grafo delle
// identita', e tenerlo qui avrebbe chiuso un cerchio fra i due moduli. Si
// riesporta perche' chi importa da qui lo ha sempre fatto, e non c'e' ragione
// di far cambiare gli import a mezzo repository per una divisione interna.
export type { GdprStep, QueryError } from './steps';
export { stepsFailed, failureMessage } from './steps';

// I nomi che la DDL crea per ordini e righe. Non sono configurabili come lo e'
// la tabella clienti: chi scrive gli ordini (webhook e sync) li usa cablati, e
// qui si deve leggere esattamente dove si e' scritto.
export const ORDERS_TABLE = 'orders';
export const ORDER_LINES_TABLE = 'order_lines';

// Le colonne degli ordini che riportano alla persona: l'identificativo, il nome
// e il cognome — e il paese di spedizione, che e' l'unico pezzo dell'indirizzo
// che l'app prende da un ordine. Indirizzi completi, email e note negli ordini
// non li abbiamo mai copiati.
//
// PERCHE' IL PAESE SI' E IL RESTO DEI DATI LOGISTICI NO. Il paese viene
// dall'indirizzo della persona: e' un suo dato, e una cancellazione lo toglie.
// Peso, colli, opzione di spedizione, stato di evasione, data del reso,
// imballo e costo logistico descrivono il pacco e la vendita, non chi l'ha
// comprata: sull'ordine ormai anonimo restano, come il totale e le righe,
// perche' sono cio' che fa tornare i conti del merchant.
//
// L'elenco vive in supabase-schema (ORDER_COLUMNS_CLEARED_ON_ERASURE), da cui
// nasce anche il trigger che impedisce di riscriverle; l'inventario dei dati
// (lib/legal/order-data-inventory) le dichiara `azzerato`, e un test li
// confronta.
export const ANONYMOUS_ORDER: Readonly<Record<(typeof ORDER_COLUMNS_CLEARED_ON_ERASURE)[number], null>> =
  Object.fromEntries(ORDER_COLUMNS_CLEARED_ON_ERASURE.map((c) => [c, null])) as Record<
    (typeof ORDER_COLUMNS_CLEARED_ON_ERASURE)[number],
    null
  >;

/**
 * La colonna che marca un ordine come cancellato. Una volta scritta, il
 * trigger `kerdon_orders_keep_redacted` nel database del merchant tiene vuote
 * le colonne qui sopra contro qualunque scrittura successiva.
 */
export const REDACTED_MARKER = 'customer_redacted_at';

/**
 * La marcatura non c'e' perche' lo schema del merchant e' fermo prima della 16.
 *
 * Va riconosciuto PRIMA di `isTableMissing`, che su "column ... does not exist"
 * direbbe "tabella assente" e farebbe saltare l'intera anonimizzazione.
 * PGRST204 e' il modo in cui l'API REST dice che una colonna non e' nella sua
 * copia dello schema; 42703 e' l'"undefined_column" di Postgres.
 */
function markerMissing(error: QueryError | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === 'PGRST204' ||
    error.code === '42703' ||
    (error.message ?? '').includes(REDACTED_MARKER)
  );
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
  //
  // Con la marcatura, perche' i dati tolti non tornino: la sincronizzazione e
  // il recupero dello storico riscrivono gli ordini da Shopify, e senza di
  // lei rimetterebbero identificativo, nome e paese alla prima occasione.
  let anonymized = await supabase
    .from(ORDERS_TABLE)
    .update({ ...ANONYMOUS_ORDER, [REDACTED_MARKER]: new Date().toISOString() }, { count: 'exact' })
    .eq('shopify_customer_id', customerId);

  if (markerMissing(anonymized.error)) {
    // Schema del merchant non ancora alla 16. La cancellazione non si rimanda
    // per questo — la persona ha diritto a essere tolta adesso — ma si dice
    // chiaramente che la protezione contro la riscrittura manca: la traccia lo
    // registra, e lo schema si allinea alla prossima sincronizzazione.
    anonymized = await supabase
      .from(ORDERS_TABLE)
      .update(ANONYMOUS_ORDER, { count: 'exact' })
      .eq('shopify_customer_id', customerId);
    const passo = toStep(ORDERS_TABLE, 'anonymized', anonymized);
    steps.push(
      passo.outcome === 'anonymized'
        ? { ...passo, detail: `senza ${REDACTED_MARKER}: schema del database non aggiornato` }
        : passo,
    );
  } else {
    steps.push(toStep(ORDERS_TABLE, 'anonymized', anonymized));
  }

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

  // Il grafo dei browser per ultimo. L'ordine non e' indifferente: finche' la
  // riga in `customers` esiste, `identify` puo' riscrivere un legame appena
  // sciolto — cancellata quella, non c'e' piu' niente a cui riattaccarsi.
  steps.push(...(await eraseBrowsersOfCustomer(supabase, customerId)));

  return steps;
}

/** L'esportazione: tutto quello che il database del merchant sa della persona. */
export interface CustomerDataPackage {
  customer: Record<string, unknown> | null;
  orders: Record<string, unknown>[];
  order_lines: Record<string, unknown>[];
  /**
   * I browser da cui quella persona e' passata, il canonico e gli altri: e'
   * l'unica parte dell'esportazione che Shopify non ha gia'. Escono anche i
   * legami `merged_into`, perche' dire "questi tre dispositivi sono la stessa
   * persona" e' esattamente cio' che di lei abbiamo dedotto.
   */
  browsers: Record<string, unknown>[];
  /**
   * Le differenze con Klaviyo registrate per la persona: l'unica parte che non
   * sta nel database del merchant ma nel nostro. La data di Klaviyo di un
   * conflitto ancora aperto, o chiuso con «Tieni il nostro», non esiste da
   * nessun'altra parte: senza questa voce la persona non la vedrebbe mai.
   */
  integration_conflicts: Record<string, unknown>[];
}

/** Un'esportazione vuota, la risposta giusta quando non teniamo nulla. */
export function emptyCustomerDataPackage(): CustomerDataPackage {
  return { customer: null, orders: [], order_lines: [], browsers: [], integration_conflicts: [] };
}

/**
 * I conflitti con le integrazioni (Klaviyo) di una persona, per l'esportazione.
 *
 * Solo quelli di questo negozio: la stessa persona su un altro negozio e' un
 * altro titolare. I nomi delle chiavi sono quelli che legge chi riceve il file,
 * non le colonne: `provider_value` e' il valore letto dal fornitore indicato in
 * `provider`. Una lettura fallita e' un passo fallito, e l'esportazione non
 * parte: incompleta direbbe che il resto non esiste.
 */
export async function collectIntegrationConflicts(
  shopId: string,
  customerId: string,
): Promise<{ rows: Record<string, unknown>[]; step: GdprStep }> {
  const table = 'integration_conflicts';
  if (!/^\d+$/.test(customerId)) {
    return {
      rows: [],
      step: { table, outcome: 'skipped', rows: 0, detail: 'id cliente non numerico: nessuna riga puo corrispondere' },
    };
  }
  try {
    const found = await prisma.integrationConflict.findMany({
      where: { shopId, customerId: { in: [BigInt(customerId)] } },
      orderBy: { createdAt: 'asc' },
      select: {
        provider: true,
        targetField: true,
        ourValue: true,
        theirValue: true,
        status: true,
        decidedAt: true,
      },
    });
    const rows = found.map((c) => ({
      provider: c.provider,
      field: c.targetField,
      our_value: c.ourValue,
      provider_value: c.theirValue,
      status: c.status,
      decided_at: c.decidedAt ? new Date(c.decidedAt).toISOString() : null,
    }));
    return { rows, step: { table, outcome: 'read', rows: rows.length } };
  } catch (error) {
    return {
      rows: [],
      step: {
        table,
        outcome: 'failed',
        rows: 0,
        detail: error instanceof Error ? error.message : 'errore sconosciuto',
      },
    };
  }
}

// LA RACCOLTA PER UNA RICHIESTA DI ACCESSO STA IN `subject-snapshot.server`.
//
// Non e' una divisione estetica. Leggere per consegnare non e' la stessa cosa
// che leggere per cancellare: la cancellazione e' ripetibile e lavora per id,
// quindi puo' scorrere le tabelle mentre il mondo si muove; l'esportazione deve
// invece raccontare UN istante, altrimenti mette insieme un cliente di prima e
// gli ordini di dopo e li presenta come se fossero stati visti insieme. La
// fotografia sotto lucchetto, l'impaginazione di quella fotografia e il
// confronto per chiave che la verifica hanno preso un file loro.

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

  // I conflitti con Klaviyo: ognuno porta la data di nascita della persona due
  // volte, la nostra e quella letta da Klaviyo. Si cancellano, decisi o no:
  // una decisione presa su una persona che ha chiesto la cancellazione non
  // serve piu' a niente. Solo quelli di questo negozio: la stessa persona su un
  // altro negozio e' un altro titolare, con un'altra richiesta.
  const conflictCustomerId = /^\d+$/.test(customerId) ? BigInt(customerId) : null;
  if (conflictCustomerId === null) {
    steps.push({
      table: 'integration_conflicts',
      outcome: 'skipped',
      rows: 0,
      detail: 'id cliente non numerico: nessuna riga puo corrispondere',
    });
  } else {
    try {
      const removed = await prisma.integrationConflict.deleteMany({
        where: { shopId, customerId: { in: [conflictCustomerId] } },
      });
      steps.push({ table: 'integration_conflicts', outcome: 'deleted', rows: removed.count });
    } catch (error) {
      steps.push({
        table: 'integration_conflicts',
        outcome: 'failed',
        rows: 0,
        detail: error instanceof Error ? error.message : 'errore sconosciuto',
      });
    }
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
