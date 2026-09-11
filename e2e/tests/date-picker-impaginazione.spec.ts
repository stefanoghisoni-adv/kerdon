// e2e/tests/date-picker-impaginazione.spec.ts
//
// Il selettore del periodo, misurato.
//
// QUESTE SONO LE PROVE CHE NON ESISTEVANO, ed e' il motivo per cui questo
// lavoro e' stato chiesto. Tutti i difetti che il proprietario ha segnalato a
// voce erano difetti di misura: le frecce dei mesi ancorate al pannello
// sbagliato e finite agli angoli della tendina; gli estremi dell'intervallo
// arrotondati su tutti e quattro gli angoli, che lasciavano due lune di grigio
// e facevano sembrare la banda spezzata; i due mesi sfalsati di uno; una fascia
// vuota alta decine di pixel fra il calendario e i due pulsanti. Nessuno di
// questi e' visibile senza un motore di impaginazione che calcoli delle
// posizioni, e `app/dashboard.css` e' quasi tutto scritto per governarli.
//
// `polaris-selectors.test.ts` sorveglia gia' il contratto fragile su cui quel
// foglio si appoggia — che le classi interne di Polaris esistano ancora — e nel
// suo commento dichiara cio' che non puo' dire: «che il risultato a schermo sia
// giusto. Per quello serve un browser vero, che misuri la larghezza reale».
// Questo file e' quel browser.

import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/prova';
import { apriBanco, scorrimentoOrizzontale, sel } from './support/banco';

/** Il rettangolo di un elemento, con un messaggio utile se l'elemento non c'e'. */
async function riquadro(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box, `elemento senza riquadro: ${locator}`).not.toBeNull();
  return box!;
}

async function apri(page: Page): Promise<void> {
  await page.locator(sel.attivatore).click();
  await expect(page.locator(sel.pannello)).toBeVisible();
}

test.describe('il selettore del periodo, misurato', () => {
  // Le quattro larghezze che contano: 700 e' la misura della tendina, 640 il
  // primo scalino sotto la soglia del ripiego, 480 un telefono girato, 360 il
  // telefono piu' stretto che l'admin di Shopify mostra ancora.
  for (const larghezza of [700, 640, 480, 360]) {
    test(`a ${larghezza}px la tendina sta nella finestra e la pagina non scorre di lato`, async ({
      page,
    }) => {
      await apriBanco(page, { larghezza, altezza: 900 });
      await apri(page);

      // Lo scorrimento laterale e' il difetto che si vede per primo e che si
      // dimentica sempre: un pixel di troppo e tutta la pagina balla.
      expect(await scorrimentoOrizzontale(page)).toBeLessThanOrEqual(0);

      const pannello = await riquadro(page.locator(sel.pannello));
      expect(pannello.width).toBeLessThanOrEqual(larghezza);
      expect(pannello.x).toBeGreaterThanOrEqual(-1);
      expect(pannello.x + pannello.width).toBeLessThanOrEqual(larghezza + 1);
    });
  }

  test('larga, la tendina sta in due colonne e non supera i 700px', async ({ page }) => {
    await apriBanco(page, { larghezza: 1280 });
    await apri(page);

    const pannello = await riquadro(page.locator(sel.pannello));
    // 700px e' un budget dichiarato in `dashboard.css`, non un risultato: se un
    // giorno lo sfonda, la tendina comincia a uscire dalle finestre strette.
    expect(pannello.width).toBeLessThanOrEqual(700);

    // Due colonne vuol dire che i periodi stanno A FIANCO del calendario, non
    // sopra: si misura, non si legge la regola CSS.
    const colonna = await riquadro(page.locator(sel.colonna));
    const calendario = await riquadro(page.locator(sel.calendario));
    expect(colonna.x + colonna.width).toBeLessThanOrEqual(calendario.x + 1);
  });

  test('stretta, i periodi passano sopra e la freccia fra i campi sparisce', async ({ page }) => {
    await apriBanco(page, { larghezza: 640 });
    await apri(page);

    const colonna = await riquadro(page.locator(sel.colonna));
    const corpo = await riquadro(page.locator(sel.corpo));
    // Sotto la soglia i periodi non possono piu' stare a fianco: 170px tolti a
    // uno schermo stretto lascerebbero al calendario meno di un mese.
    expect(colonna.y + colonna.height).toBeLessThanOrEqual(corpo.y + 1);

    // La freccia indica il verso fra i due campi. Impilati, punterebbe a
    // destra fra un campo e quello sotto: la direzione sbagliata.
    await expect(page.locator(sel.freccia)).toBeHidden();

    // E i due campi vanno uno sotto l'altro, non affiancati.
    const inizio = await riquadro(page.locator(sel.campi).nth(0));
    const fine = await riquadro(page.locator(sel.campi).nth(1));
    expect(fine.y).toBeGreaterThan(inizio.y + inizio.height - 1);
  });

  test('le frecce dei mesi cadono sulla riga dei titoli, non su quella dei giorni', async ({
    page,
  }) => {
    await apriBanco(page, { larghezza: 1280 });
    await apri(page);

    const barra = await riquadro(page.locator(sel.barraMesi));
    const titolo = await riquadro(page.locator(sel.titoloMese).first());
    const giorniSettimana = await riquadro(
      page.locator('.range-picker__calendar .Polaris-DatePicker__Weekday').first(),
    );

    // IL DIFETTO CHE QUESTA PROVA FERMA: la barra di Polaris e' in posizione
    // assoluta ancorata in alto, e dentro due calendari affiancati cadeva sulla
    // riga dei giorni della settimana. Qui si verifica che il centro delle
    // frecce stia sulla riga del titolo e NON su quella dei giorni.
    const centroBarra = barra.y + barra.height / 2;
    const centroTitolo = titolo.y + titolo.height / 2;
    expect(Math.abs(centroBarra - centroTitolo)).toBeLessThanOrEqual(6);
    expect(centroBarra).toBeLessThan(giorniSettimana.y);

    // E le frecce restano appoggiate al calendario: da fratelle della tendina
    // si ancoravano al primo antenato posizionato — il pannello del Popover —
    // e finivano ai suoi angoli, lontanissime dai mesi. Il margine e' quello
    // del pulsante terziario di Polaris, che sporge di qualche pixel per
    // allinearsi otticamente: si misura contro il corpo, che e' il riquadro
    // dentro cui devono stare.
    const corpo = await riquadro(page.locator(sel.corpo));
    const calendario = await riquadro(page.locator(sel.calendario));
    const indietro = await riquadro(page.locator(sel.meseIndietro));
    const avanti = await riquadro(page.locator(sel.meseAvanti));
    expect(indietro.x).toBeGreaterThanOrEqual(corpo.x);
    expect(avanti.x + avanti.width).toBeLessThanOrEqual(corpo.x + corpo.width);
    expect(Math.abs(indietro.x - calendario.x)).toBeLessThanOrEqual(8);
    expect(
      Math.abs(avanti.x + avanti.width - (calendario.x + calendario.width)),
    ).toBeLessThanOrEqual(8);
  });

  test('gli estremi dell intervallo hanno la punta: tondi fuori, squadrati verso la banda', async ({
    page,
  }) => {
    await apriBanco(page, { larghezza: 1280 });
    await apri(page);

    const raggi = (locator: Locator) =>
      locator.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          altoSinistra: parseFloat(s.borderTopLeftRadius),
          altoDestra: parseFloat(s.borderTopRightRadius),
          bassoDestra: parseFloat(s.borderBottomRightRadius),
          bassoSinistra: parseFloat(s.borderBottomLeftRadius),
        };
      });

    // IL DIFETTO CHE QUESTA PROVA FERMA: quattro angoli tondi lasciavano due
    // lune di grigio fra l'estremo e la banda, e i due capi si leggevano come
    // due pastiglie staccate invece che come le punte di un intervallo unico.
    const primo = await raggi(page.locator(sel.primoEstremo).first());
    expect(primo.altoSinistra).toBeGreaterThan(0);
    expect(primo.bassoSinistra).toBeGreaterThan(0);
    expect(primo.altoDestra).toBe(0);
    expect(primo.bassoDestra).toBe(0);

    const ultimo = await raggi(page.locator(sel.ultimoEstremo).first());
    expect(ultimo.altoDestra).toBeGreaterThan(0);
    expect(ultimo.bassoDestra).toBeGreaterThan(0);
    expect(ultimo.altoSinistra).toBe(0);
    expect(ultimo.bassoSinistra).toBe(0);
  });

  test('un giorno solo resta tondo da tutte le parti', async ({ page }) => {
    // Inizio e fine sullo stesso giorno: non c'e' un dentro e un fuori, e la
    // regola di Polaris per l'ultimo giorno arrotonderebbe comunque a destra.
    await apriBanco(page, { da: '2026-06-10', a: '2026-06-10', larghezza: 1280 });
    await apri(page);

    const raggi = await page.locator(sel.giornoScelto).first().evaluate((el) => {
      const s = getComputedStyle(el);
      return [
        s.borderTopLeftRadius,
        s.borderTopRightRadius,
        s.borderBottomRightRadius,
        s.borderBottomLeftRadius,
      ].map(parseFloat);
    });
    expect(raggi.every((r) => r > 0)).toBe(true);
  });

  test('la banda dell intervallo e continua: fra due giorni compresi non restano buchi', async ({
    page,
  }) => {
    await apriBanco(page, { larghezza: 1280 });
    await apri(page);

    // IL DIFETTO CHE QUESTA PROVA FERMA: il fondo stava sul GIORNO, che e' un
    // quadrato piu' stretto della sua cella. Fra un giorno e l'altro restava il
    // margine della colonna, e la banda si spezzava in pastiglie con dei buchi
    // in mezzo — a schermo sembravano scintille.
    const celle = page.locator(sel.cellaInIntervallo);
    const quante = await celle.count();
    expect(quante).toBeGreaterThan(3);

    const riquadri = [];
    for (let i = 0; i < quante; i++) riquadri.push(await riquadro(celle.nth(i)));

    // Si guardano solo le coppie sulla stessa riga: a capo settimana le due
    // celle stanno agli estremi opposti della tabella, ed e' giusto che fra
    // loro ci sia dello spazio.
    let coppieAdiacenti = 0;
    for (let i = 1; i < riquadri.length; i++) {
      const prima = riquadri[i - 1];
      const dopo = riquadri[i];
      if (Math.abs(prima.y - dopo.y) > 1) continue;
      coppieAdiacenti++;
      expect(Math.abs(prima.x + prima.width - dopo.x)).toBeLessThanOrEqual(1);
    }
    expect(coppieAdiacenti).toBeGreaterThan(3);
  });

  test('i bersagli da premere sono grandi abbastanza da colpirli', async ({ page }) => {
    await apriBanco(page, { larghezza: 360, altezza: 900 });
    await apri(page);

    // La soglia e' quella del criterio 2.5.8 delle WCAG 2.2 (livello AA): 24
    // pixel per lato. Si misura sulla finestra piu' stretta, che e' quella in
    // cui il calendario si stringe di piu': se ci sta li', ci sta ovunque.
    const giorni = page.locator(sel.giorno);
    const quanti = await giorni.count();
    expect(quanti).toBeGreaterThan(20);

    for (const indice of [0, Math.floor(quanti / 2), quanti - 1]) {
      const cella = await riquadro(giorni.nth(indice));
      expect(cella.width, `larghezza del giorno ${indice}`).toBeGreaterThanOrEqual(24);
      expect(cella.height, `altezza del giorno ${indice}`).toBeGreaterThanOrEqual(24);
    }

    for (const comando of [sel.meseIndietro, sel.meseAvanti, sel.applica, sel.annulla]) {
      const box = await riquadro(page.locator(comando));
      expect(box.width, comando).toBeGreaterThanOrEqual(24);
      expect(box.height, comando).toBeGreaterThanOrEqual(24);
    }
  });

  test('il piede segue il calendario senza una fascia vuota in mezzo', async ({ page }) => {
    await apriBanco(page, { larghezza: 1280 });
    await apri(page);

    // IL DIFETTO CHE QUESTA PROVA FERMA: il piede veniva spinto in fondo alla
    // colonna. Quando l'elenco dei periodi era piu' alto del calendario — e lo
    // era sempre — fra i giorni e i due pulsanti si apriva una fascia vuota
    // alta decine di pixel, che si leggeva come qualcosa che non aveva finito
    // di caricare.
    const calendario = await riquadro(page.locator(sel.calendario));
    const piede = await riquadro(page.locator(sel.piede));
    const vuoto = piede.y - (calendario.y + calendario.height);
    expect(vuoto).toBeGreaterThanOrEqual(0);
    expect(vuoto).toBeLessThanOrEqual(40);
  });

  test('i due mesi stanno affiancati, separati e non sovrapposti', async ({ page }) => {
    await apriBanco(page, { larghezza: 1280 });
    await apri(page);

    const mesi = page.locator(sel.mese);
    await expect(mesi).toHaveCount(2);

    const sinistra = await riquadro(mesi.nth(0));
    const destra = await riquadro(mesi.nth(1));
    expect(destra.x).toBeGreaterThanOrEqual(sinistra.x + sinistra.width - 1);
    // Due meta' vere: il divisore cade a meta' del calendario, e ci cade
    // perche' e' il confine fra due elementi larghi uguali.
    expect(Math.abs(sinistra.width - destra.width)).toBeLessThanOrEqual(2);
  });

  test('strettissima, i due mesi si impilano invece di uscire dalla tendina', async ({ page }) => {
    await apriBanco(page, { larghezza: 360, altezza: 1200 });
    await apri(page);

    const mesi = page.locator(sel.mese);
    const sopra = await riquadro(mesi.nth(0));
    const sotto = await riquadro(mesi.nth(1));
    expect(sotto.y).toBeGreaterThanOrEqual(sopra.y + sopra.height - 1);
  });
});
