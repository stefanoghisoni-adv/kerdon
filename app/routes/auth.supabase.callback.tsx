import type { LoaderFunctionArgs } from '@remix-run/node';

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

// Serializza un valore per l'inserimento sicuro dentro un tag <script>.
// JSON.stringify NON neutralizza `</script>` né i separatori di riga
// U+2028/U+2029: `code` e `state` arrivano dall'URL, e chi li scrive potrebbe
// spezzare il tag ed eseguire codice (XSS). Escapiamo `<`, `>`, `&` e i due
// separatori di riga come escape unicode.
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
<p>Puoi chiudere questa finestra. / You can close this window.</p>
</body></html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Il codice OAuth viaggia nell'URL di questa pagina: non va tenuto in
      // nessuna cache ne' passato come Referer.
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
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
