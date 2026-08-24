import type { LoaderFunctionArgs } from '@remix-run/node';
import { verifyState } from '~/lib/oauth-state.server';
import {
  exchangeForLongLivedToken,
  exchangeMetaCode,
  metaCredentials,
  metaRedirectUri,
  saveMetaToken,
} from '~/lib/integrations/meta/oauth.server';
import { appOriginFrom, closePopupPage } from '~/lib/integrations/oauth-popup.server';

/**
 * Il ritorno dall'autorizzazione di Meta.
 *
 * Non e' autenticata da Shopify e non puo' esserlo: e' una finestra fuori
 * dall'admin. Di chi sia il negozio lo dice il `state` firmato, che e' l'unica
 * cosa che il browser non puo' falsificare.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const appOrigin = appOriginFrom(request.url);
  const close = (message: Record<string, unknown>) =>
    closePopupPage({ type: 'meta-oauth', ...message }, appOrigin);

  const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
  if (error) return close({ ok: false, error });

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return close({ ok: false, error: 'missing_code_or_state' });

  const verified = verifyState(state);
  if (!verified) return close({ ok: false, error: 'invalid_state' });

  const credentials = metaCredentials();
  if (!credentials) {
    console.error('[meta callback] integrazione non configurata');
    return close({ ok: false, error: 'not_configured' });
  }

  try {
    const short = await exchangeMetaCode({
      code,
      redirectUri: metaRedirectUri(),
      credentials,
    });
    // Subito il cambio in token lungo: quello appena ricevuto vive un'ora, e
    // salvarlo com'e' vorrebbe dire ritrovarsi scollegati entro sera.
    const long = await exchangeForLongLivedToken({ token: short.access_token, credentials });
    await saveMetaToken(verified.shopId, long);
    return close({ ok: true });
  } catch (e) {
    console.error('[meta callback]', e instanceof Error ? e.message : 'errore sconosciuto');
    return close({ ok: false, error: 'exchange_failed' });
  }
}
