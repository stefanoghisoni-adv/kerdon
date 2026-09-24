// app/lib/supabase/auto-resume.test.ts
//
// La regola con cui l'app decide di riaccendere il database di qualcun altro.
//
// E' un test che conta piu' degli altri, perche' qui l'errore non si vede: un
// intervento che non arriva non lascia nessuna traccia a schermo, e quando si
// nota e' perche' un merchant ha perso il database. I casi qui sotto sono
// esattamente i modi in cui l'intervento puo' mancare o arrivare dove non deve.
import { describe, it, expect } from 'vitest';
import {
  ATTESA_FRA_TENTATIVI_MS,
  SOGLIA_INTERVENTO_MS,
  TENTATIVI_MASSIMI,
  decideAutoResume,
  sogliaSuperata,
  tempoFermoMs,
  vaInterrogato,
  type AutoResumeFacts,
  type AutoResumeSetting,
} from './auto-resume';

const ORA = new Date('2026-09-18T12:00:00.000Z');

const giorniFa = (n: number) => new Date(ORA.getTime() - n * 86_400_000);

const ACCESO: AutoResumeSetting = { enabled: null, lastAttemptAt: null, attempts: 0 };

/** Un negozio sano, con il database fermo da tanto: il caso in cui si agisce. */
function fatti(over: Partial<AutoResumeFacts> = {}): AutoResumeFacts {
  return {
    availability: 'in-pausa',
    allowed: true,
    setting: ACCESO,
    lastProofOfLife: giorniFa(70),
    now: ORA,
    ...over,
  };
}

describe('la soglia di intervento', () => {
  it('sotto la soglia non si tocca niente', () => {
    // La pausa non e' un guasto: e' come il piano gratuito di Supabase spegne
    // quel che nessuno usa. Un database fermo da un mese non e' in pericolo, e
    // riaccenderlo subito vorrebbe solo dire farselo rimettere in pausa poco
    // dopo.
    expect(decideAutoResume(fatti({ lastProofOfLife: giorniFa(30) }))).toBe('troppo-presto');
  });

  it('un istante prima della soglia si aspetta ancora', () => {
    const quasi = new Date(ORA.getTime() - SOGLIA_INTERVENTO_MS + 1);
    expect(decideAutoResume(fatti({ lastProofOfLife: quasi }))).toBe('troppo-presto');
  });

  it('esattamente alla soglia si interviene', () => {
    const esatta = new Date(ORA.getTime() - SOGLIA_INTERVENTO_MS);
    expect(decideAutoResume(fatti({ lastProofOfLife: esatta }))).toBe('riattiva');
  });

  it('la soglia lascia margine anche sulla lettura piu corta della finestra', () => {
    // Le due fonti ufficiali di Supabase non coincidono: un anno la guida, 90
    // giorni il changelog. Qui si prende la piu' corta, e la soglia deve
    // lasciare dentro quella finestra il tempo di riprovare piu' volte E di far
    // intervenire il merchant. Se qualcuno domani alzasse la soglia, questo
    // test e' il posto in cui la cosa si vede.
    const margineGiorni = (90 * 86_400_000 - SOGLIA_INTERVENTO_MS) / 86_400_000;
    expect(margineGiorni).toBeGreaterThanOrEqual(30);
    // E il margine dev'essere abbastanza largo da contenere tutti i tentativi
    // previsti, non solo il primo.
    expect(margineGiorni * 86_400_000).toBeGreaterThan(
      TENTATIVI_MASSIMI * ATTESA_FRA_TENTATIVI_MS,
    );
  });
});

describe('il caso cieco: collegato a un progetto gia in pausa', () => {
  it('senza nessuna prova di vita si interviene subito', () => {
    // Un merchant che collega Kerdon a un progetto GIA' in pausa non ci lascia
    // nessun appiglio: nessuna sincronizzazione riuscita, nessuna verifica
    // passata. Di quella pausa non sappiamo se sia cominciata ieri o undici
    // mesi fa, e non c'e' modo di saperlo. Aspettare su una data che non
    // conosciamo e' il modo di arrivare tardi.
    expect(decideAutoResume(fatti({ lastProofOfLife: null }))).toBe('riattiva');
  });

  it('il tempo fermo resta ignoto, e non diventa zero', () => {
    // La differenza fra `null` e `0` e' tutto il punto: zero vorrebbe dire
    // "appena cominciata", cioe' l'esatto contrario di quel che sappiamo.
    expect(tempoFermoMs({ lastProofOfLife: null, now: ORA })).toBeNull();
    expect(sogliaSuperata({ lastProofOfLife: null, now: ORA })).toBe(true);
  });

  it('una prova di vita recente riporta il negozio alla regola normale', () => {
    // Il collegamento appena verificato E' una prova di vita: il database ha
    // risposto in quel momento. Senza questo, ogni negozio nuovo verrebbe
    // trattato come cieco.
    expect(decideAutoResume(fatti({ lastProofOfLife: giorniFa(1) }))).toBe('troppo-presto');
  });
});

describe('il freno contro le richieste ripetute', () => {
  it('appena tentato, si aspetta', () => {
    // La stessa rotta del cron la chiama anche un giro ogni mezz'ora: senza
    // questo, un database che non torna su produrrebbe decine di richieste al
    // giorno verso Supabase.
    const setting = { ...ACCESO, lastAttemptAt: new Date(ORA.getTime() - 60_000) };
    expect(decideAutoResume(fatti({ setting }))).toBe('in-attesa');
  });

  it('passata l attesa si riprova', () => {
    const setting = {
      ...ACCESO,
      lastAttemptAt: new Date(ORA.getTime() - ATTESA_FRA_TENTATIVI_MS - 1),
    };
    expect(decideAutoResume(fatti({ setting }))).toBe('riattiva');
  });

  it('esauriti i tentativi si smette di bussare', () => {
    const setting = { ...ACCESO, attempts: TENTATIVI_MASSIMI };
    expect(decideAutoResume(fatti({ setting }))).toBe('tentativi-esauriti');
  });

  it('una riattivazione gia in corso non si richiede', () => {
    // Vale sia per lo stato dichiarato da Supabase sia per il clic del merchant
    // di poco fa: chi chiama passa la disponibilita' gia' passata da
    // `effectiveAvailability`.
    expect(decideAutoResume(fatti({ availability: 'in-riattivazione' }))).toBe('gia-in-corso');
  });

  it('un database attivo non si tocca', () => {
    expect(decideAutoResume(fatti({ availability: 'attivo' }))).toBe('database-attivo');
  });

  it('uno stato che non sappiamo leggere non si tocca', () => {
    expect(decideAutoResume(fatti({ availability: 'sconosciuto' }))).toBe('stato-non-letto');
  });
});

describe('i negozi che non vanno toccati', () => {
  it('un negozio che non puo piu usare l app non si riattiva', () => {
    // Disinstallato, in cancellazione, autorizzazione decaduta, prova finita:
    // la risposta e' una sola, e viene da `capabilities.ts`. Toccare
    // l'infrastruttura di chi se n'e' andato e' esattamente cio' che non deve
    // succedere.
    expect(decideAutoResume(fatti({ allowed: false }))).toBe('negozio-escluso');
  });

  it('e non viene nemmeno interrogato', () => {
    // Piu' di "non si riattiva": non si chiede nemmeno a Supabase come sta il
    // suo progetto. Guardarlo sarebbe toccarlo un po' meno, non non toccarlo.
    expect(
      vaInterrogato({ allowed: false, setting: ACCESO, lastProofOfLife: null, now: ORA }),
    ).toBe(false);
  });

  it('il negozio escluso batte ogni altra ragione', () => {
    // Anche con l'interruttore acceso, il database fermo da un anno e nessun
    // tentativo fatto: resta escluso.
    expect(
      decideAutoResume(fatti({ allowed: false, lastProofOfLife: giorniFa(365) })),
    ).toBe('negozio-escluso');
  });
});

describe('l interruttore del merchant', () => {
  it('spento, l app non interviene', () => {
    expect(decideAutoResume(fatti({ setting: { ...ACCESO, enabled: false } }))).toBe('spento');
  });

  it('spento, non si interroga nemmeno Supabase', () => {
    expect(
      vaInterrogato({
        allowed: true,
        setting: { ...ACCESO, enabled: false },
        lastProofOfLife: giorniFa(200),
        now: ORA,
      }),
    ).toBe(false);
  });

  it('mai toccato vale acceso', () => {
    // E' il comportamento che l'app dichiara accanto all'interruttore e dentro
    // il banner, prima che accada. Un merchant che non ha mai aperto le
    // Impostazioni non ha detto di no.
    expect(decideAutoResume(fatti({ setting: { ...ACCESO, enabled: null } }))).toBe('riattiva');
  });

  it('acceso esplicitamente e acceso', () => {
    expect(decideAutoResume(fatti({ setting: { ...ACCESO, enabled: true } }))).toBe('riattiva');
  });
});

describe('quando non c e ancora dove leggere la scelta', () => {
  it('non si tocca niente', () => {
    // La migrazione la esegue una persona, a mano: fra il rilascio del codice e
    // quel momento la scelta del merchant non e' leggibile. `null` non vuol
    // dire acceso — vuol dire che non gli e' mai stato chiesto, e su un gesto
    // che tocca l'infrastruttura di qualcun altro, in dubbio non si agisce.
    expect(decideAutoResume(fatti({ setting: null }))).toBe('non-configurato');
  });

  it('e non si interroga nemmeno Supabase', () => {
    expect(
      vaInterrogato({ allowed: true, setting: null, lastProofOfLife: null, now: ORA }),
    ).toBe(false);
  });
});
