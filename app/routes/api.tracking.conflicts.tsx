import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import {
  detectTrackingChannels,
  detectThemeTracking,
  themeFilesToInspect,
  type TrackingFinding,
} from '~/lib/tracking/detect';

/**
 * Che cosa sta gia' inviando eventi su questo negozio.
 *
 * Best effort su entrambi i fronti: se una delle due letture fallisce si
 * restituisce quello che si e' potuto vedere, invece di non dire niente. Il
 * risultato e' comunque un elenco parziale per costruzione — i pixel
 * personalizzati non sono leggibili da nessuna app — e l'interfaccia lo dichiara.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  // Due chiamate a Shopify — i canali collegati e i file del tema pubblicato —
  // e il permesso viene prima di tutt'e due: sono il contenuto della vetrina
  // del negozio, non un dato di servizio.
  const { shop } = await requireShopCapability(request, 'use_app');

  const client = await ShopifyAPIClient.forShop(shop.shopDomain);
  const findings: TrackingFinding[] = [];
  let partial = false;

  // Fonti che il merchant ha gia' valutato e dichiarato innocue: si continuano a
  // rilevare, ma non gliene si parla piu'.
  const dismissed = await prisma.dismissedTrackingSource.findMany({
    where: { shopId: shop.id },
    select: { kind: true, name: true },
  });
  const isDismissed = (f: TrackingFinding) =>
    dismissed.some((d) => d.kind === f.kind && d.name === f.name);

  let themeId: number | null = null;

  try {
    findings.push(...detectTrackingChannels(await client.getPublications()));
  } catch (err) {
    partial = true;
    console.warn(
      '[api.tracking.conflicts] canali non leggibili:',
      err instanceof Error ? err.message : 'errore sconosciuto',
    );
  }

  try {
    // Prima i nomi, poi il contenuto dei soli file che interessano: chiedere il
    // corpo dell'intero tema costerebbe molto e servirebbe a niente.
    const theme = await client.getPublishedTheme();
    themeId = theme.id;
    const wanted = themeFilesToInspect(theme.filenames);
    if (wanted.length > 0) {
      findings.push(...detectThemeTracking(await client.getThemeFiles(wanted)));
    }
  } catch (err) {
    partial = true;
    console.warn(
      '[api.tracking.conflicts] tema non leggibile:',
      err instanceof Error ? err.message : 'errore sconosciuto',
    );
  }

  // Qui NON si segna niente come fatto. Il controllo ha una risposta, ma averla
  // non vuol dire che qualcuno l'abbia letta: il passo si chiude quando il
  // merchant lo dice, da `api.tracking.confirm`. Segnandolo qui, il terzo passo
  // si completava nell'istante in cui si apriva e sbloccava il quarto insieme,
  // lasciando davanti due passi aperti di cui uno mai guardato.

  return json({
    findings: findings.filter((f) => !isDismissed(f)),
    partial,
    // Quante ne ha messe a tacere: serve a poterglielo ricordare, invece di far
    // sparire l'informazione per sempre senza modo di tornarci.
    dismissedCount: dismissed.length,
    // Indirizzi dell'admin per i pulsanti: si costruiscono qui perche' solo il
    // server conosce il dominio del negozio e l'id del tema pubblicato.
    adminBase: `https://admin.shopify.com/store/${shop.shopDomain.replace('.myshopify.com', '')}`,
    themeId,
  });
}
