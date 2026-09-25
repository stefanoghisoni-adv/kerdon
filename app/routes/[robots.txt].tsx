import type { LoaderFunctionArgs } from '@remix-run/node';
import { PRIVACY_POLICY_PATH } from '~/lib/legal/privacy-policy';

/**
 * Questo host non e' un sito: e' il backend di un'app Shopify.
 *
 * Non c'e' quasi niente da indicizzare — ogni rotta vive dentro il riquadro
 * dell'admin — e senza questo file i crawler continuano a chiederlo, con
 * un'invocazione che paghiamo per rispondere "non c'e'".
 *
 * L'ECCEZIONE E' L'INFORMATIVA SULLA PRIVACY, e va scritta qui perche' altrimenti
 * la prima riga la esclude come tutto il resto. E' l'unica pagina di questo
 * host fatta per essere letta da fuori: il suo indirizzo compare sulla scheda
 * dell'App Store e nei documenti, e una pagina che si dichiara pubblica e poi
 * si vieta ai motori si contraddice da sola.
 */
export async function loader(_args: LoaderFunctionArgs) {
  return new Response(
    `User-agent: *\nDisallow: /\nAllow: ${PRIVACY_POLICY_PATH}\n`,
    {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        // Un giorno: cambia praticamente mai, e non deve costare una richiesta
        // al giorno per negozio.
        'Cache-Control': 'public, max-age=86400',
      },
    },
  );
}
