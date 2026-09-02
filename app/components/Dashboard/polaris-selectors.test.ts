import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Il contratto fragile: le classi interne di Polaris su cui il nostro CSS si
 * appoggia.
 *
 * Non e' una scelta, e' la conseguenza di restare sul DatePicker React: il
 * calendario non espone nessun appiglio pubblico per la larghezza di una cella
 * ne' per lo spazio fra due mesi, e senza toccarle il selettore dei periodi non
 * sta nei 700px della tendina.
 *
 * Il problema di appoggiarsi a una classe interna e' che puo' sparire con un
 * aggiornamento senza che nessuno lo dichiari — e quando succede non si rompe
 * niente in modo rumoroso: la regola semplicemente smette di applicarsi, e il
 * calendario torna a stirarsi per tutta la pagina. Questo test rende quel
 * silenzio un fallimento: se una classe che il nostro foglio di stile prende di
 * mira non esiste piu' in quello di Polaris, la CI lo dice.
 *
 * Cio' che questo test NON puo' dire: che il risultato a schermo sia giusto.
 * Per quello serve un browser vero, che misuri la larghezza reale; qui si
 * verifica solo che gli appigli esistano ancora.
 */

const ROOT = resolve(__dirname, '../../..');
const NOSTRO = readFileSync(resolve(ROOT, 'app/dashboard.css'), 'utf8');
const POLARIS = readFileSync(
  resolve(ROOT, 'node_modules/@shopify/polaris/build/esm/styles.css'),
  'utf8',
);

/** Le classi Polaris che il nostro foglio di stile prende di mira. */
function classiUsate(css: string): string[] {
  const trovate = new Set<string>();
  for (const match of css.matchAll(/\.(Polaris-[A-Za-z0-9_-]+)/g)) trovate.add(match[1]);
  return [...trovate].sort();
}

describe('le classi Polaris su cui il nostro CSS si appoggia', () => {
  const usate = classiUsate(NOSTRO);

  it('sono davvero delle classi, e non poche', () => {
    // Se questo elenco si svuota, il resto del test passerebbe senza provare
    // niente: e' successo con controlli di questo tipo, e vale la spesa di una
    // riga per non farlo succedere qui.
    expect(usate.length).toBeGreaterThan(10);
  });

  it('esistono tutte nella versione di Polaris installata', () => {
    const sparite = usate.filter((classe) => !POLARIS.includes(classe));

    // Se questo elenco non e' vuoto, un aggiornamento di Polaris ha rinominato
    // o tolto quelle classi: le regole in app/dashboard.css che le prendono di
    // mira non si applicano piu', in silenzio. Vanno riscritte sulla classe
    // nuova, non cancellate.
    expect(sparite).toEqual([]);
  });
});
