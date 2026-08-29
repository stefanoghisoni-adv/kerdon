import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveComplianceWebhook } from '~/lib/gdpr/receipt.server';

/**
 * shop/redact — il negozio ha disinstallato e sono passate quarantotto ore.
 *
 * Da qui in poi di quel negozio non dobbiamo tenere piu' niente. "Niente" e'
 * una parola precisa: non solo la riga del negozio, ma anche le sessioni, che
 * al negozio non sono legate da nessun vincolo e quindi non se ne vanno in
 * cascata — e dentro hanno l'access token e il nome, il cognome e l'email di
 * chi ha installato l'app. L'inventario completo, e cosa resta al merchant,
 * stanno in lib/gdpr/shop-record.server.
 *
 * Il payload non porta nessun cliente: qui la persona e' il negozio.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveComplianceWebhook(request, 'shop/redact', { requireCustomer: false });
}
