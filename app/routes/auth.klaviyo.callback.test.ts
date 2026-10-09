import { describe, it, expect, beforeEach } from 'vitest';
import { loader } from './auth.klaviyo.callback';

const APP = 'https://kerdon.example';

function call(query: string) {
  return loader({
    request: new Request(`${APP}/auth/klaviyo/callback${query}`),
    params: {},
    context: {},
  } as never) as Promise<Response>;
}

describe('GET /auth/klaviyo/callback', () => {
  beforeEach(() => {
    process.env.SHOPIFY_APP_URL = APP;
  });

  it('consegna codice e stato alla finestra dell\'app, con gli header di prima', async () => {
    const res = await call('?code=c&state=s');
    const html = await res.text();
    expect(html).toContain('postMessage({"type":"klaviyo-oauth","code":"c","state":"s"}, "https://kerdon.example");');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('senza la finestra dell\'app non si chiude: spiega come completare', async () => {
    const html = await (await call('?code=c&state=s')).text();
    expect(html).toContain('Torna su Kerdon e clicca di nuovo «Collega Klaviyo» per completare.');
    expect(html).toContain('Go back to Kerdon and click "Connect Klaviyo" again to finish.');
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    expect(script.split('window.close()').length - 1).toBe(1);
    expect(script.slice(script.indexOf('} else {'))).not.toContain('window.close');
  });
});
