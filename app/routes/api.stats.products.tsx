// app/routes/api.stats.products.tsx
import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import {
  collectProblemVariants,
  computeProductReadiness,
  type ProblemVariant,
} from '~/lib/stats/product-readiness';
import { enrichVariantCosts } from '~/lib/stats/inventory-cost.server';
import { getReadinessCache, setReadinessCache } from '~/lib/cache/stats-cache.server';
import { upsertTodayEligibilitySnapshot } from '~/lib/stats/eligibility-snapshot.server';
import { loadSoldVariantIds } from '~/lib/stats/sold-variants.server';
import { countSoldProblemVariants } from '~/lib/stats/sold-without-cost';
import { requireShopCapability } from '~/lib/authz/require-capability.server';

export async function loader({ request }: LoaderFunctionArgs) {
  // Prima della cache, e non solo prima di Shopify: anche l'ultimo numero noto
  // e' un dato del negozio, e servirlo a chi non puo' piu' usare l'app sarebbe
  // lo stesso rifiuto aggirato con un giro piu' corto.
  const { session, shop } = await requireShopCapability(request, 'use_app');

  // Cache-then-refresh: senza ?refresh=1 restituiamo SUBITO l'ultimo valore in
  // cache (riapertura istantanea). Il client, vedendo cached:true, richiama poi
  // l'endpoint con ?refresh=1 per il ricalcolo live in background.
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  if (!refresh) {
    const cached = await getReadinessCache(shop.id);
    if (cached) {
      return json({
        totalProducts: cached.totalProducts,
        totalVariants: cached.readyCount + cached.problemCount,
        readyCount: cached.readyCount,
        problemCount: cached.problemCount,
        // Puo' mancare: le scritture in cache fatte altrove (il ricontrollo
        // della tab Prodotti) non sanno ricalcolarlo. Assente vuol dire che
        // l'avviso non si mostra finche' non arriva il ricalcolo live — meglio
        // di un avviso che annuncia un numero vecchio.
        soldWithoutCost: cached.soldWithoutCost ?? null,
        cached: true,
      });
    }
  }

  try {
    return json(await computeReadiness(shop.id, shop.shopDomain, session.shop));
  } catch (err) {
    // Un guasto di Shopify non deve diventare una card rotta.
    //
    // Il 4 settembre due letture del catalogo a un secondo di distanza hanno
    // dato una il catalogo e l'altra INTERNAL_SERVER_ERROR: la dashboard ha
    // risposto 500 su una card che al richiamo dopo si sarebbe riempita da
    // sola, e nei log non c'era una riga che dicesse perche'. Il client adesso
    // ritenta i guasti passeggeri; quando anche i tentativi finiscono, qui si
    // dice ad alta voce che cos'e' successo e si mostra l'ultimo numero noto.
    console.error(`[api.stats.products] lettura del catalogo fallita per ${session.shop}:`, err);

    const cached = await getReadinessCache(shop.id);
    if (!cached) throw err;

    return json({
      totalProducts: cached.totalProducts,
      totalVariants: cached.readyCount + cached.problemCount,
      readyCount: cached.readyCount,
      problemCount: cached.problemCount,
      soldWithoutCost: cached.soldWithoutCost ?? null,
      cached: true,
      // Il numero e' vecchio ed e' vecchio per un guasto, non perche' nessuno
      // abbia ancora chiesto il ricalcolo. Chi legge la risposta deve poter
      // distinguere i due casi: dal primo si esce da soli, dal secondo no.
      stale: true,
    });
  }
}

/**
 * La lettura del catalogo, dalla prima pagina al conteggio finale.
 *
 * Sta in una funzione sua perche' e' tutto e solo cio' che dipende da Shopify:
 * il chiamante ci mette intorno il try, e non deve stare attento a quali righe
 * comprendere e quali no.
 */
async function computeReadiness(shopId: string, shopDomain: string, sessionShop: string) {
  const client = await ShopifyAPIClient.forShop(shopDomain);

  let totalProducts = 0;
  let readyCount = 0;
  let problemCount = 0;
  let pageInfo: string | undefined;
  // Le righe senza costo, non solo il loro numero: da qui esce anche l'avviso
  // dei prodotti venduti senza costo, e quell'avviso deve annunciare la
  // lunghezza dell'elenco vero — non una stima presa da un'altra parte.
  const problemRows: ProblemVariant[] = [];

  // Scomposizione pronti/problemi: richiede il dato per-variante, quindi la
  // paginazione completa è inevitabile. La alleggeriamo però al minimo indispensabile
  // (`fields=id,variants`): la readiness legge solo variants.cost, non serve scaricare
  // immagini, tag, descrizioni. I conteggi totali stanno nell'endpoint /api/stats/counts.
  do {
    const { products, nextPageInfo } = await client.getProducts({
      limit: 250,
      pageInfo,
      fields: 'id,variants',
    });
    // Il cost_per_item vive sull'InventoryItem: lo popoliamo prima di classificare,
    // altrimenti variant.cost sarebbe sempre vuoto e tutto risulterebbe "problema".
    const enriched = await enrichVariantCosts(client, products ?? []);
    const counts = computeProductReadiness(enriched);
    totalProducts += counts.totalProducts;
    readyCount += counts.readyCount;
    problemCount += counts.problemCount;
    problemRows.push(...collectProblemVariants(enriched));
    pageInfo = nextPageInfo ?? undefined;
  } while (pageInfo);

  // L'avviso della dashboard nasce qui e non da una riga di conteggio sul
  // database del merchant. Il motivo sta in `sold-without-cost.ts`: in quel
  // database ci sono solo i prodotti idonei e solo fino al tetto del piano,
  // quindi "manca la riga" non significa "manca il costo", e l'avviso finiva per
  // annunciare prodotti che l'elenco non poteva mostrare. Il catalogo lo stiamo
  // gia' leggendo per la readiness: chiedere al merchant che cosa ha venduto
  // costa una riga di query in piu', non una seconda passata su Shopify.
  const sold = await loadSoldVariantIds(sessionShop);
  const soldWithoutCost = countSoldProblemVariants(problemRows, sold.ids);

  const result = { totalProducts, readyCount, problemCount, soldWithoutCost };
  await setReadinessCache(shopId, result);

  // Aggiorna lo snapshot di oggi: i prodotti possono diventare idonei durante la
  // giornata (il merchant inserisce i costi mancanti dalla tab "Prodotti con problemi"),
  // ma il cron passa una sola volta. Un problema sullo snapshot non deve far fallire
  // l'endpoint, che serve alla dashboard.
  // Contiamo le VARIANTI idonee (readyCount), non i prodotti distinti: su Supabase
  // scriviamo una riga per variante, quindi e' quello il numero "sincronizzabile"
  // che il merchant vede nella card e nel recap.
  try {
    await upsertTodayEligibilitySnapshot(shopId, readyCount);
  } catch (err) {
    console.error('Failed to update today eligibility snapshot:', err);
  }

  return { ...result, totalVariants: readyCount + problemCount, cached: false };
}
