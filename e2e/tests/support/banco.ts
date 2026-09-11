// e2e/tests/support/banco.ts
//
// Gli appigli del banco di prova, in un posto solo.
//
// SULLA SCELTA DEI SELETTORI, che e' la decisione che fa invecchiare male una
// suite. Non si cerca mai per testo tradotto scritto a mano: "Applica" oggi,
// "Conferma" domani, e trenta prove diventano rosse per una parola cambiata in
// un dizionario. Dove serve un nome lo si chiede AL DIZIONARIO dell'app, che e'
// la stessa fonte che lo scrive a schermo — cosi' una traduzione che cambia
// cambia da tutte e due le parti insieme, e una voce che sparisce non compila.
//
// Per tutto il resto si usa cio' che una lingua non tocca: il ruolo, le classi
// di impaginazione nostre (`range-picker__*`) e quelle di stato di Polaris
// (`Polaris-DatePicker__Day--selected`). Le seconde sono interne, e appoggiarcisi
// e' gia' una scelta dichiarata in `app/dashboard.css` e sorvegliata da
// `polaris-selectors.test.ts`: queste prove stanno sullo stesso contratto, e se
// un aggiornamento di Polaris lo rompe e' giusto che lo dicano anche loro.

import type { Page } from '@playwright/test';
import { it as italiano } from '~/lib/i18n/it';
import { en as inglese } from '~/lib/i18n/en';

export const dizionario = { it: italiano, en: inglese } as const;
export type Lingua = keyof typeof dizionario;

export interface OpzioniBanco {
  lingua?: Lingua;
  /** L'istante a cui l'orologio della pagina resta fermo. */
  adesso?: string;
  /** Il fuso del negozio, come lo dichiara a Shopify. */
  fuso?: string;
  /** Il periodo gia' applicato all'apertura. */
  da?: string;
  a?: string;
  larghezza?: number;
  altezza?: number;
}

/**
 * L'istante di riferimento di tutte le prove sul selettore.
 *
 * Un mercoledi' di fine agosto, scelto perche' e' scomodo nel modo giusto: il
 * periodo di default finisce a meta' settimana, l'intervallo di partenza sta a
 * cavallo di due mesi, e il mese precedente ne ha 31 di giorni — cioe' la
 * griglia ha una riga in piu' che il mese corrente non ha.
 */
export const ADESSO = '2026-08-26T10:00:00.000Z';

export async function apriBanco(page: Page, opzioni: OpzioniBanco = {}): Promise<void> {
  const {
    lingua = 'it',
    adesso = ADESSO,
    fuso = 'Europe/Rome',
    da = '2026-06-03',
    a = '2026-06-17',
    larghezza = 1280,
    altezza = 900,
  } = opzioni;

  await page.setViewportSize({ width: larghezza, height: altezza });
  await page.goto(
    `/?locale=${lingua}&now=${encodeURIComponent(adesso)}&tz=${encodeURIComponent(fuso)}&from=${da}&to=${a}`,
  );
  await page.locator(sel.attivatore).waitFor();
}

/** Gli appigli, tutti qui: una modifica all'impaginazione si insegue in un posto solo. */
export const sel = {
  /** Il pulsante che apre il selettore: il primo dei due filtri. */
  attivatore: '[data-testid="filters"] > div:first-child button',
  /** Il pulsante del confronto, che e' il secondo. */
  attivatoreConfronto: '[data-testid="filters"] > div:last-child button',
  pannello: '.range-picker',
  colonna: '.range-picker__sidebar',
  corpo: '.range-picker__body',
  campi: '.range-picker__fields input',
  freccia: '.range-picker__arrow',
  calendario: '.range-picker__calendar',
  barraMesi: '.range-picker__months',
  meseIndietro: '.range-picker__months button:first-child',
  meseAvanti: '.range-picker__months button:last-child',
  titoloMese: '.Polaris-DatePicker__Title',
  giorno: '.range-picker__calendar .Polaris-DatePicker__Day',
  giornoScelto: '.range-picker__calendar .Polaris-DatePicker__Day--selected',
  primoEstremo: '.range-picker__calendar .Polaris-DatePicker__Day--firstInRange',
  ultimoEstremo: '.range-picker__calendar .Polaris-DatePicker__Day--lastInRange',
  cellaInIntervallo: '.range-picker__calendar .Polaris-DatePicker__DayCell--inRange',
  mese: '.range-picker__calendar .Polaris-DatePicker__MonthContainer',
  piede: '.range-picker__actions',
  annulla: '.range-picker__actions button:first-child',
  applica: '.range-picker__actions button:last-child',
  periodoApplicato: '[data-testid="applied-range"]',
  applicazioni: '[data-testid="applied-count"]',
  prima: '[data-testid="before"]',
} as const;

/** Il giorno del mese visibile, cercato per numero dentro un certo mese. */
export function giornoDelMese(page: Page, indiceMese: number, numero: number) {
  return page
    .locator(sel.mese)
    .nth(indiceMese)
    .locator('.Polaris-DatePicker__Day', { hasText: new RegExp(`^${numero}$`) })
    .first();
}

/** La pagina non deve mai scorrere di lato: e' il difetto che si vede subito e si dimentica sempre. */
export async function scorrimentoOrizzontale(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}
