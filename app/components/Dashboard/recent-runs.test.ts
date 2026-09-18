import { describe, it, expect } from 'vitest';
import { PENDING_RUN_ID, recentRunLabel, recentRunRows, withPendingRun } from './recent-runs';
// Alias: `it` e' anche il nome del caso di test in vitest.
import { it as itDict } from '~/lib/i18n/it';

describe('recentRunLabel', () => {
  it('una corsa conclusa si chiama nello stesso modo, da qualunque parte sia partita', () => {
    // Periodica o da webhook e' una distinzione nostra: per il merchant e'
    // sempre la stessa cosa, i suoi dati che si allineano.
    for (const type of ['initial_bulk', 'periodic_check', 'webhook', 'qualcosa_di_nuovo']) {
      expect(recentRunLabel(type, 'completed', itDict)).toBe('Sincronizzazione completata');
    }
  });

  it('"completata" solo quando lo e davvero', () => {
    // Accanto c'e' il badge con lo stato: un titolo che promette successo sopra
    // un badge rosso si legge come un errore dell'app.
    expect(recentRunLabel('periodic_check', 'failed', itDict)).toBe('Sincronizzazione');
    expect(recentRunLabel('periodic_check', 'running', itDict)).toBe('Sincronizzazione');
  });

  it('una corsa parziale si chiama parziale, non "in corso"', () => {
    // Distinta anche da "Sincronizzazione" e basta: quella si legge come una
    // corsa ancora in viaggio, e questa invece e' finita lasciando indietro
    // qualcosa. Sono due cose diverse e chi guarda deve poterle distinguere.
    expect(recentRunLabel('periodic_check', 'completed_with_repairs', itDict)).toBe(
      'Sincronizzazione parziale',
    );
  });

  it('per le creazioni di tabella riusa la frase del registro', () => {
    for (const type of ['table_create_products', 'table_create_customers', 'table_create_both']) {
      expect(recentRunLabel(type, 'completed', itDict)).toBe('Creazione tabelle nel database');
    }
  });

  it('nessun titolo ripete l esito, che sta gia nel badge', () => {
    const titoli = [
      recentRunLabel('periodic_check', 'completed', itDict),
      recentRunLabel('periodic_check', 'failed', itDict),
      recentRunLabel('table_create_both', 'completed', itDict),
    ];
    for (const titolo of titoli) expect(titolo).not.toMatch(/riuscit/i);
  });
});

describe('recentRunRows', () => {
  const run = (id: string, jobType: string, status = 'completed'): {
    id: string;
    jobType: string;
    status: string;
    startedAt: string;
  } => ({ id, jobType, status, startedAt: '2026-08-13T10:00:00.000Z' });

  it('tiene le più recenti fino al limite, nell\'ordine ricevuto', () => {
    const rows = recentRunRows(
      [
        run('1', 'periodic_check'),
        run('2', 'periodic_check'),
        run('3', 'periodic_check'),
        run('4', 'periodic_check'),
        run('5', 'periodic_check'),
        run('6', 'periodic_check'),
      ],
      itDict,
      5,
    );

    expect(rows.map((r) => r.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('le richieste GDPR non sono sincronizzazioni e restano fuori', () => {
    // Arrivano da Shopify e finiscono nel registro completo: in un riquadro
    // intitolato "Ultime sincronizzazioni" direbbero una cosa per un'altra.
    const rows = recentRunRows([
      run('gdpr', 'gdpr_redact'),
      run('sync', 'periodic_check'),
    ], itDict);

    expect(rows.map((r) => r.id)).toEqual(['sync']);
  });

  it('porta lo stato della corsa nel badge', () => {
    const rows = recentRunRows([run('ko', 'periodic_check', 'failed')], itDict);

    expect(rows[0].badge).toEqual({ tone: 'critical', label: 'Fallita' });
  });

  it('senza corse non inventa righe', () => {
    expect(recentRunRows([], itDict)).toEqual([]);
  });
});

describe('withPendingRun', () => {
  const corsa = (
    id: string,
    jobType: string,
    status: string,
    startedAt = '2026-08-13T10:00:00.000Z',
  ) => ({ id, jobType, status, startedAt });

  const CHIESTA_ALLE = '2026-08-13T11:00:00.000Z';

  it('mentre il lavoro e in volo la card non mostra in cima una corsa gia chiusa', () => {
    // E' IL SECONDO DEI DUE DIFETTI SEGNALATI. Fra il clic e la partenza del
    // lavoro nessuna riga nuova esiste in `sync_job`: in cima restava quella
    // PRECEDENTE, con il badge "Completato", mentre l'avviso sopra diceva che
    // si stava lavorando. Il merchant leggeva due cose opposte nella stessa
    // schermata.
    const righe = withPendingRun([corsa('prima', 'initial_bulk', 'completed')], {
      since: CHIESTA_ALLE,
    });

    expect(righe[0].status).toBe('running');
    expect(righe[0].startedAt).toBe(CHIESTA_ALLE);
    // La corsa precedente non sparisce: e' avvenuta davvero, ed e' l'unica cosa
    // che il merchant ha da guardare mentre aspetta.
    expect(righe.map((r) => r.id)).toContain('prima');
  });

  it('la riga anteposta si legge "In corso", come dice l avviso', () => {
    const righe = recentRunRows(
      withPendingRun([corsa('prima', 'initial_bulk', 'completed')], { since: CHIESTA_ALLE }),
      itDict,
    );

    expect(righe[0].badge).toEqual({ tone: 'info', label: 'In corso' });
    expect(righe[0].label).toBe('Sincronizzazione');
  });

  it('quando la riga vera esiste non se ne aggiunge una seconda', () => {
    // Quella vera e' migliore: ha l'id del job e l'ora d'inizio esatta.
    const righe = withPendingRun(
      [corsa('vera', 'initial_bulk', 'running'), corsa('prima', 'initial_bulk', 'completed')],
      { since: CHIESTA_ALLE },
    );

    expect(righe.map((r) => r.id)).toEqual(['vera', 'prima']);
  });

  it('a lavoro finito la card non resta a dire "in corso"', () => {
    // Una riga rimasta su 'running' con la coda che dice che nessuno la sta
    // facendo e' un'invocazione stroncata, non una corsa viva: tenerla farebbe
    // dire alla card l'esatto contrario dell'avviso spento, che e' il
    // disaccordo da cui questa correzione e' partita.
    const righe = withPendingRun(
      [corsa('appesa', 'initial_bulk', 'running'), corsa('prima', 'initial_bulk', 'completed')],
      null,
    );

    expect(righe.map((r) => r.id)).toEqual(['prima']);
  });

  it('card e avviso non possono dirsi cose diverse, in nessuna delle due direzioni', () => {
    // La prova che conta: la card mostra una corsa completa in corso SE E SOLO
    // SE l'avviso e' acceso. Le due spie leggono lo stesso valore, e qui si
    // verifica che nessuna combinazione le faccia divergere.
    const casi = [
      [] as ReturnType<typeof corsa>[],
      [corsa('a', 'initial_bulk', 'completed')],
      [corsa('b', 'initial_bulk', 'running')],
      [corsa('c', 'initial_bulk', 'running'), corsa('d', 'initial_bulk', 'failed')],
      [corsa('e', 'periodic_check', 'completed')],
    ];

    for (const corse of casi) {
      for (const pending of [null, { since: CHIESTA_ALLE }]) {
        const righe = withPendingRun(corse, pending);
        const mostraInCorso = righe.some(
          (r) => r.jobType === 'initial_bulk' && r.status === 'running',
        );
        expect(mostraInCorso).toBe(pending !== null);
      }
    }
  });

  it('i controlli periodici restano quelli che sono', () => {
    // Sono lavoro automatico e non c'entrano con il pulsante: la card continua
    // a raccontarli come li trova, in un verso e nell'altro.
    const periodico = [corsa('p', 'periodic_check', 'running')];

    expect(withPendingRun(periodico, null)).toEqual(periodico);
    expect(withPendingRun(periodico, { since: CHIESTA_ALLE }).map((r) => r.id)).toEqual([
      PENDING_RUN_ID,
      'p',
    ]);
  });
});
