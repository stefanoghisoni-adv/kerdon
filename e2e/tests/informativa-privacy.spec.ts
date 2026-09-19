// e2e/tests/informativa-privacy.spec.ts
//
// L'informativa sulla privacy, letta come la legge chi non e' nessuno.
//
// PERCHE' IN UN BROWSER, VISTO CHE C'E' GIA' UNA PROVA UNITARIA DELLA ROTTA.
// Perche' la prova unitaria chiama una funzione e guarda una stringa: puo' dire
// che l'HTML e' quello giusto, non che una PAGINA si apre. Qui il browser parte
// senza cookie e senza sessione — come ci arriva il revisore Shopify, che apre
// il link dalla scheda dell'app prima che l'app sia installata da nessuno — e
// deve vedere il documento, non una pagina di accesso.
//
// E PERCHE' IL CONTENUTO ARRIVA DAVVERO. Il testo dell'informativa sta in
// `docs/legal/`, cioe' FUORI da `app/`: entra nel modulo come importazione
// `?raw`, che e' il meccanismo su cui si regge la promessa che su Vercel non ci
// sia nessun file da cercare a runtime. Qui quel meccanismo viene esercitato da
// un Vite vero, e se non funzionasse la pagina sarebbe vuota.
//
// NIENTE ESCE: la pagina non ha script e non carica niente da fuori, e la rete
// verso l'esterno e' chiusa dal fixture. Che non carichi niente lo si verifica,
// invece di darlo per buono.

import { expect, test as prova } from './support/prova';

prova.describe("l'informativa sulla privacy", () => {
  prova('si apre senza sessione e senza cookie', async ({ page }) => {
    const risposta = await page.goto('/privacy-policy');

    expect(risposta?.status()).toBe(200);
    // Nessun rimando verso l'autenticazione: si e' rimasti dove si era chiesto.
    expect(new URL(page.url()).pathname).toBe('/privacy-policy');
    // Il browser di prova dichiara `it-IT` (vedi `playwright.config.ts`), e la
    // pagina gli risponde nella sua lingua: qui si guarda che si APRA, non in
    // che lingua — la lingua ha le sue due prove qui sotto.
    await expect(page.locator('h1')).toHaveText('Informativa sulla privacy');
    // Il testo viene dal file, non da un guscio vuoto.
    await expect(page.locator('#chi-siamo')).toContainText('Stefano Ghisoni');
  });


  prova('il link che nomina la lingua porta al documento italiano', async ({ page }) => {
    await page.goto('/privacy-policy?lang=it');

    await expect(page.locator('html')).toHaveAttribute('lang', 'it');
    await expect(page.locator('h1')).toHaveText('Informativa sulla privacy');
    await expect(page.locator('#chi-siamo')).toContainText('Stefano Ghisoni');
  });

  prova("l'indice porta dove dice di portare", async ({ page }) => {
    await page.goto('/privacy-policy?lang=en');

    const voci = page.locator('.rail a');
    await expect(voci).toHaveCount(10);

    // Ogni ancora dell'indice ha la sua sezione: un indice che punta nel vuoto
    // e' il modo in cui un documento lungo diventa illeggibile.
    const ancore = await voci.evaluateAll((elementi) =>
      elementi.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''),
    );
    for (const ancora of ancore) {
      await expect(page.locator(ancora)).toHaveCount(1);
    }
  });

  prova('non esegue niente e non chiama nessuno', async ({ page }) => {
    const verso: string[] = [];
    page.on('request', (richiesta) => verso.push(richiesta.url()));

    await page.goto('/privacy-policy?lang=it');

    // Una sola richiesta, quella del documento: nessun font, nessuno script,
    // nessuna immagine. Su una pagina che spiega quali dati raccogliamo, una
    // richiesta a un terzo manderebbe l'IP di chi legge prima della prima riga.
    expect(verso).toHaveLength(1);
    await expect(page.locator('script')).toHaveCount(0);
  });

  prova('si passa da una lingua all altra', async ({ page }) => {
    await page.goto('/privacy-policy?lang=en');
    await page.getByRole('link', { name: 'Italiano' }).click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'it');
  });
});

// Un browser che parla inglese, come quello del revisore Shopify. La lingua si
// dichiara QUI e non con `setExtraHTTPHeaders`: `locale` la fissa sul contesto
// del browser, e un'intestazione aggiunta alla singola pagina non la scavalca —
// si finirebbe per provare l'italiano credendo di provare l'inglese.
prova.describe("l'informativa letta da chi parla inglese", () => {
  prova.use({ locale: 'en-GB' });

  // Il revisore Shopify arriva senza parametro e senza sapere niente di noi:
  // l'unica cosa che porta con se' e' la lingua del suo browser. Se non venisse
  // guardata leggerebbe un documento in italiano, e un'informativa che il
  // revisore non legge vale quanto non averla.
  prova("riceve l'inglese senza doverlo chiedere", async ({ page }) => {
    await page.goto('/privacy-policy');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toHaveText('Privacy Policy');
    await expect(page.locator('#who-we-are')).toContainText('Stefano Ghisoni');
  });
});
