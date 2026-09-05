import { describe, it, expect } from 'vitest';
import { recentRunLabel, recentRunRows } from './recent-runs';
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
