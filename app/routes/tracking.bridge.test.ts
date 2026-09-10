import { describe, it, expect } from 'vitest';
import { loader } from './tracking.bridge[.]js';

describe('la rotta che serve il ponte', () => {
  it('lo serve come JavaScript, e i browser lo eseguono', async () => {
    const response = await loader();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('javascript');
    expect(await response.text()).toContain('visitorConsentCollected');
  });

  // Lo include il tema del merchant, da un dominio diverso dal nostro: senza,
  // il browser lo scarta prima di eseguirlo.
  it('si lascia includere da qualunque negozio', async () => {
    const response = await loader();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  // E' il primo script che parte su ogni pagina di ogni negozio che ci usa:
  // farlo riscaricare ogni volta e' un ritardo pagato da chi naviga.
  it('si puo mettere in cache, perche e uguale per tutti', async () => {
    const cache = (await loader()).headers.get('Cache-Control');
    expect(cache).toContain('public');
    expect(cache).toContain('max-age=');
  });

  // La rotta e' pubblica: qualunque cosa ci finisca dentro la legge chiunque.
  it('non c e dentro niente di nessun negozio', async () => {
    const body = await (await loader()).text();
    expect(body).not.toMatch(/spx_/);
    expect(body).not.toMatch(/myshopify/);
  });
});
