import { randomBytes } from 'node:crypto';
import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQueryRows } from '~/lib/supabase-management.server';
import type { FeedProduct } from './meta';

/**
 * Il feed di una piattaforma: la riga che lo descrive, e il catalogo da
 * mettere dentro.
 *
 * Una cosa sola non e' come nel resto dell'app: qui l'indirizzo e' pubblico.
 * Meta scarica il file senza autenticarsi — non c'e' un OAuth da fare, non c'e'
 * una chiave da darle — quindi l'unica difesa e' che quell'indirizzo sia
 * impossibile da indovinare e facile da sostituire.
 */

/** Le piattaforme che sanno leggere un feed di catalogo. */
export const PLATFORMS = ['meta', 'google'] as const;
export type Platform = (typeof PLATFORMS)[number];

export type FeedFormat = 'xml' | 'csv';

export function isFeedFormat(value: string): value is FeedFormat {
  return value === 'xml' || value === 'csv';
}

/**
 * 32 byte di casualita'.
 *
 * Non e' un identificatore, e' una password che viaggia in un indirizzo: chi la
 * indovina legge il catalogo. Un uuid non basterebbe — e' fatto per essere
 * unico, non per essere segreto.
 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface FeedView {
  platform: string;
  token: string;
  format: FeedFormat;
  enabled: boolean;
  lastFetchedAt: string | null;
  fetchCount: number;
}

function view(row: {
  platform: string;
  token: string;
  format: string;
  enabled: boolean;
  lastFetchedAt: Date | null;
  fetchCount: number;
}): FeedView {
  return {
    platform: row.platform,
    token: row.token,
    format: isFeedFormat(row.format) ? row.format : 'xml',
    enabled: row.enabled,
    lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
    fetchCount: row.fetchCount,
  };
}

export async function getFeed(shopId: string, platform: Platform): Promise<FeedView | null> {
  const row = await prisma.productFeed.findUnique({
    where: { shopId_platform: { shopId, platform } },
  });
  return row ? view(row) : null;
}

export async function listFeeds(shopId: string): Promise<FeedView[]> {
  const rows = await prisma.productFeed.findMany({ where: { shopId } });
  return rows.map(view);
}

/**
 * Accende il feed, o restituisce quello che c'e' gia'.
 *
 * Premere due volte "Attiva" non deve generare un secondo indirizzo: il primo
 * potrebbe essere gia' incollato dentro Meta, e sostituirlo di nascosto
 * lascerebbe il catalogo a leggere un file che non risponde piu'.
 */
export async function enableFeed(
  shopId: string,
  platform: Platform,
  format: FeedFormat = 'xml',
): Promise<FeedView> {
  const row = await prisma.productFeed.upsert({
    where: { shopId_platform: { shopId, platform } },
    create: { shopId, platform, token: newToken(), format },
    update: { enabled: true, format },
  });
  return view(row);
}

export async function disableFeed(shopId: string, platform: Platform): Promise<void> {
  await prisma.productFeed.updateMany({
    where: { shopId, platform },
    data: { enabled: false },
  });
}

/**
 * Cancella l'integrazione.
 *
 * Diverso da spegnerla: la riga sparisce, il token con lei, e riattivando si
 * riparte da un indirizzo nuovo. E' quello che serve a chi vuole "togliere
 * tutto" davvero.
 *
 * Cosa NON succede, ed e' il motivo per cui il pulsante puo' esistere: qui non
 * si tocca niente su Meta. Il catalogo, gli shop e le campagne che li usano
 * restano dove sono — quello che smette e' solo il file che li aggiornava.
 */
export async function deleteFeed(shopId: string, platform: Platform): Promise<void> {
  await prisma.productFeed.deleteMany({ where: { shopId, platform } });
}

/**
 * Sostituisce il token.
 *
 * L'indirizzo vecchio smette di rispondere nello stesso istante — che e'
 * esattamente il punto — e il merchant deve reincollare quello nuovo dentro
 * Meta. La tab lo dice prima di farlo.
 */
export async function rotateToken(shopId: string, platform: Platform): Promise<FeedView> {
  const row = await prisma.productFeed.update({
    where: { shopId_platform: { shopId, platform } },
    data: { token: newToken(), lastFetchedAt: null, fetchCount: 0 },
  });
  return view(row);
}

/** L'indirizzo da incollare dentro Meta. */
export function feedUrl(token: string, format: FeedFormat): string {
  const base = (process.env.SHOPIFY_APP_URL ?? '').replace(/\/+$/, '');
  return `${base}/feed/${token}.${format}`;
}

/**
 * Le colonne che servono al feed, e nient'altro.
 *
 * Il catalogo di un negozio grosso e' lungo: chiedere `select *` porterebbe
 * dentro descrizioni, note e costi che al file non servono, su una rotta che
 * gira ogni giorno.
 */
const FEED_COLUMNS = [
  'shopify_product_id',
  'shopify_variant_id',
  'product_title',
  'product_description',
  'vendor',
  'product_type',
  'handle',
  'product_status',
  'variant_title',
  'sku',
  'barcode',
  'price',
  'compare_at_price',
  'inventory_quantity',
  'inventory_tracked',
  'inventory_policy',
  'image_url',
  // Solo Google li usa, ma la lettura e' una sola per entrambi i feed: due
  // query diverse per due piattaforme sarebbero due volte lo stesso lavoro.
  'weight',
  'tags',
  'option1',
  'option2',
  'option3',
].join(', ');

export function feedProductsSQL(limit: number): string {
  // L'ordine e' quello del prodotto e della sua posizione fra le varianti: le
  // righe di uno stesso articolo restano vicine, che e' come Meta si aspetta di
  // trovarle e come il merchant legge la tabella.
  return `
    SELECT ${FEED_COLUMNS}
    FROM products
    ORDER BY shopify_product_id, position NULLS LAST, shopify_variant_id
    LIMIT ${Math.max(1, Math.floor(limit))}
  `;
}

/** Il tetto di righe che una singola lettura porta via. */
export const FEED_LIMIT = 50_000;

export interface FeedSource {
  products: FeedProduct[];
  domain: string;
  currency: string;
}

/**
 * Il catalogo, dal database del merchant.
 *
 * Legge da li' e non da Shopify di proposito: il feed dice quello che l'app ha
 * sincronizzato, non quello che c'e' su Shopify in questo istante. Se i due non
 * coincidono il problema e' la sincronizzazione, e va visto li' — non nascosto
 * da un feed che va a prendersi i dati altrove.
 */
export async function loadFeedSource(shopId: string): Promise<FeedSource | null> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      shopDomain: true,
      primaryDomain: true,
      shopCurrency: true,
      supabaseConfig: { select: { supabaseProjectRef: true, connectionVerifiedAt: true } },
    },
  });

  const ref = shop?.supabaseConfig?.supabaseProjectRef;
  if (!shop || !ref || !shop.supabaseConfig?.connectionVerifiedAt) return null;

  const token = await getValidAccessToken(shopId);
  const products = await runQueryRows<FeedProduct>(token, ref, feedProductsSQL(FEED_LIMIT));

  return {
    products,
    // Il dominio pubblico, non quello myshopify: e' l'indirizzo su cui il
    // cliente atterra dall'inserzione, e quello tecnico farebbe una brutta
    // figura nella barra del browser.
    domain: shop.primaryDomain ?? shop.shopDomain,
    currency: shop.shopCurrency ?? 'EUR',
  };
}

/**
 * Segna il passaggio di Meta.
 *
 * Best effort: se questa scrittura fallisce il file e' gia' partito, e non
 * vale la pena rispondere con un errore a chi ha ottenuto il suo catalogo.
 */
export async function recordFetch(token: string): Promise<void> {
  try {
    await prisma.productFeed.update({
      where: { token },
      data: { lastFetchedAt: new Date(), fetchCount: { increment: 1 } },
    });
  } catch (error) {
    console.warn(
      '[feed] non ho potuto registrare la lettura:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
  }
}
