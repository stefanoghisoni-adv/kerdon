import type { AdminApiContext } from '@shopify/shopify-app-remix/server';

// Abbonamenti gestiti con la Billing API diretta (appSubscriptionCreate), non con
// il Managed Pricing di Shopify: nome, prezzo e giorni di prova devono restare
// quelli scritti nella tabella `plans`, che e' l'unica fonte che l'app applica
// davvero. Col Managed Pricing il listino vivrebbe nella Partner Dashboard e le
// due copie prima o poi racconterebbero cose diverse.

/**
 * La sola parte di `admin` che serve qui: il client GraphQL.
 *
 * Tipare il parametro con l'intero `AdminApiContext` obbligherebbe i test a
 * costruire anche il client REST e le risorse, che qui non tocchiamo mai. La
 * compatibilita' con l'oggetto vero e' comunque garantita a compile time dal
 * controllo qui sotto.
 */
export interface BillingAdmin {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response>;
}

// Se un aggiornamento di @shopify/shopify-app-remix cambiasse la firma di
// `admin.graphql`, questo tipo diventerebbe `never` e la riga sotto non
// compilerebbe: meglio accorgersene qui che a runtime in produzione.
type AdminIsBillingAdmin = AdminApiContext extends BillingAdmin ? true : never;
const _adminIsBillingAdmin: AdminIsBillingAdmin = true;
void _adminIsBillingAdmin;

/** Un abbonamento come serve all'app: solo i campi che leggiamo davvero. */
export interface AppSubscriptionSummary {
  /** gid://shopify/AppSubscription/1234 */
  gid: string;
  name: string;
  /** ACTIVE, PENDING, CANCELLED, EXPIRED, DECLINED, FROZEN. */
  status: string;
  test: boolean;
  trialDays: number;
  /** ISO 8601. Null finche' Shopify non ha stabilito il primo periodo. */
  currentPeriodEnd: string | null;
  /** Importo mensile in EUR. Null se Shopify non restituisce il pricing. */
  priceAmount: number | null;
  /**
   * In che valuta e' quell'importo, come la dichiara Shopify. Null se il
   * pricing non arriva.
   *
   * Si legge perche' la callback ha qualcosa da confrontarci: la valuta con cui
   * il tentativo era partito. Un abbonamento che torna in una valuta diversa da
   * quella mostrata al merchant e' una cosa da sapere, non da scoprire da una
   * fattura.
   */
  currency: string | null;
  /**
   * Ogni quanto si paga, tradotto nei termini dell'app. Null se il pricing non
   * arriva o l'intervallo non e' uno dei due che usiamo.
   */
  interval: 'monthly' | 'yearly' | null;
}

export interface CreateSubscriptionOptions {
  /** Nome esatto dalla colonna `plan_name`: e' quello che il merchant vede in fattura. */
  planName: string;
  /** Prezzo di LISTINO nel ciclo scelto. Lo sconto viaggia a parte. */
  price: number;
  /**
   * In che valuta e' quel prezzo.
   *
   * La stessa che il merchant ha visto sulla card: Shopify fattura nella valuta
   * che gli diciamo, e dirgliene una diversa da quella mostrata significa
   * addebitare una cifra che il merchant non ha mai letto.
   */
  currency: string;
  /** Ogni quanto si paga. */
  interval: 'monthly' | 'yearly';
  /** Null = nessuna prova. */
  trialDays: number | null;
  /** URL assoluto a cui Shopify rimanda dopo la conferma dell'addebito. */
  returnUrl: string;
  /** true = addebito di prova, obbligatorio sui development store. */
  test: boolean;
  /**
   * Sconto riservato, in valore assoluto sul prezzo di listino.
   *
   * Si passa come sconto e non come prezzo piu' basso perche' e' l'unico modo
   * per farlo scadere: registrando direttamente l'importo agevolato, quello
   * resterebbe per sempre. Con lo sconto, allo scadere dei cicli concordati il
   * prezzo pieno riparte da solo, senza chiedere al merchant di riapprovare un
   * addebito.
   */
  discount?: {
    /** Quanto si toglie al prezzo di listino, nella stessa valuta. */
    amount: number;
    /** Per quanti cicli vale. null = per sempre. */
    intervals: number | null;
  } | null;
}

export interface CreateSubscriptionResult {
  confirmationUrl: string;
  subscriptionGid: string;
  /** Parte numerica del gid: `BillingCharge.shopifyChargeId` e' un BigInt. */
  chargeId: bigint;
}

const IS_DEV_STORE_QUERY = `#graphql
  query BillingIsDevelopmentStore {
    shop {
      plan {
        partnerDevelopment
      }
    }
  }`;

const SUBSCRIPTION_FIELDS = `
    id
    name
    status
    test
    createdAt
    currentPeriodEnd
    trialDays
    lineItems {
      plan {
        pricingDetails {
          ... on AppRecurringPricing {
            price {
              amount
              currencyCode
            }
            interval
          }
        }
      }
    }`;

const CREATE_SUBSCRIPTION_MUTATION = `#graphql
  mutation BillingAppSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $test: Boolean
    $trialDays: Int
    $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      test: $test
      trialDays: $trialDays
      lineItems: $lineItems
    ) {
      confirmationUrl
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }`;

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query BillingActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {${SUBSCRIPTION_FIELDS}
      }
    }
  }`;

const SUBSCRIPTION_BY_ID_QUERY = `#graphql
  query BillingSubscriptionById($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {${SUBSCRIPTION_FIELDS}
      }
    }
  }`;

const CANCEL_SUBSCRIPTION_MUTATION = `#graphql
  mutation BillingAppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }`;

interface UserError {
  field?: string[] | null;
  message: string;
}

interface RawSubscription {
  id: string;
  name?: string | null;
  status?: string | null;
  test?: boolean | null;
  currentPeriodEnd?: string | null;
  trialDays?: number | null;
  lineItems?: {
    plan?: {
      pricingDetails?: {
        price?: { amount?: string | number | null; currencyCode?: string | null } | null;
        interval?: string | null;
      } | null;
    } | null;
  }[] | null;
}

/**
 * Legge il corpo della risposta GraphQL.
 *
 * Gli errori di primo livello (query malformata, permessi mancanti) non
 * arrivano in `userErrors` ma in `errors`: senza questo controllo si
 * proseguirebbe con `data` undefined e l'errore diventerebbe un incomprensibile
 * "cannot read property of undefined" molto piu' a valle.
 */
async function readGraphQLData<T>(response: Response, operation: string): Promise<T> {
  const body = (await response.json()) as {
    data?: T;
    // Di norma un array. Su token scaduto o revocato Shopify risponde con una
    // stringa ("[API] Invalid API key or access token"), che ha comunque un
    // `.length`: trattarla come array sostituiva il motivo vero con un
    // TypeError, e nei log arrivava quello.
    errors?: { message?: string }[] | string;
  };

  if (typeof body.errors === 'string' && body.errors) {
    throw new Error(`${operation}: ${body.errors}`);
  }
  if (Array.isArray(body.errors) && body.errors.length) {
    const detail = body.errors.map((e) => e.message ?? 'errore sconosciuto').join('; ');
    throw new Error(`${operation}: ${detail}`);
  }
  if (!body.data) {
    throw new Error(`${operation}: risposta senza dati`);
  }
  return body.data;
}

function throwOnUserErrors(errors: UserError[] | undefined | null, operation: string): void {
  if (!errors?.length) return;
  throw new Error(`${operation}: ${errors.map((e) => e.message).join('; ')}`);
}

/**
 * Estrae la parte numerica di un gid Shopify.
 *
 * Serve perche' `BillingCharge.shopifyChargeId` e' un BigInt: il gid intero non
 * ci sta. Lancia sui formati inattesi invece di restituire 0n, che finirebbe in
 * database come un id valido ma sbagliato.
 */
export function parseGidId(gid: string): bigint {
  // La query string finale esiste su alcuni gid (es. ?namespace=): va ignorata.
  const match = /^gid:\/\/shopify\/[A-Za-z]+\/(\d+)(?:\?.*)?$/.exec(gid);
  if (!match) {
    throw new Error(`gid Shopify non valido: ${gid}`);
  }
  return BigInt(match[1]);
}

/** L'intervallo di Shopify nei termini dell'app. Null su valori inattesi. */
function toInterval(raw: string | null | undefined): 'monthly' | 'yearly' | null {
  if (raw === 'ANNUAL') return 'yearly';
  if (raw === 'EVERY_30_DAYS') return 'monthly';
  return null;
}

function toSummary(raw: RawSubscription): AppSubscriptionSummary {
  const pricing = raw.lineItems?.[0]?.plan?.pricingDetails;
  const amount = pricing?.price?.amount;
  const parsed = amount == null ? Number.NaN : Number(amount);
  return {
    gid: raw.id,
    name: raw.name ?? '',
    status: raw.status ?? '',
    test: raw.test ?? false,
    trialDays: raw.trialDays ?? 0,
    currentPeriodEnd: raw.currentPeriodEnd ?? null,
    priceAmount: Number.isFinite(parsed) ? parsed : null,
    currency: pricing?.price?.currencyCode ?? null,
    interval: toInterval(pricing?.interval),
  };
}

/**
 * True se il negozio e' un development store.
 *
 * Sui development store Shopify rifiuta gli addebiti reali: l'abbonamento va
 * creato con `test: true`, altrimenti la mutation fallisce e il merchant resta
 * bloccato sulla pagina del piano senza capire perche'.
 */
export async function isDevelopmentStore(admin: BillingAdmin): Promise<boolean> {
  const response = await admin.graphql(IS_DEV_STORE_QUERY);
  const data = await readGraphQLData<{
    shop?: { plan?: { partnerDevelopment?: boolean | null } | null } | null;
  }>(response, 'isDevelopmentStore');
  return data.shop?.plan?.partnerDevelopment === true;
}

/**
 * Crea l'abbonamento e restituisce l'URL su cui mandare il merchant a
 * confermare l'addebito.
 *
 * L'abbonamento nasce PENDING: diventa attivo solo dopo la conferma, quindi il
 * piano non va attivato qui ma nella callback, dopo aver riletto lo stato.
 */
/**
 * Blocco `discount` della mutation, o niente se non c'e' nulla da scontare.
 *
 * Uno sconto di importo zero o negativo non si manda: Shopify lo rifiuterebbe,
 * e un rifiuto qui fermerebbe una sottoscrizione che sarebbe andata benissimo a
 * prezzo pieno.
 */
function discountDetails(
  discount: CreateSubscriptionOptions['discount'],
): { discount: Record<string, unknown> } | null {
  if (!discount || !(discount.amount > 0)) return null;

  const details: Record<string, unknown> = {
    value: { amount: discount.amount.toFixed(2) },
  };
  // Omesso quando lo sconto non scade: mandare null farebbe comparire il campo
  // senza aggiungere nulla, e 0 significherebbe "mai", cioe' il contrario.
  if (discount.intervals != null && discount.intervals > 0) {
    details.durationLimitInIntervals = discount.intervals;
  }
  return { discount: details };
}

export async function createAppSubscription(
  admin: BillingAdmin,
  opts: CreateSubscriptionOptions,
): Promise<CreateSubscriptionResult> {
  const variables: Record<string, unknown> = {
    name: opts.planName,
    returnUrl: opts.returnUrl,
    test: opts.test,
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            // L'importo viaggia come stringa: e' un Decimal lato Shopify e un
            // float qui perderebbe i centesimi su certi prezzi.
            price: { amount: opts.price.toFixed(2), currencyCode: opts.currency },
            interval: opts.interval === 'yearly' ? 'ANNUAL' : 'EVERY_30_DAYS',
            ...(discountDetails(opts.discount) ?? {}),
          },
        },
      },
    ],
  };
  // trialDays si omette del tutto quando il piano non prevede prova: mandare
  // null farebbe comunque comparire il campo nella mutation senza aggiungere
  // nulla, e 0 non e' distinguibile da "non impostato" leggendo la richiesta.
  if (opts.trialDays != null && opts.trialDays > 0) {
    variables.trialDays = opts.trialDays;
  }

  const response = await admin.graphql(CREATE_SUBSCRIPTION_MUTATION, { variables });
  const data = await readGraphQLData<{
    appSubscriptionCreate?: {
      confirmationUrl?: string | null;
      appSubscription?: { id?: string | null } | null;
      userErrors?: UserError[] | null;
    } | null;
  }>(response, 'createAppSubscription');

  const result = data.appSubscriptionCreate;
  throwOnUserErrors(result?.userErrors, 'createAppSubscription');

  const confirmationUrl = result?.confirmationUrl;
  const subscriptionGid = result?.appSubscription?.id;
  if (!confirmationUrl || !subscriptionGid) {
    throw new Error('createAppSubscription: Shopify non ha restituito confirmationUrl o id');
  }

  return {
    confirmationUrl,
    subscriptionGid,
    chargeId: parseGidId(subscriptionGid),
  };
}

/**
 * Gli abbonamenti attivi dell'installazione corrente.
 *
 * Shopify ne ammette uno solo alla volta, ma la lista serve a intercettare i
 * casi anomali (residui di un cambio piano non andato a buon fine).
 */
export async function getActiveSubscriptions(
  admin: BillingAdmin,
): Promise<AppSubscriptionSummary[]> {
  const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
  const data = await readGraphQLData<{
    currentAppInstallation?: { activeSubscriptions?: RawSubscription[] | null } | null;
  }>(response, 'getActiveSubscriptions');
  return (data.currentAppInstallation?.activeSubscriptions ?? []).map(toSummary);
}

/**
 * Un singolo abbonamento, o null se non esiste piu'.
 *
 * La callback deve rileggere lo stato da qui prima di attivare il piano: il
 * `charge_id` in querystring lo scrive il browser e non prova nulla, mentre
 * l'abbonamento potrebbe essere ancora PENDING o addirittura DECLINED.
 */
export async function getSubscription(
  admin: BillingAdmin,
  gid: string,
): Promise<AppSubscriptionSummary | null> {
  const response = await admin.graphql(SUBSCRIPTION_BY_ID_QUERY, {
    variables: { id: gid },
  });
  const data = await readGraphQLData<{ node?: RawSubscription | null }>(
    response,
    'getSubscription',
  );
  // node null = id inesistente, oppure di un tipo diverso da AppSubscription.
  if (!data.node?.id) return null;
  return toSummary(data.node);
}

// Un abbonamento gia' cancellato o sparito non e' un problema da segnalare: lo
// stato che volevamo ottenere c'e' gia'. Riconosciamo il caso dal messaggio
// perche' Shopify non espone un codice per distinguerlo.
const ALREADY_GONE_PATTERNS = [
  /not\s*found/i,
  /does\s*not\s*exist/i,
  /already\s*cancell?ed/i,
  /cancell?ed/i,
  /expired/i,
  /not\s*active/i,
];

function isAlreadyGone(errors: UserError[]): boolean {
  return errors.every((e) =>
    ALREADY_GONE_PATTERNS.some((pattern) => pattern.test(e.message ?? '')),
  );
}

/**
 * Cancella l'abbonamento indicato.
 *
 * Chiamata a ogni cambio piano e al passaggio a un piano gratuito: se
 * l'abbonamento risulta gia' cancellato non lancia, altrimenti il merchant si
 * vedrebbe fallire un'operazione che di fatto e' andata come doveva.
 */
export async function cancelAppSubscription(admin: BillingAdmin, gid: string): Promise<void> {
  const response = await admin.graphql(CANCEL_SUBSCRIPTION_MUTATION, {
    variables: { id: gid },
  });
  const data = await readGraphQLData<{
    appSubscriptionCancel?: { userErrors?: UserError[] | null } | null;
  }>(response, 'cancelAppSubscription');

  const errors = data.appSubscriptionCancel?.userErrors ?? [];
  if (errors.length === 0) return;

  if (isAlreadyGone(errors)) {
    console.warn(
      `[billing] abbonamento ${gid} gia' cancellato o inesistente: ${errors
        .map((e) => e.message)
        .join('; ')}`,
    );
    return;
  }
  throwOnUserErrors(errors, 'cancelAppSubscription');
}
