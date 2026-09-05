import { build } from 'esbuild';
import { resolve } from 'node:path';

/**
 * Il worker, impacchettato.
 *
 * Con `tsc` non si poteva: il progetto usa l'alias `~` e import senza
 * estensione, che sono normali sotto Vite e che NodeNext rifiuta. Compilare
 * l'intero albero `app/lib` in quel modo produceva duecento e passa errori —
 * non perche' il codice sia sbagliato, ma perche' gli si chiedeva di essere
 * scritto in un altro modo. Un bundler quegli import li risolve come li risolve
 * Vite, e mette in un file solo cio' che al worker serve davvero.
 *
 * Restano fuori due pacchetti, e per la stessa ragione: portano con se' del
 * binario. Il client Prisma ha il suo motore e `ioredis` ha dipendenze native —
 * impacchettarli darebbe un file che si costruisce e non parte. Nell'immagine
 * ci sono gia', installati da `npm ci`. (`bullmq` era il terzo: la coda non
 * passa piu' da li'.)
 */
await build({
  entryPoints: ['worker.ts'],
  outfile: 'dist/worker.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // L'alias che Vite conosce e Node no.
  //
  // `resolve` e non `new URL().pathname`: il secondo restituisce un percorso
  // codificato come URL, e in una cartella con uno spazio nel nome — questa —
  // esbuild si ritrova a cercare `Siti%20web`, che non esiste.
  alias: { '~': resolve('app') },
  external: ['@prisma/client', 'ioredis'],
  // Qualche pacchetto dentro il fascio e' scritto per CommonJS e chiama
  // `require` a runtime. In un file ESM quella funzione non esiste, e il
  // worker moriva all'avvio con "Dynamic require of node:buffer is not
  // supported" — un errore che parla di buffer e non ha niente a che vedere
  // con i buffer. Qui gliela si costruisce.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'info',
});
