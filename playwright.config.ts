// playwright.config.ts
//
// Le prove che girano in un browser vero.
//
// PERCHE' ESISTONO, VISTO CHE DI PROVE CE NE SONO GIA' MIGLIAIA. Perche'
// nessuna di quelle apre una finestra. Il selettore del periodo e' stato
// corretto piu' volte su segnalazione a voce — le frecce ancorate al pannello
// sbagliato, gli estremi dell'intervallo senza la punta, i due mesi sfalsati di
// uno — e sono tutti difetti che esistono solo dopo che un motore di
// impaginazione ha calcolato delle misure. Un test che non impagina non li puo'
// vedere: puo' solo verificare che le classi su cui il foglio di stile si
// appoggia esistano ancora, ed e' esattamente quello che fa oggi
// `polaris-selectors.test.ts`, che infatti lo dichiara nel suo commento.
//
// SONO UN COMANDO A PARTE, E DEVONO RESTARLO. `build:verified` — il cancello di
// produzione — fa girare `vitest run`, e queste prove non ci devono entrare:
// un build di produzione non deve scaricare tre browser per rispondere alla
// domanda "il codice compila e i test passano?". Si lanciano con
// `npm run test:e2e`.
//
// TRACCE, IMMAGINI E VIDEO SOLO QUANDO QUALCOSA FALLISCE. Un artefatto per ogni
// esecuzione riuscita e' rumore che nessuno guarda e spazio che qualcuno paga.
// Sui dati personali la garanzia non e' un filtro applicato dopo: e' che qui
// dentro non ce ne sono. Ogni negozio, cliente, ordine ed email che compaiono
// nelle prove sono inventati sul momento e vivono in un database che muore con
// il processo — non c'e' nessun collegamento a un negozio vero da cui possano
// entrare.

import { defineConfig, devices } from '@playwright/test';
import { applicaAmbienteDiProva, BASE } from './e2e/ambiente';

// Le prove compongono da se' alcune cose che il server poi verifica: lo state
// firmato di un addebito, la firma HMAC di un webhook. Per farlo devono avere
// le stesse chiavi del server, e le prendono dallo stesso file — due copie
// scritte a mano si sarebbero disallineate al primo valore cambiato, con un
// sintomo che sembra un difetto dell'app ("firma non valida") e invece e' solo
// la chiave sbagliata.
applicaAmbienteDiProva();

/**
 * La matrice completa si chiede, non capita.
 *
 * A ogni PR gira il solo Chromium: e' la prova di fumo, e deve restare corta
 * abbastanza da essere aspettata. Firefox e WebKit girano di notte, dove una
 * differenza di impaginazione fra motori ha il tempo di essere guardata senza
 * fermare nessuno.
 */
const tuttiIBrowser = process.env.E2E_ALL_BROWSERS === '1';

export default defineConfig({
  testDir: './e2e/tests',
  // I file che toccano il database si azzerano a vicenda: dentro un file le
  // prove girano in ordine, e i file fra loro sono separati da `fullyParallel:
  // false` piu' un lavoratore solo quando il database e' in gioco. Il banco del
  // selettore del periodo non tocca niente e potrebbe correre in parallelo, ma
  // un solo lavoratore per tutto costa pochi secondi e toglie di mezzo una
  // classe intera di fallimenti che si riproducono una volta su dieci.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Un solo posto da cui si decide la lingua del browser: alcune delle
    // formattazioni che le prove guardano — le date scritte nei due campi —
    // passano da Intl, e Intl guarda qui.
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(tuttiIBrowser
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],

  webServer: {
    command: 'npx tsx e2e/server/main.ts',
    url: `${BASE}/__test/fakes`,
    // Il primo avvio costruisce un Postgres in WebAssembly e gli applica tutte
    // le migrazioni: e' l'unica parte lenta, e succede una volta sola.
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
