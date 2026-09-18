import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Da dove la dashboard prende la risposta a "sta ancora sincronizzando?".
 *
 * PERCHE' UN TEST CHE LEGGE DEL CODICE INVECE DI ESEGUIRLO. Perche' quel che
 * va garantito qui non e' il valore di una funzione: e' DA DOVE quel valore
 * arriva. La regola sta in `pending-sync.ts` ed e' provata riga per riga dal
 * test accanto; questo file prova l'altra meta', cioe' che la pagina la usi
 * davvero e non torni ad arrangiarsi con la memoria del browser.
 *
 * Il difetto che chiude e' esattamente di questa forma. Il codice era corretto
 * in tutte le sue parti: il fetcher sapeva della POST, il `useState` sapeva
 * dell'ora del clic, `sync_job` sapeva delle corse. Nessuno di quei tre sapeva
 * della coda, dove il lavoro vive davvero, e la somma di tre risposte giuste a
 * domande sbagliate era un avviso che spariva cambiando scheda. Un test che
 * esegue non lo vede: la funzione giusta esiste e passa: semplicemente non la
 * chiama nessuno. Questo lo vede.
 *
 * Cio' che questo test NON dice: che a schermo l'avviso compaia. Per quello
 * servirebbe un browser; qui si verifica che la pagina sia cablata alla sola
 * fonte durevole e a nessun'altra.
 */

const SORGENTE = readFileSync(resolve(__dirname, '_index.tsx'), 'utf8');

describe('la fonte di verita della sincronizzazione in corso', () => {
  it('lo stato arriva dal loader, non dalla memoria del browser', () => {
    // `syncPendingSince` e' il campo che il loader calcola leggendo la coda su
    // Postgres. Finche' e' lui ad accendere `manualSyncing`, cambiare scheda e
    // tornare indietro non cambia niente: il valore si rilegge, non si ricorda.
    expect(SORGENTE).toMatch(
      /const manualSyncing =\s*syncPendingSince !== null \|\| manualSyncFetcher\.state !== 'idle';/,
    );
  });

  it('il loader legge la coda, ed e la coda che il sync manuale riempie', () => {
    expect(SORGENTE).toContain('pendingSyncRequests(shop.id)');
    expect(SORGENTE).toContain('const pendingSince = pendingSyncSince({');
    expect(SORGENTE).toContain('syncPendingSince: pendingSince?.toISOString() ?? null');
  });

  it('non resta nessuna spia che muore alla navigazione', () => {
    // `manualStartedAt` era l'ora del clic tenuta in `useState`: spariva al
    // primo cambio di scheda, ed e' meta' del difetto segnalato. Non deve
    // tornare, in nessuna forma.
    expect(SORGENTE).not.toContain('manualStartedAt');
    // E nemmeno la scadenza contata dal browser: adesso la fine la dichiara il
    // server, che ha tentativi, backoff e lettera morta da guardare.
    expect(SORGENTE).not.toContain('MANUAL_SYNC_TIMEOUT_MS');
  });

  it('avviso, pulsante e card partono tutti dallo stesso valore', () => {
    // E' la garanzia che il merchant ha chiesto: card e avviso non possono
    // dirsi cose diverse, perche' non hanno due valori fra cui divergere.
    expect(SORGENTE).toMatch(/\{setupComplete && manualSyncing && \(/);
    expect(SORGENTE).toMatch(/loading=\{manualSyncing\}/);
    expect(SORGENTE).toMatch(/disabled=\{manualSyncing\}/);
    expect(SORGENTE).toMatch(/const pendingRunSince = manualSyncing \?/);
    expect(SORGENTE).toContain('<RecentRunsCard runs={runsToShow}');
  });

  it('la lettura in piu non costa un giro in piu al database', () => {
    // Il loader ne fa gia' dieci in parallelo, e su Vercel il database e'
    // remoto: un round-trip in fila sarebbe latenza sul TTFB, cioe' sull'LCP
    // della pagina. La riga della coda deve stare dentro il `Promise.all`.
    const promiseAll = SORGENTE.slice(
      SORGENTE.indexOf('await Promise.all(['),
      SORGENTE.indexOf('// La valuta che il merchant si aspetta'),
    );
    expect(promiseAll).toContain('pendingSyncRequests(shop.id)');
  });

  it('il loader guarda la coda e basta: non ci mette dentro niente', () => {
    // LA TEMPESTA CHE NON DEVE TORNARE. Mentre l'avviso e' acceso questo loader
    // gira ogni pochi secondi. Se accodasse qualcosa, ogni giro scriverebbe una
    // riga che sposta l'ancora del recupero e rende il recupero dovuto di
    // nuovo: l'anello si stringe da solo e non si apre piu'. L'unico innesco
    // ammesso resta quello del cambio di piano, che una finestra di calma e la
    // coda stessa tengono a bada.
    const loader = SORGENTE.slice(
      SORGENTE.indexOf('export async function loader('),
      SORGENTE.indexOf('export async function action('),
    );
    expect(loader).not.toContain('enqueueManualSync');
    expect(loader).not.toContain('enqueueInitialBulkSync');
    // E il recupero non si innesca su lavoro gia' in volo, accodato compreso.
    expect(loader).toContain(
      "syncInProgress: syncState === 'in_progress' || pendingSince !== null,",
    );
  });
});
