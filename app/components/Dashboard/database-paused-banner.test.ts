// app/components/Dashboard/database-paused-banner.test.ts
//
// PERCHE' UN TEST CHE LEGGE DEL CODICE INVECE DI ESEGUIRLO. Perche' quel che va
// garantito qui non e' un valore: e' una regola di tono, e una regola sul
// percorso da cui il banner prende i suoi dati. Sono due cose che un test che
// esegue non vede — il componente renderizzerebbe benissimo anche con il tono
// sbagliato — e che si perdono alla prima modifica distratta.
//
// LA REGOLA, per esteso: warning per TUTTA la vicenda, fase "riattivazione in
// corso" compresa. Finche' il database non risponde la sincronizzazione e'
// ferma e i numeri del merchant non si aggiornano: e' un problema in corso per
// tutta la durata, e non si ammorbidisce solo perche' lui ha gia' premuto il
// pulsante. Si esce dal warning quando il database e' tornato attivo, e li'
// l'avviso sparisce — non diventa `info`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BANNER = readFileSync(resolve(__dirname, 'DatabasePausedBanner.tsx'), 'utf8');
const DASHBOARD = readFileSync(resolve(__dirname, '../../routes/_index.tsx'), 'utf8');

describe('il tono del banner del database in pausa', () => {
  it('e warning, e non ce n e un altro', () => {
    expect(BANNER).toContain('tone="warning"');
    expect(BANNER.match(/tone="/g)).toHaveLength(1);
  });

  it('non esiste nessun tono informativo su questo percorso', () => {
    // Nemmeno nella fase in cui il merchant ha gia' premuto: e' il caso in cui
    // la tentazione di abbassare il tono e' piu' forte, ed e' esattamente il
    // caso in cui il problema sta ancora accadendo.
    expect(BANNER).not.toContain('tone="info"');
    expect(BANNER).not.toContain('tone="success"');
  });

  it('non si chiude', () => {
    // Un avviso che dice che i dati a schermo sono fermi non deve poter
    // sparire lasciando i dati dove sono.
    expect(BANNER).not.toContain('onDismiss');
  });
});

describe('da dove il banner prende la verita', () => {
  it('dallo stato sul server, non da una spia della pagina', () => {
    // La stessa lezione di `pending-sync`: la riattivazione dura minuti, e uno
    // stato tenuto in un `useState` muore al primo cambio di scheda. Qui la
    // domanda "sta gia' ripartendo?" si rifa' al server a ogni rilettura.
    expect(BANNER).toContain("const PATH = '/api/supabase/database-pause'");
    expect(BANNER).toContain('stato.load(PATH)');
    expect(BANNER).not.toMatch(/useState\s*</);
  });

  it('il pulsante c e solo se puo funzionare', () => {
    // Un pulsante che non riattiva niente e' peggio di nessun pulsante: quando
    // il gesto non puo' riuscire resta la strada che riesce, cioe' la pagina
    // del database.
    expect(BANNER).toContain('const mostraPulsante = stato.data.canResume && !riattivando');
    expect(BANNER).toContain('t.databasePaused.openDashboard');
  });

  it('la dashboard lo mostra, e solo a database collegato', () => {
    expect(DASHBOARD).toContain('{supabaseConnected && <DatabasePausedBanner />}');
  });
});
