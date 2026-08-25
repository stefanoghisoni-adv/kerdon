import type { LoaderFunctionArgs } from '@remix-run/node';
import { prisma } from '~/db.server';
import {
  FEED_LIMIT,
  isFeedFormat,
  loadFeedSource,
  recordFetch,
  type FeedFormat,
} from '~/lib/feeds/feed.server';
import { toMetaItem, type MetaItem } from '~/lib/feeds/meta';
import { GMC_FIELDS, toGmcItem } from '~/lib/feeds/gmc';
import { loadMapping, variablesOf } from '~/lib/feeds/mapping.server';
import { toCsv, toXml, type FeedItem } from '~/lib/feeds/serialize';

/**
 * Il catalogo, servito a chi ha l'indirizzo.
 *
 * L'unica rotta dell'app senza sessione Shopify, e non per distrazione: Meta
 * scarica questo file da sola, di notte, senza nessuno che abbia fatto login.
 * Quindi qui non si autentica nessuno — si riconosce un token, e basta quello.
 *
 * Cosa esce da qui: nomi di prodotti, prezzi, immagini e link. Le stesse cose
 * che il negozio mostra a chiunque apra la vetrina. Nessun dato di un cliente
 * passa da questa rotta, e non e' un caso: il feed legge `products` e nient'altro.
 */

/** Un token sbagliato e un feed spento rispondono uguale: non si conferma niente. */
function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function loader({ params }: LoaderFunctionArgs) {
  const file = params.file ?? '';
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return notFound();

  const token = file.slice(0, dot);
  const extension = file.slice(dot + 1).toLowerCase();
  if (!isFeedFormat(extension)) return notFound();

  // Il token e' unico su tutta la tabella: la riga si trova senza sapere di che
  // negozio si tratti, ed e' lei a dirlo.
  const feed = await prisma.productFeed.findUnique({
    where: { token },
    select: { shopId: true, enabled: true, platform: true },
  });
  if (!feed || !feed.enabled) return notFound();

  const source = await loadFeedSource(feed.shopId);
  // Database scollegato: 404 come tutto il resto. Meta ritenta domani, e nel
  // frattempo la tab dell'app dice al merchant cosa manca — questo file non
  // parla con lui.
  if (!source) return notFound();

  const opts = { domain: source.domain, currency: source.currency };

  // Google e Meta chiedono campi diversi con nomi diversi, e Google li lascia
  // scegliere al merchant: la mappatura si legge una volta, non per prodotto.
  const google = feed.platform === 'google';
  const variables = google
    ? variablesOf(await loadMapping(feed.shopId, 'google'))
    : null;

  const items = google
    ? source.products
        .map((product) => toGmcItem(product, variables!, opts))
        .filter((item): item is Record<string, string> => item !== null)
    : (source.products
        .map((product) => toMetaItem(product, opts))
        .filter((item): item is MetaItem => item !== null) as FeedItem[]);

  void recordFetch(token);

  // L'ordine dei campi e' quello della piattaforma: il file di Google ha
  // colonne che Meta non ha, e scriverle nell'ordine sbagliato le fa leggere a
  // Google come campi sconosciuti.
  const fields = google
    ? [...GMC_FIELDS.map((field) => field.name), 'identifier_exists']
    : undefined;

  return respond(extension, items, source.domain, fields);
}

function respond(
  format: FeedFormat,
  items: FeedItem[],
  domain: string,
  fields?: string[],
): Response {
  const body =
    format === 'csv'
      ? toCsv(items, fields)
      : toXml(items, { title: domain, link: `https://${domain}`, fields });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type':
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8',
      // Un quarto d'ora: Meta passa una volta al giorno, ma il merchant apre
      // l'indirizzo a mano per controllare, e a volte lo ricarica dieci volte
      // di fila. Ogni ricarica e' una lettura del suo database.
      'Cache-Control': 'public, max-age=900',
      // L'indirizzo e' segreto finche' non finisce in un indice: se il merchant
      // lo incolla dove un crawler lo vede, almeno non viene pubblicato.
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'X-Feed-Items': String(items.length),
      ...(items.length >= FEED_LIMIT ? { 'X-Feed-Truncated': 'true' } : {}),
    },
  });
}
