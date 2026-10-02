import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { advisoryDi, validaEccezioni, valuta } from './audit-gate-regole.mjs';

/**
 * Le regole del cancello di `npm audit`, provate su rapporti finti con la
 * stessa forma di `npm audit --json`: la catena reale di Remix 2 (turbo-stream
 * radice, i pacchetti @remix-run che la contengono) ridotta all'osso.
 */

const TURBO = 'GHSA-rxv8-25v2-qmq8';
const RR_REDIRECT = 'GHSA-wrjc-x8rr-h8h6';

const advisory = (id: string, nome: string, severity: string) => ({
  source: 1,
  name: nome,
  dependency: nome,
  title: 'finto',
  url: `https://github.com/advisories/${id}`,
  severity,
  range: '*',
});

function rapporto(extra: Record<string, unknown> = {}) {
  return {
    metadata: { vulnerabilities: { critical: 0, high: 2, moderate: 1, low: 0 } },
    vulnerabilities: {
      'turbo-stream': { severity: 'high', via: [advisory(TURBO, 'turbo-stream', 'high')] },
      '@remix-run/react': { severity: 'high', via: ['turbo-stream', 'react-router'] },
      'react-router': {
        severity: 'moderate',
        via: [advisory(RR_REDIRECT, 'react-router', 'moderate'), '@remix-run/react'],
      },
      ...extra,
    },
  };
}

const eccezione = (pacchetto: string, advisoryIds: string[], scadenza = '2026-12-31') => ({
  pacchetto,
  advisory: advisoryIds,
  motivo: 'motivo',
  mitigazione: 'prova',
  owner: 'Stefano Ghisoni',
  scadenza,
});

const OGGI = '2026-10-01';

describe('advisoryDi', () => {
  it('risale la catena via fino agli advisory veri, senza girare in tondo', () => {
    const r = rapporto();
    expect([...advisoryDi(r, 'turbo-stream')]).toEqual([TURBO]);
    // react-router rimanda a @remix-run/react, che rimanda a react-router: il ciclo non deve bloccare.
    expect([...advisoryDi(r, '@remix-run/react')].sort()).toEqual([RR_REDIRECT, TURBO].sort());
  });
});

describe('validaEccezioni', () => {
  it('accetta una voce completa', () => {
    expect(validaEccezioni([eccezione('turbo-stream', [TURBO])])).toEqual([]);
  });

  it('pretende advisory reali, owner e mitigazione', () => {
    const errori = validaEccezioni([
      { pacchetto: 'a', advisory: [], motivo: 'm', mitigazione: 'p', owner: 'o', scadenza: '2026-12-31' },
      { pacchetto: 'b', advisory: ['GHSA-...'], motivo: 'm', mitigazione: 'p', owner: 'o', scadenza: '2026-12-31' },
      { pacchetto: 'c', advisory: [TURBO], motivo: 'm', mitigazione: 'p', owner: ' ', scadenza: '2026-12-31' },
      { pacchetto: 'd', advisory: [TURBO], motivo: 'm', owner: 'o', scadenza: '2026-12-31' },
      { pacchetto: 'e', advisory: [TURBO], motivo: 'm', mitigazione: 'p', owner: 'o', scadenza: '31/12/2026' },
    ]);
    expect(errori).toEqual([
      "a: 'advisory' deve elencare almeno un ID GHSA",
      'b: advisory non valido "GHSA-..." (serve l\'ID GHSA completo)',
      "c: manca 'owner'",
      "d: manca 'mitigazione'",
      "e: 'scadenza' deve essere una data AAAA-MM-GG",
    ]);
  });

  it('rifiuta date impossibili (giorno o mese fuori intervallo)', () => {
    const errori = validaEccezioni([
      eccezione('a', [TURBO], '2026-13-01'), // mese 13
      eccezione('b', [TURBO], '2026-02-30'), // 30 febbraio
      eccezione('c', [TURBO], '2026-04-31'), // 31 aprile
    ]);
    expect(errori).toEqual([
      "a: 'scadenza' 2026-13-01 non e' una data valida",
      "b: 'scadenza' 2026-02-30 non e' una data valida",
      "c: 'scadenza' 2026-04-31 non e' una data valida",
    ]);
  });

  it('segnala lo stesso pacchetto ripetuto', () => {
    const errori = validaEccezioni([eccezione('x', [TURBO]), eccezione('x', [TURBO])]);
    expect(errori).toEqual(['x: pacchetto ripetuto']);
  });

  it('il file vero del repository e\' scritto bene', () => {
    const file = JSON.parse(
      readFileSync(path.join(import.meta.dirname, 'audit-exceptions.json'), 'utf8'),
    );
    expect(validaEccezioni(file.eccezioni)).toEqual([]);
    for (const e of file.eccezioni) expect(e.owner).toBe('Stefano Ghisoni');
  });
});

describe('valuta', () => {
  const base = { grafoCompleto: rapporto(), grafoProduzione: rapporto(), oggi: OGGI };

  it('passa quando ogni alta di produzione ha un\'eccezione che nomina tutti i suoi advisory', () => {
    const esito = valuta({
      ...base,
      eccezioni: [eccezione('turbo-stream', [TURBO]), eccezione('@remix-run/react', [TURBO, RR_REDIRECT])],
    });
    expect(esito.bloccanti).toEqual([]);
    expect(esito.coperte.map((c) => c.nome).sort()).toEqual(['@remix-run/react', 'turbo-stream']);
    expect(esito.inutili).toEqual([]);
  });

  it('blocca un advisory nuovo nella catena che l\'eccezione non nomina', () => {
    const esito = valuta({
      ...base,
      eccezioni: [eccezione('turbo-stream', [TURBO]), eccezione('@remix-run/react', [TURBO])],
    });
    expect(esito.bloccanti).toEqual([
      {
        nome: '@remix-run/react',
        gravita: 'high',
        motivo: `advisory non nominati nell'eccezione: ${RR_REDIRECT}`,
      },
    ]);
    // Incompleta non vuol dire inutile: il pacchetto e' ancora vulnerabile.
    expect(esito.inutili).toEqual([]);
  });

  it('blocca un pacchetto senza eccezione e uno con eccezione scaduta', () => {
    const esito = valuta({
      ...base,
      eccezioni: [eccezione('turbo-stream', [TURBO], '2026-09-30')],
    });
    expect(esito.bloccanti.map((b) => [b.nome, b.motivo])).toEqual([
      ['turbo-stream', 'eccezione scaduta'],
      ['@remix-run/react', 'nessuna eccezione'],
    ]);
    expect(esito.scadute.map((e) => e.pacchetto)).toEqual(['turbo-stream']);
  });

  it('una critica fra gli strumenti di sviluppo blocca anche se la produzione e\' pulita', () => {
    const completo = rapporto({
      esbuild: { severity: 'critical', via: [advisory('GHSA-67mh-4wv8-2f99', 'esbuild', 'critical')] },
    });
    const esito = valuta({
      grafoCompleto: completo,
      grafoProduzione: { metadata: rapporto().metadata, vulnerabilities: {} },
      eccezioni: [],
      oggi: OGGI,
    });
    expect(esito.bloccanti.map((b) => b.nome)).toEqual(['esbuild']);
  });

  it('le moderate in produzione non bloccano', () => {
    const solo = {
      metadata: rapporto().metadata,
      vulnerabilities: {
        morgan: { severity: 'moderate', via: [advisory('GHSA-9f6g-j8ch-79g4', 'morgan', 'moderate')] },
      },
    };
    const esito = valuta({ grafoCompleto: solo, grafoProduzione: solo, eccezioni: [], oggi: OGGI });
    expect(esito.bloccanti).toEqual([]);
  });

  it('segnala, senza bloccare, eccezioni e advisory che non servono piu\'', () => {
    const esito = valuta({
      ...base,
      eccezioni: [
        eccezione('turbo-stream', [TURBO, 'GHSA-2222-3333-4444']),
        eccezione('@remix-run/react', [TURBO, RR_REDIRECT]),
        eccezione('vecchio', [TURBO]),
      ],
    });
    expect(esito.bloccanti).toEqual([]);
    expect(esito.inutili.map((e) => e.pacchetto)).toEqual(['vecchio']);
    expect(esito.advisoryInEccesso).toEqual([
      { pacchetto: 'turbo-stream', advisory: ['GHSA-2222-3333-4444'] },
    ]);
  });
});
