import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './app'),
    },
  },
  test: {
    globals: true,
    // Le variabili che la suite si aspetta, dichiarate invece che ereditate:
    // il perche' per esteso sta in quel file.
    setupFiles: ['./vitest.setup.ts'],
    // Le prove end-to-end NON sono di questa suite, e non e' una preferenza:
    // `build:verified` — il cancello di produzione — esegue `vitest run`, e
    // senza questa esclusione un build di produzione raccoglierebbe i file di
    // Playwright, che vitest non sa eseguire. Si lanciano con `npm run test:e2e`,
    // che e' un comando a parte apposta: nessun rilascio deve dipendere da tre
    // browser da scaricare.
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', 'e2e/**'],
    // Il pool a thread (default) fa crashare il processo con SIGSEGV a suite
    // completa, in modo intermittente: i singoli file passano, ma il runner muore
    // prima di stampare il riepilogo, lasciando un conteggio PARZIALE che sembra
    // una regressione. Con i processi separati la suite e' stabile.
    pool: 'forks',
  },
});
