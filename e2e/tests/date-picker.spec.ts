// e2e/tests/date-picker.spec.ts
//
// Il selettore del periodo: quello che fa, in un browser.
//
// Le prove unitarie di `date-range-picker.test.ts` rispondono gia' alle domande
// che si possono rispondere senza disegnare niente — quali due mesi mostrare,
// come si chiama una voce, quando "Applica" ha qualcosa da applicare. Qui ci
// sono le altre: che aprendo si apra, che premendo un giorno quel giorno
// risulti scelto, che "Annulla" non applichi, che "Applica" applichi una volta
// sola. Sono ovvieta' finche' non si rompono, e si rompono in silenzio: la
// bozza e il valore applicato sono due stati distinti, e un giro sbagliato fra
// i due non si vede da nessuna parte se non qui.
//
// IL PERIODO DI PARTENZA DEL BANCO E' UN INTERVALLO SENZA NOME, ed e' una
// scelta: aprendo su un periodo predefinito la colonna si apre gia' dentro il
// suo gruppo — che e' il comportamento voluto, e ha la sua prova qui sotto — ma
// come punto di partenza di tutte le altre costringerebbe ogni prova a uscire
// da un pannello prima di poter fare qualsiasi cosa.

import { expect, test } from './support/prova';
import { apriBanco, dizionario, giornoDelMese, sel } from './support/banco';

const t = dizionario.it;

test.describe('il selettore del periodo', () => {
  test.beforeEach(async ({ page }) => {
    await apriBanco(page);
  });

  test('si apre sul pulsante e si richiude sullo stesso pulsante', async ({ page }) => {
    await expect(page.locator(sel.pannello)).toHaveCount(0);

    await page.locator(sel.attivatore).click();
    await expect(page.locator(sel.pannello)).toBeVisible();

    // Lo stesso pulsante richiude: e' un comando a due stati, non un comando
    // che apre e basta.
    await page.locator(sel.attivatore).click();
    await expect(page.locator(sel.pannello)).toHaveCount(0);
  });

  test('mostra i due mesi che finiscono sul periodo applicato, non quelli del futuro', async ({
    page,
  }) => {
    await apriBanco(page, { da: '2026-08-03', a: '2026-08-10' });
    await page.locator(sel.attivatore).click();

    // Il periodo finisce il 10 agosto: si guardano luglio e agosto. Il difetto
    // che questa prova esiste per fermare e' l'ancoraggio all'INIZIO, che
    // mostrava agosto e settembre — meta' calendario in un futuro dove non c'e'
    // niente da scegliere.
    const titoli = page.locator(sel.titoloMese);
    await expect(titoli).toHaveCount(2);
    await expect(titoli.nth(0)).toHaveText(/luglio 2026/i);
    await expect(titoli.nth(1)).toHaveText(/agosto 2026/i);
  });

  test('le frecce spostano i mesi di uno alla volta, in tutti e due i sensi', async ({ page }) => {
    await page.locator(sel.attivatore).click();
    // Il banco parte su un periodo che finisce a giugno: maggio e giugno.
    await expect(page.locator(sel.titoloMese).nth(0)).toHaveText(/maggio 2026/i);

    await page.locator(sel.meseIndietro).click();
    await expect(page.locator(sel.titoloMese).nth(0)).toHaveText(/aprile 2026/i);
    await expect(page.locator(sel.titoloMese).nth(1)).toHaveText(/maggio 2026/i);

    // Uno alla volta anche in avanti: e' cio' che permette di raggiungere un
    // intervallo a cavallo di due mesi senza saltarlo.
    await page.locator(sel.meseAvanti).click();
    await page.locator(sel.meseAvanti).click();
    await expect(page.locator(sel.titoloMese).nth(0)).toHaveText(/giugno 2026/i);
    await expect(page.locator(sel.titoloMese).nth(1)).toHaveText(/luglio 2026/i);
  });

  test('scegliere due giorni compone un intervallo, e Applica lo applica una volta sola', async ({
    page,
  }) => {
    await page.locator(sel.attivatore).click();

    // Finche' non si tocca niente, Applica e' spento: riaprire e richiudere non
    // deve offrire un comando che non farebbe nulla.
    await expect(page.locator(sel.applica)).toBeDisabled();

    await giornoDelMese(page, 0, 6).click();
    await giornoDelMese(page, 0, 9).click();

    await expect(page.locator(sel.applica)).toBeEnabled();
    await page.locator(sel.applica).click();

    await expect(page.locator(sel.pannello)).toHaveCount(0);
    await expect(page.locator(sel.periodoApplicato)).toHaveText('2026-05-06..2026-05-09');
    // Una volta sola: un secondo giro del gestore riapplicherebbe lo stesso
    // periodo, e a valle ogni applicazione e' una richiesta di statistiche.
    await expect(page.locator(sel.applicazioni)).toHaveText('1');
  });

  test('Annulla butta via la bozza e non applica niente', async ({ page }) => {
    await page.locator(sel.attivatore).click();
    await giornoDelMese(page, 0, 6).click();
    await giornoDelMese(page, 0, 9).click();
    await page.locator(sel.annulla).click();

    await expect(page.locator(sel.periodoApplicato)).toHaveText('2026-06-03..2026-06-17');
    await expect(page.locator(sel.applicazioni)).toHaveText('0');

    // E riaprendo, la bozza buttata via non deve tornare a galla.
    await page.locator(sel.attivatore).click();
    await expect(page.locator(sel.applica)).toBeDisabled();
    await expect(page.locator(sel.giornoScelto).first()).toHaveText('3');
  });

  test('un periodo predefinito sceglie le sue date senza passare dal calendario', async ({
    page,
  }) => {
    await page.locator(sel.attivatore).click();

    await page
      .locator(sel.colonna)
      .getByRole('menuitem', { name: t.dates.presets.yesterday, exact: true })
      .click();
    await page.locator(sel.applica).click();

    // Ieri, per un negozio a Roma, con l'orologio fermo al 26 agosto.
    await expect(page.locator(sel.periodoApplicato)).toHaveText('2026-08-25..2026-08-25');
  });

  test('riaprendo su un periodo predefinito la colonna si apre dentro il suo gruppo', async ({
    page,
  }) => {
    // Trenta giorni indietro dal 26 agosto: e' "Ultimi 30 giorni", che sta nel
    // gruppo "Ultimi". Aprendo, la colonna deve mostrare QUEL pannello e non
    // l'elenco principale — altrimenti la scelta in corso sparirebbe dalla
    // vista e la tendina sembrerebbe senza scelta.
    await apriBanco(page, { da: '2026-07-28', a: '2026-08-26' });
    await page.locator(sel.attivatore).click();

    const colonna = page.locator(sel.colonna);
    await expect(colonna.getByRole('menuitem', { name: t.dates.back })).toBeVisible();
    await expect(
      colonna.getByRole('menuitem', { name: t.dates.selectedLabel(t.dates.presets.last30) }),
    ).toBeVisible();
  });

  test('un gruppo di periodi sostituisce l elenco, e Indietro lo riporta', async ({ page }) => {
    await page.locator(sel.attivatore).click();
    const colonna = page.locator(sel.colonna);

    await colonna.getByRole('menuitem', { name: t.dates.groups.quarters, exact: true }).click();

    // Il pannello del gruppo SOSTITUISCE l'elenco: "Oggi" non deve piu' esserci.
    // E' la scelta che tiene ferma l'altezza della tendina, e un ritorno a un
    // elenco che si allunga aprendo un gruppo si vedrebbe solo qui.
    await expect(colonna.getByRole('menuitem', { name: t.dates.presets.today })).toHaveCount(0);
    await expect(colonna.getByRole('menuitem', { name: t.dates.back })).toBeVisible();

    await colonna.getByRole('menuitem', { name: t.dates.back }).click();
    await expect(
      colonna.getByRole('menuitem', { name: t.dates.presets.today, exact: true }),
    ).toBeVisible();
  });

  test('la voce scelta lo dice anche a chi ascolta, non solo con lo sfondo', async ({ page }) => {
    await page.locator(sel.attivatore).click();
    const colonna = page.locator(sel.colonna);

    await colonna.getByRole('menuitem', { name: t.dates.presets.yesterday, exact: true }).click();

    // ActionList di Polaris non espone aria-pressed: lo stato "scelto" per chi
    // non vede lo schermo esiste solo se qualcuno lo scrive nel nome
    // accessibile. Se un giorno sparisse, a schermo non cambierebbe nulla.
    await expect(
      colonna.getByRole('menuitem', { name: t.dates.selectedLabel(t.dates.presets.yesterday) }),
    ).toBeVisible();
  });

  test('il futuro non si sceglie dal calendario', async ({ page }) => {
    await apriBanco(page, { da: '2026-07-28', a: '2026-08-26' });
    await page.locator(sel.attivatore).click();

    // Le caselle oltre l'oggi sono spente: si spegne nel calendario invece di
    // spiegarlo dopo con un messaggio d'errore. Il 26 e' oggi e si sceglie, il
    // 27 e' domani e non esiste.
    await expect(giornoDelMese(page, 1, 26)).toBeEnabled();
    await expect(giornoDelMese(page, 1, 27)).toBeDisabled();
  });

  test('una data futura scritta a mano viene riportata a oggi, e il campo lo mostra', async ({
    page,
  }) => {
    // Il periodo finisce gia' OGGI: e' il caso in cui il difetto si vede.
    // Scrivendo una data futura, il selettore la riporta a oggi — cioe' al
    // valore che il campo aveva gia' — e quindi la prop `value` non cambia.
    // Il campo, che si normalizzava sulla data LETTA e non su quella
    // ACCETTATA, restava a mostrare il 31 dicembre: una data che non verra'
    // mai applicata, accanto a un "Applica" spento che non spiega perche'.
    await apriBanco(page, { da: '2026-07-28', a: '2026-08-26' });
    await page.locator(sel.attivatore).click();

    const campi = page.locator(sel.campi);
    await campi.nth(1).fill('31/12/2026');
    await campi.nth(1).press('Enter');

    await expect(campi.nth(1)).toHaveValue('26/08/2026');
  });

  test('una fine anteriore all inizio scambia i due estremi, e i campi lo mostrano', async ({
    page,
  }) => {
    await page.locator(sel.attivatore).click();
    const campi = page.locator(sel.campi);

    // Il selettore riordina l'intervallo. Anche qui il campo deve mostrare cio'
    // che e' stato accettato: scrivere una fine prima dell'inizio e vedersela
    // restare li' mentre il calendario mostra altro e' il modo piu' rapido di
    // non fidarsi piu' di quello che c'e' scritto.
    await campi.nth(1).fill('01/06/2026');
    await campi.nth(1).press('Enter');

    await expect(campi.nth(0)).toHaveValue('01/06/2026');
    await expect(campi.nth(1)).toHaveValue('03/06/2026');
  });

  test('i due campi accettano una data scritta e la normalizzano', async ({ page }) => {
    await page.locator(sel.attivatore).click();
    const campi = page.locator(sel.campi);

    // Scritta corta e con un separatore qualsiasi: chi copia una data da
    // altrove non deve riformattarla.
    await campi.nth(0).fill('3-5-26');
    await campi.nth(0).press('Enter');
    await expect(campi.nth(0)).toHaveValue('03/05/2026');

    await page.locator(sel.applica).click();
    await expect(page.locator(sel.periodoApplicato)).toHaveText('2026-05-03..2026-06-17');
  });

  test('il confronto mostra le date che verrebbero davvero messe a paragone', async ({ page }) => {
    await apriBanco(page, { da: '2026-07-28', a: '2026-08-26' });
    await page.locator(sel.attivatoreConfronto).click();

    const voce = page.getByRole('menuitem', {
      name: new RegExp(t.dates.comparisons.previousPeriod),
    });
    // Sotto la voce ci sono i giorni: "periodo precedente" e' un'idea, quelli
    // sono i trenta giorni che verranno confrontati davvero.
    await expect(voce).toContainText('28 giu 2026');
    await voce.click();
    await expect(page.locator('[data-testid="applied-comparison"]')).toHaveText('previousPeriod');
  });
});
