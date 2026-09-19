// app/components/Dashboard/auto-resume-copy.test.ts
//
// Che cosa il merchant legge sulla riattivazione automatica, e QUANDO.
//
// Un test che legge del codice invece di eseguirlo, come quello sul tono del
// banner qui accanto, e per la stessa ragione: le regole in gioco non sono
// valori — sono "questa frase compare prima che la cosa accada", "questo testo
// non nomina mai il funzionamento interno", "il comando non compare dove non
// puo' fare niente". Un componente renderizzerebbe benissimo anche violandole
// tutte.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BANNER = readFileSync(resolve(__dirname, 'DatabasePausedBanner.tsx'), 'utf8');
const CARD = readFileSync(resolve(__dirname, 'DatabaseCard.tsx'), 'utf8');
const IT = readFileSync(resolve(__dirname, '../../lib/i18n/it.ts'), 'utf8');
const EN = readFileSync(resolve(__dirname, '../../lib/i18n/en.ts'), 'utf8');

describe('il tono non si ammorbidisce nemmeno quando siamo stati noi', () => {
  it('resta un solo tono, ed e warning', () => {
    // "Lo abbiamo riacceso noi" e' pur sempre un database che non risponde
    // ancora e una sincronizzazione ferma: e' un problema in corso a cui
    // abbiamo tolto la parte irreversibile, non una buona notizia.
    expect(BANNER).toContain('tone="warning"');
    expect(BANNER.match(/tone="/g)).toHaveLength(1);
    expect(BANNER).not.toContain('tone="info"');
    expect(BANNER).not.toContain('tone="success"');
  });
});

describe('dichiarata prima, non solo dopo', () => {
  it('il banner dice che lo riaccenderemo noi mentre e ancora fermo', () => {
    expect(BANNER).toContain('t.databasePaused.willAutoResume');
  });

  it('e lo dice solo se l interruttore e davvero acceso', () => {
    // Promettere un intervento che non arrivera' e' peggio che non prometterlo.
    expect(BANNER).toContain('stato.data.autoResumeOn && (');
  });

  it('la spiegazione sta attaccata all interruttore, non altrove', () => {
    // `helpText` e' il motivo per cui il componente e' un Checkbox: la
    // spiegazione non si puo' leggere separata dal comando.
    expect(CARD).toContain('helpText={t.database.autoResume.help}');
    expect(CARD).toContain('label={t.database.autoResume.label}');
  });

  it('l interruttore non compare dove non puo fare niente', () => {
    // Senza database collegato non c'e' niente da riaccendere; senza un posto
    // dove salvare la scelta, il comando mentirebbe.
    expect(CARD).toContain("const mostraAutoResume = connected && autoResume?.available === true");
  });
});

describe('quando siamo stati noi, si dice', () => {
  it('il banner cambia testo, non tono', () => {
    expect(BANNER).toContain('stato.data.resumedByApp');
    expect(BANNER).toContain('t.databasePaused.autoResumed');
  });
});

describe('il copy non racconta mai il funzionamento interno', () => {
  const PAROLE = [
    'API',
    'endpoint',
    'token',
    'cron',
    'Redis',
    'tabella',
    'tabelle',
    'coda',
    'Supabase',
  ];

  /** Le sole righe nuove di questa funzione: il resto del file non e' affar suo. */
  const testiNostri = (sorgente: string): string => {
    const pezzi = [
      /autoResume: \{[\s\S]*?\n    \},/.exec(sorgente)?.[0] ?? '',
      /willAutoResume:[\s\S]*?\n\n/.exec(sorgente)?.[0] ?? '',
      /autoResumed: \{[\s\S]*?\n    \},/.exec(sorgente)?.[0] ?? '',
    ];
    // Via i commenti: spiegano il perche' a chi scrive il codice, e quelli
    // possono e devono nominare le cose per nome.
    return pezzi.join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  };

  for (const [nome, sorgente] of [
    ['italiano', IT],
    ['inglese', EN],
  ] as const) {
    it(`in ${nome} parla solo di dati e di cosa puo fare il merchant`, () => {
      const testi = testiNostri(sorgente);
      expect(testi.length).toBeGreaterThan(200);
      const trovate = PAROLE.filter((p) => new RegExp(`\\b${p}\\b`, 'i').test(testi));
      expect(trovate).toEqual([]);
    });
  }

  it('le stringhe esistono in tutte e due le lingue', () => {
    for (const sorgente of [IT, EN]) {
      expect(sorgente).toContain('willAutoResume:');
      expect(sorgente).toContain('autoResumed: {');
      expect(sorgente).toContain('autoResume: {');
    }
  });
});
