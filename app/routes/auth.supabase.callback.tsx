import type { LoaderFunctionArgs } from '@remix-run/node';
import { oauthCallbackPage } from '~/lib/oauth-callback-page.server';

/**
 * Il ritorno da Supabase: consegna, non decide.
 *
 * Questa pagina vive fuori dall'admin di Shopify e non ha una sessione: sa solo
 * cosa c'e' nell'URL. Se scambiasse il codice e salvasse i token da se', il
 * collegamento finirebbe sul negozio scritto nello `state` — e chi riceve da
 * un altro negozio un link di autorizzazione gia' pronto, approvandolo,
 * collegherebbe il PROPRIO account Supabase a quel negozio.
 *
 * Per questo qui non si scambia e non si salva niente: codice e stato vanno
 * alla finestra dell'app che ha aperto questa (solo alla sua origine), e lo
 * scambio lo fa `api.supabase.connect`, autenticata, solo se lo `state` e'
 * del negozio della sessione. E' lo stesso disegno del ritorno da Klaviyo.
 */

const COPY = { connectLabel: { it: 'Collega Supabase', en: 'Connect Supabase' } };

function closePage(message: Record<string, unknown>, appOrigin: string): Response {
  return oauthCallbackPage(message, appOrigin, COPY);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const appOrigin = new URL(process.env.SHOPIFY_APP_URL || url.origin).origin;

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (error) {
    // Codici fissi: il valore grezzo di Supabase non passa alla finestra.
    const mapped = error === 'access_denied' ? 'denied' : 'failed';
    return closePage({ type: 'supabase-oauth', ok: false, error: mapped }, appOrigin);
  }
  if (!code || !state) {
    return closePage(
      { type: 'supabase-oauth', ok: false, error: 'missing_code_or_state' },
      appOrigin,
    );
  }

  return closePage({ type: 'supabase-oauth', code, state }, appOrigin);
}
