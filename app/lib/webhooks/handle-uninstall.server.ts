// app/lib/webhooks/handle-uninstall.server.ts
//
// Cosa succede davvero quando un merchant disinstalla, adesso che succede dopo
// la ricevuta e non piu' dentro la risposta a Shopify.
//
// COSA NON SI TOCCA, ED E' LA PARTE IMPORTANTE. Il collegamento al database e i
// dati gia' sincronizzati restano dove sono. Le tabelle stanno nel progetto del
// merchant, sono sue, e chi disinstalla non sta chiedendo di cancellarle — sta
// solo smettendo di aggiornarle. Reinstallando ritrova tutto al suo posto.
//
// COSA SI FERMA. `uninstalledAt` e' l'interruttore: le code e il cron cercano
// solo i negozi che ce l'hanno vuoto, e la policy delle capacita' nega tutto —
// `use_app` per primo, e quindi tutto quello che ne discende — al primo sguardo
// su quella colonna. Non c'e' nessuna revoca da scrivere altrove: le capacita'
// non sono righe, sono una decisione presa ogni volta da questa colonna.
//
// LE SESSIONI SI CANCELLANO. Alla disinstallazione Shopify revoca il token,
// quindi quelle righe non aprono piu' niente: tenerle sarebbe solo un segreto
// morto in un database, e dentro ci sono anche nome, cognome ed email di chi ha
// installato l'app.
//
// IL TOKEN DI LETTURA NON SI CANCELLA, E NON E' UNA DIMENTICANZA. Smette di
// valere lo stesso istante: `use_read_proxy` parte da `uninstalledAt`, quindi
// dopo questa transazione il proxy nega qualunque richiesta lo porti. Quel che
// resta e' il segreto a riposo, e cancellarlo costerebbe al merchant che
// reinstalla la riconfigurazione del suo container in vetrina — un prezzo vero
// per un gesto che e' reversibile per costruzione. Cio' che andava chiuso e'
// la finestra della cache, ed e' chiusa qui sotto.

import { prisma } from '~/db.server';
import { invalidateReadContextForDomain } from '~/lib/read-proxy/context.server';
import type { ClaimedWebhookEvent } from './inbox.server';
import type { WebhookOutcome } from './inbox-model';

/**
 * Applica la disinstallazione. Idempotente per costruzione.
 *
 * La condizione `uninstalledAt: null` non e' un'ottimizzazione: senza, una
 * seconda lavorazione dello stesso evento sposterebbe la data in avanti, e da
 * quella data si legge da quanto un negozio e' andato via.
 *
 * Le due scritture stanno in una transazione perche' descrivono un fatto solo.
 * A meta' il negozio risulterebbe ancora installato con le sessioni gia'
 * cancellate — cioe' un negozio che le code continuano a cercare e per cui non
 * esiste piu' nessun modo di parlare con Shopify.
 */
export async function handleAppUninstalled(
  event: ClaimedWebhookEvent,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  await markShopUninstalled(event.shopDomain, now, event.id);
  return 'done';
}

/**
 * La disinstallazione applicata, senza sapere da dove arriva la notizia.
 *
 * Due chiamanti: questo webhook, e la riconciliazione periodica per i negozi
 * che Shopify non riconosce piu' — quelli il cui webhook e' andato perso fuori
 * dalla finestra dei ritentativi. Devono fare la stessa identica cosa, e finche'
 * la facevano in due posti diversi la seconda non la faceva affatto.
 */
export async function markShopUninstalled(
  shopDomain: string,
  now: Date = new Date(),
  eventId?: string,
): Promise<void> {
  // Il riferimento interno del negozio, per poterlo scrivere sull'evento: e'
  // l'unico modo di ritrovare l'evento partendo dal negozio senza rimettere il
  // dominio in altre venti query.
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  await prisma.$transaction([
    // updateMany e non update: su un negozio che non abbiamo mai avuto non
    // lancia, si limita a non toccare niente. Questo webhook arriva anche per
    // installazioni mai completate.
    prisma.shop.updateMany({
      where: { shopDomain, uninstalledAt: null },
      data: { uninstalledAt: now },
    }),
    prisma.session.deleteMany({ where: { shop: shopDomain } }),
    ...(eventId
      ? [
          prisma.webhookEvent.updateMany({
            where: { id: eventId },
            data: { shopId: shop?.id ?? null },
          }),
        ]
      : []),
  ]);

  // Il proxy di lettura tiene in cache un "puo' leggere" deciso prima di
  // adesso. Il token resta incollato nel container della vetrina anche dopo la
  // disinstallazione, e finche' quella riga non scade continuerebbe a farsi
  // servire i clienti di un negozio che con noi ha chiuso.
  //
  // Fuori dalla transazione perche' non e' una scrittura: e' memoria di questo
  // processo, e non si puo' disfare. Dopo, e non prima: annullarla mentre la
  // transazione e' ancora aperta lascerebbe la prima lettura successiva a
  // rimettere in cache lo stato vecchio.
  invalidateReadContextForDomain(shopDomain);
}
