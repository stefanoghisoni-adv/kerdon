// app/routes/api.product-scope.tsx
//
// Quanti prodotti si aggiornano, quanti sono fermi, e da quando.
//
// PERCHE' UNA ROTTA E NON UN CAMPO NEL LOADER DELLA DASHBOARD. Perche'
// l'avviso che consuma questi numeri compare in piu' pagine, e ognuna avrebbe
// dovuto caricarseli nel proprio loader — con il rischio, che si e' gia' corso
// altrove, di mostrare due numeri diversi per la stessa cosa. E' la stessa
// scelta gia' fatta per l'avviso del tetto prodotti.
import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { productScopeSummary } from '~/lib/sync/product-scope.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';

export async function loader({ request }: LoaderFunctionArgs) {
  // Quanti prodotti si stanno aggiornando e da quando e' lo stato della
  // sincronizzazione di questo negozio: il permesso prima, come per gli altri
  // numeri che l'avviso mostra accanto.
  const { shop } = await requireShopCapability(request, 'use_app');

  const summary = await productScopeSummary(shop.id);

  return json({
    active: summary.active,
    paused: summary.paused,
    // ISO, non gia' formattata: qui non si sa in che fuso vive il merchant, e
    // indovinarlo darebbe una data sbagliata di un giorno a chi sta dall'altra
    // parte del mondo.
    pausedDataFrom: summary.pausedDataFrom ? summary.pausedDataFrom.toISOString() : null,
  });
}
