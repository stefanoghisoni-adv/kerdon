// app/lib/sync/failure-taxonomy.ts
//
// Quali guasti di una corsa si possono lasciar passare, e quali no.
//
// COS'E' CAMBIATO E PERCHE'. Nei processor una quantita' di errori veniva
// scritta nel log e ignorata, e alla fine la corsa si dichiarava `completed`
// lo stesso. Il confine incrementale della corsa dopo si calcola dall'ultima
// corsa completata: una risorsa che l'upsert non era riuscito a scrivere usciva
// dalla finestra e — se su Shopify nessuno la toccava piu' — non veniva mai
// piu' riletta. Il difetto non si vedeva il giorno stesso: diventava
// permanente, e nessun registro sapeva dire quale riga fosse rimasta indietro.
//
// Da qui in avanti "avviso e si prosegue" non e' piu' una scelta disponibile
// per i primi due gruppi. Ogni punto in cui una corsa puo' rompersi ha un nome
// in questo elenco e una classe, e la classe decide cosa succede:
//
// - **critico**: la corsa fallisce e il confine incrementale resta dov'era. Si
//   sceglie qui quando il guasto riguarda troppe risorse per elencarle una per
//   una — un blocco di mille clienti — e trasformarle in altrettanti lavori di
//   riparazione costerebbe piu' del rifare la corsa.
// - **riparabile**: la corsa prosegue, ma nello stesso flusso nasce una riga
//   durevole con negozio, risorsa, operazione e istante di modifica. Senza
//   quella riga scritta, proseguire e' vietato.
// - **cosmetico**: si perde un dettaglio da mostrare, mai un dato del merchant.
//   Questi si possono ignorare, e sono gli unici.
//
// Nessun import: e' voluto. Le regole devono poter essere lette e provate senza
// database, senza Shopify e senza Supabase.

/** Le tre sorti possibili di un guasto. */
export type FailureClass = 'critical' | 'repairable' | 'cosmetic';

/** Su cosa insiste una riparazione. */
export type RepairResourceType = 'product' | 'customer' | 'order';

/**
 * Cosa non e' riuscito.
 *
 * 'sweep' e' distinta da 'delete' perche' non nomina righe: cancella tutto cio'
 * che la corsa non ha riscritto. Rifarla piu' tardi resta corretto — quel che e'
 * stato scritto dopo sopravvive — mentre rifare una 'delete' con un elenco di
 * id vecchio non lo sarebbe.
 */
export type RepairOperation =
  | 'upsert'
  | 'delete'
  | 'sweep'
  | 'consent_revoke'
  | 'birthdate_writeback';

export interface FailureSite {
  readonly failureClass: FailureClass;
  readonly resourceType?: RepairResourceType;
  readonly operation?: RepairOperation;
  /**
   * Se la corsa incrementale successiva ripassa da sola sulla risorsa.
   *
   * E' la differenza che decide come si ripara. Un prodotto che non si e'
   * riusciti a scrivere torna nel delta appena il confine viene tenuto indietro
   * fino alla sua data di modifica: non serve nessuna spinta. Una data di
   * nascita che deve andare VERSO Shopify no — su Shopify non e' cambiato
   * niente, quindi nel delta non ricomparira' mai, e sperarlo sarebbe aspettare
   * un evento che non puo' accadere. Quelle vanno rispinte da un magazzino
   * d'uscita, ed e' l'unico motivo per cui il magazzino esiste.
   */
  readonly recoveredByDelta?: boolean;
}

/**
 * Ogni punto in cui la corsa puo' rompersi, con la sua sorte.
 *
 * L'elenco e' chiuso e i nomi compaiono nel codice dei processor: cosi' un
 * punto nuovo non puo' nascere "non fatale" per distrazione — non ha un nome
 * qui, e il tipo lo rifiuta.
 */
export const FAILURE_SITES = {
  /**
   * L'upsert di un prodotto. Riparabile per prodotto: la granularita' e' gia'
   * quella giusta, e un catalogo non si ferma per una riga.
   */
  'product.upsert': {
    failureClass: 'repairable',
    resourceType: 'product',
    operation: 'upsert',
    recoveredByDelta: true,
  },

  /**
   * Le varianti che il prodotto non ha piu'. L'elenco degli id si conserva —
   * serve a chi guarda la riparazione per capire cosa era rimasto indietro — ma
   * la riparazione vera passa dal delta: si rilegge il prodotto e si ricalcola
   * la differenza. Rigiocare un elenco di id vecchio cancellerebbe varianti che
   * nel frattempo sono tornate legittime.
   */
  'product.orphan-delete': {
    failureClass: 'repairable',
    resourceType: 'product',
    operation: 'delete',
    recoveredByDelta: true,
  },

  /**
   * La spazzata di fine corsa completa: via tutto cio' che non e' stato
   * riscritto adesso. Nessun delta la riporta — la corsa incrementale non
   * spazza — quindi va rispinta dal magazzino d'uscita, con l'istante di
   * confine conservato: rieseguirla piu' tardi con quel confine resta corretto,
   * perche' quel che e' stato scritto dopo non ricade sotto la soglia.
   */
  'product.sweep': {
    failureClass: 'repairable',
    resourceType: 'product',
    operation: 'sweep',
    recoveredByDelta: false,
  },

  /**
   * Il blocco di clienti. Critico, ed e' una scelta: un blocco sono fino a
   * mille persone, e mille righe di riparazione sarebbero un elenco piu' caro
   * della corsa stessa. Meglio fermarsi e lasciare il confine dov'era: la corsa
   * dopo li rilegge tutti.
   */
  'customer.upsert': { failureClass: 'critical' },

  /**
   * La marcatura di chi ha ritirato il consenso. Era "non fatale" con un
   * avviso, ed era il punto peggiore di tutti: da quella colonna dipende il
   * rifiuto di servire i dati di quella persona. Un fallimento silenzioso
   * lasciava leggibile un cliente che aveva detto di no.
   */
  'customer.consent-revoke': {
    failureClass: 'repairable',
    resourceType: 'customer',
    operation: 'consent_revoke',
    recoveredByDelta: true,
  },

  /**
   * La data di nascita riportata su Shopify. Non blocca la replica verso il
   * merchant — quella e' gia' avvenuta — ma non puo' nemmeno aspettare il
   * delta: e' l'unico caso in cui la scrittura va nella direzione opposta, e
   * Shopify non ha niente da segnalare come cambiato.
   */
  'customer.birthdate-writeback': {
    failureClass: 'repairable',
    resourceType: 'customer',
    operation: 'birthdate_writeback',
    recoveredByDelta: false,
  },

  /** L'ordine. Critico come il blocco di clienti, e per la stessa ragione. */
  'order.upsert': { failureClass: 'critical' },

  /** Le righe dell'ordine. Critico: senza, l'ordine resta a meta'. */
  'order.line-upsert': { failureClass: 'critical' },

  /**
   * Le righe che l'ordine non ha piu'. Come le varianti orfane: l'elenco si
   * conserva, la riparazione passa dal delta con un elenco fresco.
   */
  'order.stale-lines': {
    failureClass: 'repairable',
    resourceType: 'order',
    operation: 'delete',
    recoveredByDelta: true,
  },

  /**
   * Le tre letture che servono solo a dire "aggiunto" invece di "aggiornato".
   * Cosmetiche davvero: senza risposta si rinuncia al dettaglio, e nessun dato
   * del merchant cambia. Sono le uniche a cui e' concesso proseguire in
   * silenzio.
   */
  'detail.existing-product-rows': { failureClass: 'cosmetic' },
  'detail.existing-customers': { failureClass: 'cosmetic' },
  'detail.returned-rows': { failureClass: 'cosmetic' },
} as const satisfies Record<string, FailureSite>;

export type FailureSiteName = keyof typeof FAILURE_SITES;

export function failureSite(name: FailureSiteName): FailureSite {
  return FAILURE_SITES[name];
}

/**
 * Se da questo punto si puo' proseguire senza scrivere niente.
 *
 * Una sola risposta affermativa in tutto l'elenco: i tre dettagli. E' la regola
 * che il resto del codice deve poter chiedere invece di ricordare.
 */
export function mayContinueSilently(name: FailureSiteName): boolean {
  return FAILURE_SITES[name].failureClass === 'cosmetic';
}

/** I punti che, fallendo, devono far nascere una riparazione durevole. */
export function repairSpecOf(
  name: FailureSiteName,
): { resourceType: RepairResourceType; operation: RepairOperation; recoveredByDelta: boolean } | null {
  const site: FailureSite = FAILURE_SITES[name];
  if (site.failureClass !== 'repairable') return null;
  // Il tipo garantisce gia' che una voce riparabile porti risorsa e operazione:
  // `satisfies` non lo controlla, questo si'.
  if (!site.resourceType || !site.operation) {
    throw new Error(`Punto di guasto riparabile senza risorsa o operazione: ${name}`);
  }
  return {
    resourceType: site.resourceType,
    operation: site.operation,
    recoveredByDelta: site.recoveredByDelta === true,
  };
}
