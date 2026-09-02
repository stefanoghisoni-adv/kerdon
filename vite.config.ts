import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  // L'alias `~`, che nel codice sta ovunque.
  //
  // Sta scritto in `tsconfig.json` (`paths`), che pero' e' un file per il
  // controllo dei tipi: chi costruisce il bundle non e' tenuto a leggerlo. Vite
  // 8 lo faceva da se', Vite 6 no — la versione che il plugin di Remix 2
  // dichiara di supportare — e senza questa riga il build si ferma al primo
  // import `~/...` che incontra. Dirlo qui non dipende piu' da quale delle due
  // versioni e' installata.
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./app"),
    },
  },
  plugins: [
    remix({
      // I test accanto alle route non sono route: senza escluderli, Remix li
      // compila come route module e il build client fallisce (importano
      // `loader`, che nel bundle client viene rimosso perche' server-only).
      ignoredRouteFiles: ["**/*.css", "**/*.test.{ts,tsx}"],
    }),
  ],
});
