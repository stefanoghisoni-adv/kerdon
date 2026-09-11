// e2e/tests/support/server.ts
//
// Il telecomando del server di prova.
//
// PERCHE' NON SI SEMINA CON DELL'SQL. Le righe di partenza si scrivono con il
// client Prisma VERO, passando da `/__test/db`: cosi' una prova eredita i
// valori di default dello schema, i nomi delle colonne veri e i vincoli veri.
// Dell'SQL scritto a parte comincia uguale e diverge alla prima colonna
// aggiunta — e diverge in silenzio, perche' una riga seminata male non fallisce:
// fa fallire la prova sbagliata, tre mesi dopo.
//
// TUTTO QUELLO CHE STA QUI DENTRO E' INVENTATO. Negozi, clienti, ordini, email:
// non c'e' nessun collegamento a un servizio vero da cui possa arrivare un dato
// di qualcuno.

import { expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { AMBIENTE_DI_PROVA } from '../../ambiente';
import { COOKIE_NEGOZIO } from '../../server/fakes/shopify.server';

/** Il negozio con cui lavorano quasi tutte le prove dei flussi. */
export const NEGOZIO = 'kerdon-prova.myshopify.com';
/** Un secondo negozio: serve a provare che i dati di uno non si vedano dall'altro. */
export const ALTRO_NEGOZIO = 'kerdon-altro.myshopify.com';

/** Rimette database, orologio e finti a zero. Si chiama all'inizio di ogni prova. */
export async function azzera(request: APIRequestContext): Promise<void> {
  const risposta = await request.post('/__test/reset');
  expect(risposta.ok(), 'azzeramento del server di prova').toBeTruthy();
}

/** Una chiamata al client Prisma vero del server. */
export async function db<T = unknown>(
  request: APIRequestContext,
  model: string,
  op: string,
  args?: unknown,
): Promise<T> {
  const risposta = await request.post('/__test/db', { data: { model, op, args } });
  const corpo = (await risposta.json()) as { data?: T; error?: string };
  expect(corpo.error, `${model}.${op}`).toBeUndefined();
  return corpo.data as T;
}

/** Prepara le risposte dei finti per la prova che sta girando. */
export async function finti(
  request: APIRequestContext,
  valori: {
    graphql?: { match: string; body: unknown; status?: number; once?: boolean }[];
    sessioni?: string[];
    eliminazione?: Record<string, unknown>;
  },
): Promise<void> {
  const risposta = await request.post('/__test/fakes', { data: valori });
  expect(risposta.ok(), 'preparazione dei finti').toBeTruthy();
}

/** Cosa hanno visto i finti: le query arrivate e quante eliminazioni sono state chieste. */
export async function cosaHannoVisto(
  request: APIRequestContext,
): Promise<{ graphqlLog: string[]; eliminazioniChieste: number }> {
  return (await (await request.get('/__test/fakes')).json()) as {
    graphqlLog: string[];
    eliminazioniChieste: number;
  };
}

/** Sposta in avanti l'orologio del server. */
export async function spostaOrologio(request: APIRequestContext, ms: number): Promise<void> {
  const risposta = await request.post('/__test/clock', { data: { advanceMs: ms } });
  expect(risposta.ok(), 'spostamento dell orologio').toBeTruthy();
}

/**
 * Dichiara per quale negozio il browser sta parlando.
 *
 * In produzione lo dice il gettone di sessione firmato, che vive
 * nell'intestazione della richiesta. Qui lo dice un cookie, perche' una
 * navigazione di primo livello — quella che il browser fa da solo tornando
 * dall'approvazione di un addebito — le intestazioni non le puo' portare. La
 * forma cambia, il punto no: il negozio arriva DA FUORI e le rotte non lo
 * scelgono.
 */
export async function entraComeNegozio(context: BrowserContext, shop: string): Promise<void> {
  await context.addCookies([
    { name: COOKIE_NEGOZIO, value: shop, url: AMBIENTE_DI_PROVA.SHOPIFY_APP_URL },
  ]);
}

export interface NegozioSeminato {
  id: string;
  shopDomain: string;
}

/** Un negozio in una condizione dichiarata, scritto con il client vero. */
export async function seminaNegozio(
  request: APIRequestContext,
  dati: Record<string, unknown> = {},
  shopDomain: string = NEGOZIO,
): Promise<NegozioSeminato> {
  return db<NegozioSeminato>(request, 'shop', 'create', {
    data: {
      shopDomain,
      accessToken: 'gettone-cifrato-finto',
      scopes: AMBIENTE_DI_PROVA.SHOPIFY_SCOPES,
      currentPlan: 'Free',
      ...dati,
    },
    select: { id: true, shopDomain: true },
  });
}

/** La riga di un tentativo di sottoscrizione, come la scrive /billing/subscribe. */
export async function seminaTentativo(
  request: APIRequestContext,
  dati: Record<string, unknown>,
): Promise<{ id: string }> {
  return db<{ id: string }>(request, 'billingCharge', 'create', {
    data: { status: 'pending', ...dati },
    select: { id: true },
  });
}

/**
 * Lo state firmato che Shopify riporta in coda alla URL di ritorno.
 *
 * Si compone qui con lo stesso algoritmo e la stessa chiave del server, e non
 * si riusa `signBillingState` dell'app: quella funzione legge il segreto
 * dall'ambiente al momento della chiamata, e importarla qui vorrebbe dire
 * legare la prova all'ordine in cui i moduli vengono caricati. Venti righe di
 * HMAC, in cambio di una prova che non dipende da niente.
 */
export function firmaStato(payload: Record<string, unknown>, scadenzaMs?: number): string {
  const corpo = { ...payload, exp: scadenzaMs ?? Date.now() + 60 * 60 * 1000 };
  const codificato = Buffer.from(JSON.stringify(corpo), 'utf8').toString('base64url');
  const firma = createHmac('sha256', AMBIENTE_DI_PROVA.SHOPIFY_API_SECRET)
    .update(codificato)
    .digest('base64url');
  return `${codificato}.${firma}`;
}

/** La firma con cui Shopify accompagna la consegna di un webhook. */
export function firmaWebhook(corpo: string): string {
  return createHmac('sha256', AMBIENTE_DI_PROVA.SHOPIFY_API_SECRET).update(corpo, 'utf8').digest('base64');
}

/** Un abbonamento come lo dichiara Shopify, nella forma che la query legge. */
export function abbonamento(valori: {
  chargeId: string;
  name: string;
  status?: string;
  amount?: string;
  currency?: string;
  interval?: 'EVERY_30_DAYS' | 'ANNUAL';
  trialDays?: number;
  test?: boolean;
}): unknown {
  return {
    data: {
      node: {
        id: `gid://shopify/AppSubscription/${valori.chargeId}`,
        name: valori.name,
        status: valori.status ?? 'ACTIVE',
        test: valori.test ?? true,
        trialDays: valori.trialDays ?? 0,
        currentPeriodEnd: '2026-09-26T00:00:00Z',
        lineItems: [
          {
            plan: {
              pricingDetails: {
                __typename: 'AppRecurringPricing',
                price: { amount: valori.amount ?? '0.00', currencyCode: valori.currency ?? 'EUR' },
                interval: valori.interval ?? 'EVERY_30_DAYS',
              },
            },
          },
        ],
      },
    },
  };
}

/** Le risposte GraphQL che la callback dell'addebito consuma, in blocco. */
export function rispostePerCallback(sub: unknown): {
  match: string;
  body: unknown;
}[] {
  return [
    { match: 'BillingSubscriptionById', body: sub },
    // Dopo l'attivazione la callback chiede quali altri abbonamenti risultino
    // attivi, per marcare i superati. Nessuno: e' il caso normale.
    { match: 'currentAppInstallation', body: { data: { currentAppInstallation: { activeSubscriptions: [] } } } },
    {
      match: 'appSubscriptionCancel',
      body: { data: { appSubscriptionCancel: { appSubscription: null, userErrors: [] } } },
    },
  ];
}
