// e2e/tests/lingue.spec.ts
//
// La stessa schermata nelle due lingue che l'app parla.
//
// COSA VERIFICA DAVVERO, visto che non e' una prova sulle traduzioni. Che le
// due lingue producano la stessa PAGINA: gli stessi comandi, nelle stesse
// posizioni, dentro le stesse misure. Il difetto che cerca non e' una parola
// sbagliata — quello lo trova gia' il controllo sui dizionari — ma una parola
// piu' LUNGA che sfonda un'impaginazione calcolata su quella corta. E' un
// difetto che esiste solo dopo che un motore ha misurato del testo, e si
// manifesta in una lingua sola: cioe' resta invisibile a chi sviluppa
// nell'altra.
//
// I nomi si chiedono al dizionario e non si scrivono a mano: una prova che
// contenesse "Apply" scritto per esteso proverebbe la prova, non la pagina.

import { expect, test } from './support/prova';
import { apriBanco, dizionario, scorrimentoOrizzontale, sel, type Lingua } from './support/banco';

for (const lingua of ['it', 'en'] as Lingua[]) {
  test(`prova di fumo in ${lingua}: il selettore si apre, sceglie e applica`, async ({ page }) => {
    const t = dizionario[lingua];
    await apriBanco(page, { lingua, da: '2026-07-28', a: '2026-08-26' });

    await page.locator(sel.attivatore).click();
    await expect(page.locator(sel.pannello)).toBeVisible();

    // Si esce dal gruppo in cui la tendina si apre e si sceglie "Ieri", che
    // nelle due lingue e' una parola sola contro due: e' la voce su cui una
    // differenza di larghezza si vedrebbe per prima.
    await page.locator(sel.colonna).getByRole('menuitem', { name: t.dates.back }).click();
    await page
      .locator(sel.colonna)
      .getByRole('menuitem', { name: t.dates.presets.yesterday, exact: true })
      .click();

    await expect(
      page.locator(sel.colonna).getByRole('menuitem', {
        name: t.dates.selectedLabel(t.dates.presets.yesterday),
      }),
    ).toBeVisible();

    // Cercato dentro il piede e non nella pagina: l'attivatore porta
    // `aria-owns` sulla tendina, quindi per il browser il suo nome accessibile
    // comprende anche il testo di cio' che ha aperto — "Applica" compreso. E'
    // come lo compone Polaris, non una nostra scelta, ma cercare per nome nella
    // pagina intera ne trova due.
    const applica = page.locator(sel.piede).getByRole('button', { name: t.dates.apply, exact: true });
    await expect(applica).toBeEnabled();
    await applica.click();
    await expect(page.locator(sel.periodoApplicato)).toHaveText('2026-08-25..2026-08-25');
  });

  test(`prova di fumo in ${lingua}: niente sfonda la tendina su una finestra stretta`, async ({
    page,
  }) => {
    const t = dizionario[lingua];
    await apriBanco(page, { lingua, larghezza: 360, altezza: 1000 });
    await page.locator(sel.attivatore).click();

    expect(await scorrimentoOrizzontale(page)).toBeLessThanOrEqual(0);

    const pannello = await page.locator(sel.pannello).boundingBox();
    expect(pannello).not.toBeNull();
    expect(pannello!.x + pannello!.width).toBeLessThanOrEqual(361);

    // "Black Friday Cyber Monday" e' il nome piu' lungo della colonna in tutte
    // e due le lingue: se qualcosa deve sfondare, sfonda li'. Va a capo, e la
    // voce si allunga in altezza invece di allargare la colonna.
    const voce = page.locator(sel.colonna).getByRole('menuitem', { name: t.dates.groups.bfcm });
    const suo = await voce.boundingBox();
    expect(suo).not.toBeNull();
    const colonna = await page.locator(sel.colonna).boundingBox();
    expect(suo!.x + suo!.width).toBeLessThanOrEqual(colonna!.x + colonna!.width + 1);
  });
}
