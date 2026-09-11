// e2e/tests/date-picker-tastiera.spec.ts
//
// Il selettore del periodo senza mouse, e chi ci finisce dentro col tabulatore.
//
// PERCHE' SERVE UN BROWSER. La trappola del fuoco non e' codice nostro: la
// mette Polaris dentro il Popover, e funziona o non funziona a seconda di come
// il browser calcola l'ordine di tabulazione degli elementi VISIBILI in quel
// momento. Non c'e' modo di chiederlo a una prova che non impagina: in jsdom
// tutti gli elementi sono visibili, hanno area zero e l'ordine e' quello del
// documento. Una prova li' direbbe sempre di si'.
//
// E il fuoco che torna sull'attivatore quando si chiude e' la differenza fra
// poter continuare a lavorare con la tastiera e ritrovarsi il cursore
// all'inizio della pagina.

import { expect, test } from './support/prova';
import { apriBanco, dizionario, giornoDelMese, sel } from './support/banco';

const t = dizionario.it;

/** Dove sta il fuoco adesso, detto in modo leggibile in un messaggio d'errore. */
async function fuoco(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return 'nessuno';
    const dentro = el.closest('.range-picker') ? 'dentro' : 'fuori';
    return `${dentro}:${el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`;
  });
}

test.describe('il selettore del periodo con la tastiera', () => {
  test.beforeEach(async ({ page }) => {
    await apriBanco(page);
  });

  test('Esc chiude senza applicare e riporta il fuoco sull attivatore', async ({ page }) => {
    await page.locator(sel.attivatore).click();
    await giornoDelMese(page, 0, 6).click();
    await giornoDelMese(page, 0, 9).click();

    await page.keyboard.press('Escape');

    await expect(page.locator(sel.pannello)).toHaveCount(0);
    // Esc e' Annulla: la bozza si butta via, non si applica di nascosto.
    await expect(page.locator(sel.periodoApplicato)).toHaveText('2026-06-03..2026-06-17');
    await expect(page.locator(sel.applicazioni)).toHaveText('0');
    // E il fuoco torna da dove era partito, altrimenti il tabulatore
    // successivo ricomincia dall'inizio della pagina.
    await expect(page.locator(sel.attivatore)).toBeFocused();
  });

  test('un clic fuori chiude senza applicare', async ({ page }) => {
    await page.locator(sel.attivatore).click();
    await giornoDelMese(page, 0, 6).click();

    await page.locator(sel.prima).click();

    await expect(page.locator(sel.pannello)).toHaveCount(0);
    await expect(page.locator(sel.periodoApplicato)).toHaveText('2026-06-03..2026-06-17');
    await expect(page.locator(sel.applicazioni)).toHaveText('0');
  });

  // LA REGOLA CHE QUESTE DUE PROVE FISSANO, e che non e' quella che ci si
  // aspetta leggendo `ariaHaspopup="dialog"`.
  //
  // Il Popover di Polaris NON e' una trappola del fuoco: mette due sentinelle
  // invisibili, una prima e una dopo il contenuto, e quando il tabulatore ne
  // tocca una CHIUDE la tendina invece di riportare il fuoco dentro. E' il
  // comportamento di tutti i popover dell'admin, non una nostra scelta.
  //
  // Cosa si verifica allora, visto che la trappola non c'e'. La sola cosa che
  // conta davvero per chi usa la tastiera: che non si possa MAI finire a
  // comandare qualcosa che sta dietro a un pannello aperto. Il fuoco puo'
  // uscire — ma quando esce il pannello dev'essere gia' chiuso, e non dev'essere
  // stato applicato niente. Una tendina che resta aperta con il fuoco dietro di
  // se' e' il guasto vero, e sarebbe invisibile a chi guarda lo schermo.
  test('uscendo con il tabulatore la tendina si chiude, e non resta aperta dietro al fuoco', async ({
    page,
  }) => {
    await page.locator(sel.attivatore).click();
    await expect(page.locator(sel.pannello)).toBeVisible();

    let passiDentro = 0;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (!(await fuoco(page)).startsWith('dentro:')) break;
      passiDentro++;
      // Finche' il fuoco e' dentro, il pannello dev'essere aperto: e' il
      // controllo che rende significativo il conteggio qui sotto.
      await expect(page.locator(sel.pannello)).toBeVisible();
    }

    // Il fuoco ha davvero attraversato i comandi del pannello prima di uscire:
    // senza questo, una tendina che si chiudesse al primo tabulatore passerebbe
    // la prova senza che nessuno l'abbia mai percorsa.
    expect(passiDentro).toBeGreaterThan(5);
    await expect(page.locator(sel.pannello)).toHaveCount(0);
    await expect(page.locator(sel.applicazioni)).toHaveText('0');
  });

  test('anche all indietro il fuoco non finisce dietro a un pannello rimasto aperto', async ({
    page,
  }) => {
    await page.locator(sel.attivatore).click();
    await expect(page.locator(sel.pannello)).toBeVisible();

    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Shift+Tab');
      if (!(await fuoco(page)).startsWith('dentro:')) break;
      await expect(page.locator(sel.pannello)).toBeVisible();
    }

    await expect(page.locator(sel.pannello)).toHaveCount(0);
    await expect(page.locator(sel.applicazioni)).toHaveText('0');
  });

  test('Intervallo personalizzato porta il fuoco sul primo campo', async ({ page }) => {
    await page.locator(sel.attivatore).click();

    // La voce non calcola niente: e' il nome di dove ci si trova. Premerla deve
    // portare dove si voleva andare, cioe' nel campo della data d inizio.
    await page
      .locator(sel.colonna)
      .getByRole('menuitem', { name: new RegExp(t.dates.presets.custom) })
      .click();

    await expect(page.locator('#range-picker-start')).toBeFocused();
  });

  test('Invio nel campo applica la data senza uscire dal campo', async ({ page }) => {
    await page.locator(sel.attivatore).click();
    const inizio = page.locator(sel.campi).nth(0);

    await inizio.click();
    await inizio.fill('01/05/2026');
    await page.keyboard.press('Enter');

    // Il calendario si e' spostato sul mese della data scritta, e il campo ha
    // ancora il fuoco: senza l'Invio bisognerebbe uscire dal campo per
    // applicare, e uscire da un campo con la tastiera vuol dire tabulare via.
    await expect(inizio).toBeFocused();
    await expect(page.locator(sel.titoloMese).nth(1)).toHaveText(/giugno 2026/i);
    await expect(page.locator(sel.applica)).toBeEnabled();
  });

  test('i comandi del piede si raggiungono con la tastiera e Applica risponde a Invio', async ({
    page,
  }) => {
    await page.locator(sel.attivatore).click();
    await giornoDelMese(page, 0, 6).click();
    await giornoDelMese(page, 0, 9).click();

    await page.locator(sel.applica).focus();
    await page.keyboard.press('Enter');

    await expect(page.locator(sel.pannello)).toHaveCount(0);
    await expect(page.locator(sel.periodoApplicato)).toHaveText('2026-05-06..2026-05-09');
  });
});
