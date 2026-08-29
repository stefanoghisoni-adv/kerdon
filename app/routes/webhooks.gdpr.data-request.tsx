import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveComplianceWebhook } from '~/lib/gdpr/receipt.server';

/**
 * customers/data_request — una persona vuole sapere cosa sappiamo di lei.
 *
 * L'errore da non fare e' rispondere con la sola riga della tabella clienti.
 * Il diritto di accesso non riguarda la tabella che porta il nome "clienti":
 * riguarda tutto quello che e' riconducibile a quella persona, e per questa app
 * vuol dire anche i suoi ordini, le righe di quegli ordini e i browser da cui
 * l'abbiamo riconosciuta. Sono le stesse tabelle che la cancellazione deve
 * svuotare, e non e' una coincidenza: se una tabella conta per l'una deve
 * contare per l'altra, altrimenti una delle due sta mentendo.
 *
 * Qui non si esporta niente. Si prende in carico e si risponde — il perche' sta
 * in lib/gdpr/receipt.server, e l'esportazione la costruisce e la consegna
 * lib/gdpr/process-compliance.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveComplianceWebhook(request, 'customers/data_request', { requireCustomer: true });
}
