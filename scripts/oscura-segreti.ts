/**
 * Toglie dall'output di una migrazione tutto cio' che identifica il database:
 * password, utente, host, riferimento del progetto Supabase.
 *
 * PERCHE' NON BASTA GITHUB. GitHub oscura i segreti nel log del run, ma solo
 * li': il registro della migrazione si conserva anche come artifact scaricabile
 * e nel riepilogo del run, e quelli sono file scritti da noi, che GitHub non
 * ripulisce. In piu' oscura il segreto INTERO, non i pezzi: Prisma stampa
 * `Datasource "db": ... at "db.<ref>.supabase.co:5432"`, cioe' l'host senza il
 * resto dell'indirizzo, e quello nel log restava in chiaro.
 *
 * Si usa come filtro:
 *
 *   comando 2>&1 | npx tsx scripts/oscura-segreti.ts | tee registro.log
 *
 * Legge gli indirizzi da DATABASE_URL e PSQL_URL, cioe' dalle stesse variabili
 * che usano Prisma e psql nel workflow.
 */

import { createInterface } from 'node:readline';

/** Sotto questa lunghezza un valore non si oscura: "postgres" o "5432" non dicono niente e sono ovunque. */
const MINIMO = 6;

/** I pezzi di un indirizzo che non devono finire in un file. */
export function pezziDaOscurare(indirizzo: string | undefined): string[] {
  if (!indirizzo) return [];
  const pezzi = [indirizzo];
  try {
    const url = new URL(indirizzo);
    if (url.password) pezzi.push(url.password, decodeURIComponent(url.password));
    // `postgres` da solo non identifica niente; `postgres.<ref>` (il pooler di
    // Supabase) porta il riferimento del progetto.
    if (url.username && url.username !== 'postgres') {
      pezzi.push(url.username, decodeURIComponent(url.username));
    }
    if (url.hostname) pezzi.push(url.hostname);
    // Il riferimento del progetto, ovunque compaia: `db.<ref>.supabase.co`
    // oppure `postgres.<ref>`.
    const ref =
      /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1] ??
      /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(url.username))?.[1];
    if (ref) pezzi.push(ref);
  } catch {
    // Un indirizzo che non si lascia leggere si oscura comunque intero.
  }
  return pezzi;
}

/** Il testo con ogni pezzo sostituito, dal piu' lungo al piu' corto. */
export function oscura(testo: string, pezzi: string[]): string {
  const ordinati = [...new Set(pezzi)]
    .filter((pezzo) => pezzo.length >= MINIMO)
    .sort((a, b) => b.length - a.length);
  let risultato = testo;
  for (const pezzo of ordinati) risultato = risultato.split(pezzo).join('***');
  return risultato;
}

async function principale(): Promise<void> {
  const pezzi = [
    ...pezziDaOscurare(process.env.DATABASE_URL),
    ...pezziDaOscurare(process.env.PSQL_URL),
  ];
  // Riga per riga: un segreto non viene mai spezzato a meta' fra due blocchi
  // letti dallo stream, e l'output esce mentre il comando lavora.
  for await (const riga of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    process.stdout.write(`${oscura(riga, pezzi)}\n`);
  }
}

if (process.argv[1]?.endsWith('oscura-segreti.ts')) {
  void principale();
}
