import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveComplianceWebhook } from '~/lib/gdpr/receipt.server';

/**
 * customers/redact — una persona ha chiesto di essere cancellata.
 *
 * Shopify lo annuncia dieci giorni dopo la richiesta, e da quel momento la
 * responsabilita' e' nostra per la parte che ci compete: togliere il
 * riferimento a quella persona da ogni tabella che lo porta, non dalla prima.
 * Quali siano quelle tabelle, perche' gli ordini si anonimizzano invece di
 * sparire e cosa succede ai browser che la riconoscevano sta scritto in
 * lib/gdpr/customer-record.server e in lib/gdpr/identity-graph.server.
 *
 * La cancellazione avviene dopo la risposta, non dentro: prende il lucchetto
 * della sincronizzazione, e una corsa in corso la farebbe aspettare ben oltre i
 * cinque secondi che Shopify concede alla ricevuta.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveComplianceWebhook(request, 'customers/redact', { requireCustomer: true });
}
