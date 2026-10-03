import type { LoaderFunctionArgs } from '@remix-run/node';

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

function closePage(message: Record<string, unknown>, appOrigin: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
(function () {
  try {
    if (window.opener) {
      window.opener.postMessage(${jsonForScript(message)}, ${jsonForScript(appOrigin)});
    }
  } catch (e) {}
  window.close();
})();
</script>
<p>Puoi chiudere questa finestra.</p>
</body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const appOrigin = new URL(process.env.SHOPIFY_APP_URL || url.origin).origin;

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (error) {
    return closePage(
      { type: 'klaviyo-oauth', ok: false, error: error === 'access_denied' ? 'denied' : error },
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
