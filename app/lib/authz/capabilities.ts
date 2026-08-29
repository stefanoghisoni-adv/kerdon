import { hasOrdersAccess } from '~/lib/sync/orders-access';
import { syncIsActive } from '~/lib/sync/sync-active';

/**
 * La domanda "questo negozio puo' fare questa cosa?", chiesta in un posto solo.
 *
 * Prima di questo modulo la risposta si componeva sul posto, ogni volta: un
 * `isAuthorized` qui, un `syncIsActive` la', un controllo sul piano da
 * un'altra parte. Ognuno di quei pezzi era giusto; il guaio era che nessuno
 * garantiva che fossero tutti presenti dove servivano. E infatti non lo erano —
 * i webhook operativi non guardavano l'autorizzazione, il file del feed non
 * guardava nemmeno il piano, e nessuno guardava se l'app fosse ancora
 * installata. Un negozio sospeso continuava a sincronizzare passando dalla
 * porta di servizio invece che da quella principale.
 *
 * Da qui in avanti chi deve decidere non ricompone la regola: chiede una
 * capacita' per nome. Se la regola cambia, cambia qui, e cambia per tutti nello
 * stesso istante.
 *
 * Modulo puro di proposito — nessun import da un `.server` — cosi' la policy si
 * puo' provare senza database e si puo' chiamare da qualunque punto del codice.
 * A leggere le righe dal database ci pensa `shop-capabilities.server`.
 */

/**
 * Le cose che un negozio puo' chiedere di fare.
 *
 * Sono nominate una per una e non ricavate da booleani sparsi: chi chiama
 * scrive `can(caps, 'sync_orders')`, non "se il piano X e l'autorizzazione Y e
 * gli scope Z". Quella frase, ripetuta in venti posti, e' esattamente il modo in
 * cui venti posti finiscono per dire cose diverse.
 *
 * `use_app` non e' una funzione dell'app: e' la precondizione di tutte le altre
 * — il negozio esiste, l'app e' installata, l'autorizzazione e' concessa — e
 * vive qui perche' le schermate di configurazione hanno bisogno proprio di
 * quella e di nient'altro. Senza, ognuna se la ricalcolerebbe per conto suo, che
 * e' il difetto da cui siamo partiti.
 */
export const CAPABILITIES = [
  'use_app',
  'sync_products',
  'sync_customers',
  'sync_orders',
  'use_feeds',
  'use_read_proxy',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Perche' una capacita' e' negata.
 *
 * Serve a chi risponde, non a chi decide: la stessa negazione diventa un 403
 * con un messaggio in una schermata, un 404 muto su una rotta pubblica e una
 * riga di log in un webhook. Il motivo permette a ognuno di rispondere come gli
 * si conviene senza tornare a interrogare lo stato del negozio da capo.
 */
export type DenialReason =
  /** Non si e' potuto stabilire di che negozio si parla: in dubbio si nega. */
  | 'unknown_shop'
  /** L'app e' stata disinstallata: non c'e' piu' nessun consenso da usare. */
  | 'uninstalled'
  /** La colonna `authorization` non e' ENABLED: uso dell'app sospeso. */
  | 'not_authorized'
  /** La colonna `tracking_authorization` non e' ENABLED: letture sospese. */
  | 'tracking_suspended'
  /** Nessun progetto Supabase collegato e verificato: non c'e' dove scrivere. */
  | 'not_connected'
  /** Il piano del negozio non comprende questa funzione. */
  | 'plan_required'
  /** Il permesso non e' stato concesso all'installazione (scope Shopify). */
  | 'scope_required';

/** Quel che del piano interessa alla policy, e nient'altro. */
export interface CapabilityPlan {
  customersSyncEnabled: boolean;
  productFeedsEnabled: boolean;
}

/**
 * Lo stato del negozio da cui la policy decide.
 *
 * Sono tutti e soli i fatti che contano. Passarli espliciti invece della riga
 * Prisma intera serve a due cose: si vede a colpo d'occhio cosa entra nella
 * decisione, e chi scrive un test non deve costruire un negozio finto con
 * quaranta colonne per provarne una.
 */
export interface ShopCapabilityFacts {
  /** Valorizzato = l'app e' stata disinstallata. */
  uninstalledAt: Date | null | undefined;
  /** Colonna `authorization`: l'uso dell'app. */
  authorization: string | null | undefined;
  /**
   * Colonna `tracking_authorization`: le letture dei dati gia' sincronizzati.
   * E' un'autorizzazione a se': spegnere l'una non spegne l'altra.
   */
  trackingAuthorization: string | null | undefined;
  /** Quando il collegamento a Supabase e' stato verificato. null = mai. */
  connectionVerifiedAt: Date | null | undefined;
  /** Gli scope concessi a Shopify all'installazione, come li scrive lei. */
  scopes: string | null | undefined;
  /** Il piano del negozio. null = non trovato nel listino, e allora si nega. */
  plan: CapabilityPlan | null | undefined;
}

export interface CapabilityDecision {
  readonly granted: boolean;
  /** Il motivo del rifiuto. null quando la capacita' e' concessa. */
  readonly denial: DenialReason | null;
}

export type ShopCapabilities = Readonly<Record<Capability, CapabilityDecision>>;

const ALLOWED: CapabilityDecision = { granted: true, denial: null };

function refused(denial: DenialReason): CapabilityDecision {
  return { granted: false, denial };
}

/**
 * L'unico valore che concede: l'esatto `ENABLED`.
 *
 * Non si passa da `normalizeAuthorization`, che e' deliberatamente permissiva —
 * mappa a ENABLED tutto cio' che non riconosce, cosi' la UI non si blocca su
 * valori nulli o legacy. Sul percorso delle decisioni quella generosita' e' un
 * bypass: basterebbe un valore inatteso perche' un negozio da bloccare passi.
 * Qui, in dubbio, si nega — anche di fronte a una stringa mai vista.
 */
function enabled(value: string | null | undefined): boolean {
  return (value ?? '').trim().toUpperCase() === 'ENABLED';
}

/** La prima ragione che c'e', o null se non ce n'e' nessuna. */
function firstDenial(...reasons: Array<DenialReason | null>): DenialReason | null {
  for (const reason of reasons) if (reason !== null) return reason;
  return null;
}

function decide(denial: DenialReason | null): CapabilityDecision {
  return denial === null ? ALLOWED : refused(denial);
}

/** Ogni capacita' negata, per lo stesso motivo. Il caso "non so chi sei". */
function denyEverything(denial: DenialReason): ShopCapabilities {
  const decision = refused(denial);
  return Object.fromEntries(
    CAPABILITIES.map((capability) => [capability, decision]),
  ) as ShopCapabilities;
}

/**
 * La policy.
 *
 * `facts` a null significa che il negozio non si e' potuto identificare — la
 * riga non c'e', il token non corrisponde a nessuno, la sessione parla di un
 * dominio che non abbiamo mai visto. E' il caso in cui la tentazione di
 * "lasciar passare, tanto e' un caso limite" costa piu' cara: un negozio di cui
 * non si sa niente non puo' fare niente.
 */
export function evaluateShopCapabilities(
  facts: ShopCapabilityFacts | null | undefined,
): ShopCapabilities {
  if (!facts) return denyEverything('unknown_shop');

  // Le tre condizioni che vengono prima di ogni cosa, nell'ordine in cui
  // pesano: se l'app non e' piu' installata non c'e' nessun permesso da
  // esercitare, e non ha senso spiegare che il piano non basta.
  const installed = facts.uninstalledAt == null ? null : ('uninstalled' as const);
  const authorized = enabled(facts.authorization) ? null : ('not_authorized' as const);
  const connected = syncIsActive({ connectionVerifiedAt: facts.connectionVerifiedAt ?? null })
    ? null
    : ('not_connected' as const);

  // L'uso dell'app non chiede un database collegato: e' proprio durante la
  // configurazione — quando il collegamento ancora non c'e' — che le schermate
  // che lo creano devono poter funzionare.
  const useApp = firstDenial(installed, authorized);

  // Tutto cio' che scrive sul database del merchant ha bisogno, in piu', che
  // quel database ci sia e risponda.
  const syncBase = firstDenial(useApp, connected);

  const customersInPlan = facts.plan?.customersSyncEnabled === true;
  const feedsInPlan = facts.plan?.productFeedsEnabled === true;

  // Il piano non trovato nel listino conta come "non lo comprende": e' l'esito
  // prudente, e coincide con quello che il codice faceva gia' ovunque
  // (`plan?.qualcosa ?? false`).
  return {
    use_app: decide(useApp),
    sync_products: decide(syncBase),
    sync_customers: decide(
      firstDenial(syncBase, customersInPlan ? null : 'plan_required'),
    ),
    // Gli ordini non sono una funzione del piano ma un permesso: si concede
    // all'installazione, e chi ha installato l'app prima che gli ordini
    // esistessero non l'ha dato. Senza, ogni chiamata a Shopify risponderebbe
    // 403 e la corsa fallirebbe per intero.
    sync_orders: decide(
      firstDenial(syncBase, hasOrdersAccess(facts.scopes) ? null : 'scope_required'),
    ),
    use_feeds: decide(firstDenial(syncBase, feedsInPlan ? null : 'plan_required')),
    // Il tracciamento ha la sua autorizzazione, indipendente da quella
    // dell'app: un negozio con l'app sospesa continua a poter leggere i dati
    // gia' sincronizzati — fermi, ma utilizzabili. Quel che vale per entrambe
    // e' il resto: un'app disinstallata non legge piu' niente, e senza progetto
    // collegato non c'e' niente da leggere.
    use_read_proxy: decide(
      firstDenial(
        installed,
        enabled(facts.trackingAuthorization) ? null : 'tracking_suspended',
        connected,
      ),
    ),
  };
}

/** Il modo normale di interrogare la policy. */
export function can(capabilities: ShopCapabilities, capability: Capability): boolean {
  return capabilities[capability].granted;
}

/** Perche' e' negata, per chi deve scegliere come rispondere. null = concessa. */
export function denialOf(
  capabilities: ShopCapabilities,
  capability: Capability,
): DenialReason | null {
  return capabilities[capability].denial;
}
