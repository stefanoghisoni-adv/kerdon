/**
 * La pagina che chiude la finestra di autorizzazione.
 *
 * Vive fuori dall'admin di Shopify — e' una finestra a se' — quindi l'unico
 * modo di riportare l'esito all'app e' un messaggio alla finestra che l'ha
 * aperta. Serviva a Supabase, serve a Meta, servira' alla prossima: il codice
 * era uno solo e stava dentro una rotta.
 */

/**
 * Serializza un valore per finire dentro un tag `<script>`.
 *
 * `JSON.stringify` non neutralizza `</script>` ne' i separatori di riga
 * U+2028/U+2029: un messaggio d'errore riflesso dalla piattaforma potrebbe
 * spezzare il tag ed eseguire codice. Si scappano `<`, `>`, `&` e i due
 * separatori.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/** L'origine dell'app: il messaggio va li' e da nessun'altra parte. */
export function appOriginFrom(requestUrl: string): string {
  return new URL(process.env.SHOPIFY_APP_URL || new URL(requestUrl).origin).origin;
}

export function closePopupPage(
  message: Record<string, unknown>,
  appOrigin: string,
): Response {
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
