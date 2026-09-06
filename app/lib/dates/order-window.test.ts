import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isSupportedTimeZone,
  orderWindow,
  placedAtWindowSQL,
} from './order-window';

/** Quante ore dura davvero un giorno, secondo i confini calcolati. */
function hours(from: Date, toExclusive: Date): number {
  return (toExclusive.getTime() - from.getTime()) / 3_600_000;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('un ordine cade nel giorno in cui il negozio lo ha visto arrivare', () => {
  it('a Roma la mezzanotte e le 22 di Greenwich, non le 00', () => {
    const { fromUtc, toExclusiveUtc } = orderWindow(
      { from: '2026-08-10', to: '2026-08-10' },
      'Europe/Rome',
    );

    // Un ordine delle 23:30 del 9 agosto a Roma (21:30Z) e' del giorno prima;
    // uno delle 00:30 del 10 (22:30Z del 9) e' di questo. Con i confini presi
    // in UTC il secondo sarebbe finito nel giorno sbagliato — ed e' l'ora in cui
    // gli ordini arrivano davvero.
    expect(fromUtc.toISOString()).toBe('2026-08-09T22:00:00.000Z');
    expect(toExclusiveUtc.toISOString()).toBe('2026-08-10T22:00:00.000Z');

    const primaDiMezzanotte = new Date('2026-08-09T21:30:00Z');
    const dopoMezzanotte = new Date('2026-08-09T22:30:00Z');
    expect(primaDiMezzanotte < fromUtc).toBe(true);
    expect(dopoMezzanotte >= fromUtc && dopoMezzanotte < toExclusiveUtc).toBe(true);
  });

  it('a Los Angeles lo stesso giorno comincia sette ore dopo Greenwich', () => {
    const { fromUtc, toExclusiveUtc } = orderWindow(
      { from: '2026-08-10', to: '2026-08-10' },
      'America/Los_Angeles',
    );

    expect(fromUtc.toISOString()).toBe('2026-08-10T07:00:00.000Z');
    expect(toExclusiveUtc.toISOString()).toBe('2026-08-11T07:00:00.000Z');

    // Le 23:30 del 10 agosto in California sono gia' l'11 a Greenwich: con i
    // confini in UTC quell'ordine sarebbe sparito dal giorno del merchant.
    const seraDelDieci = new Date('2026-08-11T06:30:00Z');
    expect(seraDelDieci >= fromUtc && seraDelDieci < toExclusiveUtc).toBe(true);
  });
});

describe('i due giorni dell anno che non durano ventiquattro ore', () => {
  it('il giorno in cui si va sull ora legale dura ventitre ore', () => {
    // Roma, 29 marzo 2026: alle 02:00 l'orologio salta alle 03:00.
    const roma = orderWindow({ from: '2026-03-29', to: '2026-03-29' }, 'Europe/Rome');
    expect(roma.fromUtc.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(roma.toExclusiveUtc.toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(hours(roma.fromUtc, roma.toExclusiveUtc)).toBe(23);

    // Los Angeles cambia tre settimane prima, l'8 marzo.
    const losAngeles = orderWindow(
      { from: '2026-03-08', to: '2026-03-08' },
      'America/Los_Angeles',
    );
    expect(hours(losAngeles.fromUtc, losAngeles.toExclusiveUtc)).toBe(23);
  });

  it('il giorno in cui si torna all ora solare ne dura venticinque', () => {
    const roma = orderWindow({ from: '2026-10-25', to: '2026-10-25' }, 'Europe/Rome');
    expect(roma.fromUtc.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(roma.toExclusiveUtc.toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(hours(roma.fromUtc, roma.toExclusiveUtc)).toBe(25);

    const losAngeles = orderWindow(
      { from: '2026-11-01', to: '2026-11-01' },
      'America/Los_Angeles',
    );
    expect(hours(losAngeles.fromUtc, losAngeles.toExclusiveUtc)).toBe(25);
  });

  it('un mese che contiene il cambio dura un giorno piu un ora, non un giorno tondo', () => {
    // E' il conto che sbaglia chi somma 86.400.000 millisecondi per ogni
    // giorno: ottobre a Roma dura 31 giorni PIU' un'ora.
    const ottobre = orderWindow({ from: '2026-10-01', to: '2026-10-31' }, 'Europe/Rome');
    expect(hours(ottobre.fromUtc, ottobre.toExclusiveUtc)).toBe(31 * 24 + 1);
  });

  it('c e chi sposta l orologio proprio a mezzanotte', () => {
    // Santiago, 6 settembre 2026: si passa dalle 00:00 alle 01:00, quindi quel
    // giorno la mezzanotte non esiste. Il giorno comincia al salto — il primo
    // istante che quel giorno abbia davvero — e non un'ora prima, che sarebbe
    // dentro il giorno precedente.
    const santiago = orderWindow({ from: '2026-09-06', to: '2026-09-06' }, 'America/Santiago');
    expect(santiago.fromUtc.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(hours(santiago.fromUtc, santiago.toExclusiveUtc)).toBe(23);
  });
});

describe('l intervallo e semiaperto: la fine appartiene al giorno dopo', () => {
  it('l ordine fatto allo scoccare della mezzanotte sta in un periodo solo', () => {
    const agosto = orderWindow({ from: '2026-08-01', to: '2026-08-31' }, 'Europe/Rome');
    const settembre = orderWindow({ from: '2026-09-01', to: '2026-09-30' }, 'Europe/Rome');

    // Con un `<=` da una parte e un `>=` dall'altra questo ordine finirebbe in
    // tutti e due, e la somma di due mesi non farebbe piu' l'anno.
    const scoccare = agosto.toExclusiveUtc;
    expect(scoccare.getTime()).toBe(settembre.fromUtc.getTime());
    expect(scoccare < agosto.toExclusiveUtc).toBe(false);
    expect(scoccare >= settembre.fromUtc && scoccare < settembre.toExclusiveUtc).toBe(true);
  });

  it('due periodi consecutivi si toccano senza sovrapporsi ne lasciare buchi', () => {
    const primo = orderWindow({ from: '2026-08-10', to: '2026-08-10' }, 'America/Los_Angeles');
    const secondo = orderWindow({ from: '2026-08-11', to: '2026-08-11' }, 'America/Los_Angeles');
    expect(primo.toExclusiveUtc.getTime()).toBe(secondo.fromUtc.getTime());
  });

  it('la query chiede >= e <, mai <=', () => {
    const sql = placedAtWindowSQL({ from: '2026-08-01', to: '2026-08-31' }, 'Europe/Rome');
    expect(sql).toContain("o.placed_at >= TIMESTAMP '2026-08-01 00:00:00'");
    expect(sql).toContain("o.placed_at < TIMESTAMP '2026-09-01 00:00:00'");
    expect(sql).not.toContain('<=');
    // Il vecchio modo di allungare il periodo: un giorno aggiunto in SQL, con i
    // confini lasciati interpretare a chi eseguiva la query.
    expect(sql).not.toContain("INTERVAL '1 day'");
    expect(sql).not.toContain('::date');
  });
});

describe('nell SQL non entra niente che non abbiamo scritto noi', () => {
  it('il nome del fuso non finisce mai dentro la query', () => {
    const sql = placedAtWindowSQL({ from: '2026-08-01', to: '2026-08-31' }, 'Europe/Rome');
    expect(sql).not.toContain('Europe/Rome');
  });

  it('un fuso costruito ad arte non arriva all SQL: si ripiega su UTC', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cattivo = "Europe/Rome'; DROP TABLE orders; --";

    const window = orderWindow({ from: '2026-08-01', to: '2026-08-01' }, cattivo);
    expect(window.timeZone).toBe('UTC');
    expect(window.fallback).toBe('invalid');
    expect(window.fromUtc.toISOString()).toBe('2026-08-01T00:00:00.000Z');

    const sql = placedAtWindowSQL({ from: '2026-08-01', to: '2026-08-01' }, cattivo);
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('--');
    expect(warn).toHaveBeenCalled();
  });

  it('un fuso che non esiste vale quanto uno scritto male', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isSupportedTimeZone('Europe/Rome')).toBe(true);
    expect(isSupportedTimeZone('America/Los_Angeles')).toBe(true);
    expect(isSupportedTimeZone('UTC')).toBe(true);
    expect(isSupportedTimeZone('Mars/Olympus')).toBe(false);
    expect(isSupportedTimeZone('+02:00')).toBe(false);
    expect(isSupportedTimeZone('')).toBe(false);
    expect(isSupportedTimeZone(null)).toBe(false);
    expect(isSupportedTimeZone(42)).toBe(false);
  });

  it('una data che non e una data non entra affatto', () => {
    for (const bad of ["2026-08-01'; DROP TABLE orders; --", '2026-13-01', '2026-02-30', 'ieri', '']) {
      expect(() => orderWindow({ from: bad, to: '2026-08-31' }, 'Europe/Rome')).toThrow(
        /Data non valida/,
      );
      expect(() => orderWindow({ from: '2026-08-01', to: bad }, 'Europe/Rome')).toThrow(
        /Data non valida/,
      );
    }
  });
});

describe('il negozio senza fuso', () => {
  it('conta i giorni in UTC, e lo scrive nel log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const window = orderWindow({ from: '2026-08-01', to: '2026-08-31' }, null);

    expect(window.timeZone).toBe('UTC');
    expect(window.fallback).toBe('missing');
    expect(window.fromUtc.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(window.toExclusiveUtc.toISOString()).toBe('2026-09-01T00:00:00.000Z');

    // Non silenzioso: un negozio che conta i giorni in UTC mostra numeri che non
    // tornano con il suo pannello Shopify, e senza una riga di log nessuno
    // saprebbe mai perche'.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('senza fuso orario');
  });

  it('un fuso vuoto e un fuso assente sono la stessa cosa', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const niente of [null, undefined, '']) {
      expect(orderWindow({ from: '2026-08-01', to: '2026-08-01' }, niente).fallback).toBe(
        'missing',
      );
    }
  });
});
