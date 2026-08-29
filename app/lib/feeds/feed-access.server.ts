import { can, denialOf, type DenialReason } from '~/lib/authz/capabilities';
import { shopCapabilitiesByDomain } from '~/lib/authz/shop-capabilities.server';

/**
 * Se questo negozio puo' avere i feed di catalogo, e — quando non puo' — perche'.
 *
 * Vive sul server e si chiede a ogni azione che accende un feed, non solo
 * quando si disegna il pulsante: un pulsante disabilitato si riabilita
 * dall'ispettore del browser in tre secondi, e da li' in poi la richiesta
 * arriva identica a quella di chi ha pagato. Il controllo che conta e' questo.
 *
 * La domanda non se la risponde piu' da se'. Prima guardava soltanto il piano,
 * e cosi' un negozio sospeso o senza database collegato accendeva feed come
 * chiunque altro — feed che poi non potevano servire niente, perche' il
 * catalogo si legge dal progetto del merchant. Adesso la risposta viene dalla
 * policy, che quelle condizioni le tiene tutte insieme: se domani se ne aggiunge
 * una, arriva qui da sola.
 */
export async function feedsDenial(shopDomain: string): Promise<DenialReason | null> {
  return denialOf(await shopCapabilitiesByDomain(shopDomain), 'use_feeds');
}

/** La stessa domanda, per chi deve solo passare o non passare. */
export async function shopCanUseFeeds(shopDomain: string): Promise<boolean> {
  return can(await shopCapabilitiesByDomain(shopDomain), 'use_feeds');
}
