/**
 * Il messaggio che una finestra di autorizzazione consegna all'app.
 *
 * La pagina di ritorno di un OAuth (Supabase, Klaviyo) non scambia il codice:
 * lo passa con `postMessage` alla finestra che l'ha aperta, e lo scambio lo fa
 * una rotta autenticata che controlla che il giro sia del negozio della
 * sessione. Questa funzione e' la meta' lato browser di quel patto: decide
 * quali messaggi sono davvero la risposta al clic appena fatto.
 *
 * Regole (tutte, non una):
 * - la finestra aperta da questo clic deve esistere
 * - `event.origin` uguale all'origine dell'app
 * - `event.source` uguale a quella finestra
 * - dati oggetto non null, con il `type` atteso
 * - successo: `code` e `state` stringhe; errore: `ok === false` ed `error` stringa
 *
 * `{ ok: true, data }` per il successo, `{ ok: false, error }` per un esito
 * negativo dichiarato dalla finestra, `{ ok: false }` (senza errore) per tutto
 * il resto, che va ignorato in silenzio.
 */
export type OAuthMessageValidation =
  | { ok: true; data: { code: string; state: string } }
  | { ok: false; error?: string };

export function isValidOAuthMessage(
  event: MessageEvent,
  popupWindow: Window | null,
  appOrigin: string,
  expectedType: string,
): OAuthMessageValidation {
  if (popupWindow === null) return { ok: false };
  if (event.origin !== appOrigin) return { ok: false };
  if (event.source !== popupWindow) return { ok: false };

  const data = event.data as Record<string, unknown> | null;
  if (typeof data !== 'object' || data === null) return { ok: false };
  if (data.type !== expectedType) return { ok: false };

  if (data.ok === false && typeof data.error === 'string') {
    return { ok: false, error: data.error };
  }
  if (typeof data.code === 'string' && typeof data.state === 'string') {
    return { ok: true, data: { code: data.code, state: data.state } };
  }
  return { ok: false };
}
