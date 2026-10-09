/**
 * La pagina di ritorno di un OAuth, aperta in una finestra dall'app.
 *
 * Consegna l'esito alla finestra dell'app con `postMessage` (solo alla sua
 * origine) e si chiude. Non scambia e non salva niente: lo fa la rotta
 * autenticata dell'integrazione, per il negozio della sessione.
 *
 * Il caso da non sbagliare e' quello senza `window.opener`: una pagina del
 * fornitore puo' tagliare il legame con la finestra che l'ha aperta (succede
 * su Supabase dopo aver creato account o organizzazione). Li' il codice non
 * arriva a nessuno, e chiudere dicendo "puoi chiudere" lascerebbe il merchant
 * convinto di aver finito. Allora la finestra resta aperta e dice cosa fare.
 */

// Serializza un valore per l'inserimento sicuro dentro un tag <script>.
// JSON.stringify NON neutralizza `</script>` ne' i separatori di riga
// U+2028/U+2029: `code` e `state` arrivano dall'URL, e chi li scrive potrebbe
// spezzare il tag ed eseguire codice (XSS). Escapiamo `<`, `>`, `&` e i due
// separatori di riga come escape unicode.
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

// Solo dentro il testo di un <p>: le virgolette li' non sono speciali.
function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface CallbackPageCopy {
  /** Il nome del pulsante nell'app, per lingua: «Collega Supabase». */
  connectLabel: { it: string; en: string };
}

export function oauthCallbackPage(
  message: Record<string, unknown>,
  appOrigin: string,
  copy: CallbackPageCopy,
): Response {
  const back =
    `Torna su Kerdon e clicca di nuovo «${copy.connectLabel.it}» per completare. / ` +
    `Go back to Kerdon and click "${copy.connectLabel.en}" again to finish.`;
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Kerdon</title>
<style>
  body { margin: 0; background: #f1f1f1; color: #303030; color-scheme: light;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
  main { max-width: 420px; margin: 48px auto; padding: 20px; background: #ffffff;
    border-radius: 12px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
  p { margin: 0; }
</style>
</head><body><main>
<p id="torna" hidden>${escapeHtml(back)}</p>
<p id="chiudi" hidden>Puoi chiudere questa finestra. / You can close this window.</p>
<noscript><p>${escapeHtml(back)}</p></noscript>
</main>
<script>
(function () {
  if (window.opener) {
    try {
      window.opener.postMessage(${jsonForScript(message)}, ${jsonForScript(appOrigin)});
    } catch (e) {}
    document.getElementById('chiudi').hidden = false;
    window.close();
  } else {
    document.getElementById('torna').hidden = false;
  }
})();
</script>
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
