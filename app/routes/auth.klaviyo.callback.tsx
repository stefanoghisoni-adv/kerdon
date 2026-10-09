import type { LoaderFunctionArgs } from '@remix-run/node';
import { oauthCallbackPage } from '~/lib/oauth-callback-page.server';

function closePage(message: Record<string, unknown>, appOrigin: string): Response {
  return oauthCallbackPage(message, appOrigin);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const appOrigin = new URL(process.env.SHOPIFY_APP_URL || url.origin).origin;

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (error) {
    // Map Klaviyo errors to fixed codes, never forward raw values
    const mappedError = error === 'access_denied' ? 'denied' : 'failed';
    return closePage(
      { type: 'klaviyo-oauth', ok: false, error: mappedError },
      appOrigin,
    );
  }

  if (!code || !state) {
    return closePage(
      { type: 'klaviyo-oauth', ok: false, error: 'missing_code_or_state' },
      appOrigin,
    );
  }

  return closePage({ type: 'klaviyo-oauth', code, state }, appOrigin);
}
