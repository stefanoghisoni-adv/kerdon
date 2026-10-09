import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const exchangeCode = vi.fn();
const saveTokens = vi.fn();
const verifyState = vi.fn();

// Se la pagina di ritorno tornasse a scambiare il codice o a salvare i token,
// questi mock se ne accorgerebbero: e' esattamente il difetto da non rifare.
vi.mock('~/lib/supabase-management.server', () => ({
  exchangeCode: (...a: unknown[]) => exchangeCode(...a),
}));
vi.mock('~/lib/supabase-oauth.server', () => ({
  saveTokens: (...a: unknown[]) => saveTokens(...a),
  verifyState: (...a: unknown[]) => verifyState(...a),
}));

import { loader } from './auth.supabase.callback';

const APP = 'https://kerdon.example';

function call(query: string) {
  return loader({
    request: new Request(`${APP}/auth/supabase/callback${query}`),
    params: {},
    context: {},
  } as never) as Promise<Response>;
}

/** Il messaggio che la pagina consegna alla finestra dell'app. */
function postedMessage(html: string): unknown {
  const m = html.match(/postMessage\((.*), ("[^"]*")\);/);
  if (!m) throw new Error('postMessage non trovato');
  return JSON.parse(m[1]);
}

describe('GET /auth/supabase/callback', () => {
  const prevUrl = process.env.SHOPIFY_APP_URL;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_APP_URL = APP;
    process.env.SUPABASE_OAUTH_CLIENT_ID = 'cid';
    process.env.SUPABASE_OAUTH_CLIENT_SECRET = 'secret';
    verifyState.mockReturnValue({ shopId: 'shop-A' });
  });
  afterEach(() => {
    process.env.SHOPIFY_APP_URL = prevUrl;
  });

  it('non scambia il codice e non salva token: li consegna alla finestra che ha aperto', async () => {
    const res = await call('?code=c0de&state=st4te');
    const html = await res.text();

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
    expect(postedMessage(html)).toEqual({ type: 'supabase-oauth', code: 'c0de', state: 'st4te' });
  });

  it("consegna solo all'origine dell'app", async () => {
    const html = await (await call('?code=c&state=s')).text();
    expect(html).toContain(`, "${APP}");`);
  });

  it('non resta in cache e non passa il Referer', async () => {
    const res = await call('?code=c&state=s');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it("l'errore di Supabase arriva come esito negativo, senza scambio", async () => {
    const html = await (await call('?error=access_denied')).text();
    expect(postedMessage(html)).toEqual({ type: 'supabase-oauth', ok: false, error: 'denied' });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it("un errore qualunque diventa un codice fisso: il valore grezzo non passa", async () => {
    const html = await (await call('?error=qualcosa_di_strano')).text();
    expect(postedMessage(html)).toEqual({ type: 'supabase-oauth', ok: false, error: 'failed' });
    expect(html).not.toContain('qualcosa_di_strano');
  });

  it('codice o stato mancanti: esito negativo', async () => {
    const html = await (await call('?code=solo-codice')).text();
    expect(postedMessage(html)).toEqual({
      type: 'supabase-oauth',
      ok: false,
      error: 'missing_code_or_state',
    });
  });

  it('un errore con </script> non spezza il tag', async () => {
    const res = await call(`?error=${encodeURIComponent('</script><script>alert(1)</script>')}`);
    const html = await res.text();
    // Un solo </script>: quello che chiude il blocco della pagina.
    expect(html.match(/<\/script>/gi)?.length).toBe(1);
  });

  it('codice e stato con </script> arrivano escapati, e intatti', async () => {
    const evil = '</script><script>alert(1)</script>';
    const res = await call(`?code=${encodeURIComponent(evil)}&state=s`);
    const html = await res.text();
    expect(html.match(/<\/script>/gi)?.length).toBe(1);
    expect(html).toContain('\\u003c/script\\u003e');
    expect(postedMessage(html)).toEqual({ type: 'supabase-oauth', code: evil, state: 's' });
  });

  it('senza la finestra dell\'app non si chiude: spiega come completare', async () => {
    // Una pagina di Supabase puo' tagliare il legame con la finestra che l'ha
    // aperta (dopo aver creato account o organizzazione). Li' il codice non
    // arriva a nessuno: chiudere dicendo "fatto" lascerebbe il merchant
    // convinto di aver finito.
    const html = await (await call('?code=c&state=s')).text();
    expect(html).toContain('Torna su Kerdon e clicca di nuovo «Collega Supabase» per completare.');
    expect(html).toContain('Go back to Kerdon and click "Connect Supabase" again to finish.');
    // window.close() solo dentro il ramo con la finestra dell'app.
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    expect(script).toMatch(/if \(window\.opener\) \{[^}]*postMessage[\s\S]*window\.close\(\);[\s\S]*\} else \{/);
    expect(script.split('window.close()').length - 1).toBe(1);
    expect(script.slice(script.indexOf('} else {'))).not.toContain('window.close');
  });
});
