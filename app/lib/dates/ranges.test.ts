import { describe, it, expect } from 'vitest';
import {
  bfcmRange,
  comparisonRange,
  dayPlaceholder,
  formatDay,
  formatDayNumeric,
  formatRange,
  fromLocalDate,
  groupOfLeaf,
  HEAD_LEAVES,
  leafKey,
  leafRange,
  lengthInDays,
  matchLeaf,
  matchPreset,
  orderRange,
  parseDay,
  presetGroups,
  presetRange,
  quarterRange,
  toLocalDate,
} from './ranges';

// Un martedi', a meta' mese e a meta' trimestre: cosi' i confini si vedono.
const NOW = new Date('2026-08-25T14:00:00Z');

describe('presetRange', () => {
  it('oggi e ieri sono un giorno solo', () => {
    expect(presetRange('today', NOW)).toEqual({ from: '2026-08-25', to: '2026-08-25' });
    expect(presetRange('yesterday', NOW)).toEqual({ from: '2026-08-24', to: '2026-08-24' });
  });

  it('gli ultimi N giorni comprendono oggi', () => {
    // Escluderlo farebbe sparire gli ordini appena arrivati, che sono quelli
    // per cui si guarda.
    expect(presetRange('last7', NOW)).toEqual({ from: '2026-08-19', to: '2026-08-25' });
    expect(lengthInDays(presetRange('last7', NOW)!)).toBe(7);
    expect(lengthInDays(presetRange('last30', NOW)!)).toBe(30);
    expect(lengthInDays(presetRange('last90', NOW)!)).toBe(90);
  });

  it('dall inizio del mese, del trimestre e dell anno', () => {
    expect(presetRange('monthToDate', NOW)).toEqual({ from: '2026-08-01', to: '2026-08-25' });
    // Agosto sta nel trimestre che parte a luglio.
    expect(presetRange('quarterToDate', NOW)).toEqual({ from: '2026-07-01', to: '2026-08-25' });
    expect(presetRange('yearToDate', NOW)).toEqual({ from: '2026-01-01', to: '2026-08-25' });
  });

  it('i periodi chiusi finiscono davvero dove finiscono', () => {
    expect(presetRange('lastMonth', NOW)).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(presetRange('lastQuarter', NOW)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(presetRange('lastYear', NOW)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('a gennaio il mese precedente e dicembre dell anno prima', () => {
    const january = new Date('2026-01-10T00:00:00Z');
    expect(presetRange('lastMonth', january)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('febbraio bisestile non perde un giorno', () => {
    const march = new Date('2024-03-05T00:00:00Z');
    expect(presetRange('lastMonth', march)).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });
});

describe('matchPreset', () => {
  it('riconosce il periodo scelto, per riaprire sulla voce giusta', () => {
    expect(matchPreset({ from: '2026-08-01', to: '2026-08-25' }, NOW)).toBe('monthToDate');
    expect(matchPreset({ from: '2026-08-25', to: '2026-08-25' }, NOW)).toBe('today');
  });

  it('due date qualsiasi restano un intervallo personalizzato', () => {
    expect(matchPreset({ from: '2026-03-03', to: '2026-04-04' }, NOW)).toBe('custom');
  });
});

describe('comparisonRange', () => {
  const range = { from: '2026-08-01', to: '2026-08-25' };

  it('nessun confronto: niente', () => {
    expect(comparisonRange(range, 'none', NOW)).toBeNull();
  });

  it('il periodo precedente e lungo uguale e finisce il giorno prima', () => {
    const before = comparisonRange(range, 'previousPeriod', NOW)!;
    expect(before.to).toBe('2026-07-31');
    expect(lengthInDays(before)).toBe(lengthInDays(range));
  });

  it('l anno precedente tiene le stesse date', () => {
    expect(comparisonRange(range, 'previousYear', NOW)).toEqual({
      from: '2025-08-01',
      to: '2025-08-25',
    });
  });

  it('la corrispondenza per giorno della settimana sposta di 52 settimane', () => {
    const before = comparisonRange(range, 'previousYearWeekday', NOW)!;
    const day = (value: string) => new Date(`${value}T00:00:00Z`).getUTCDay();
    // E' l'unico confronto che non mette un sabato contro un mercoledi'.
    expect(day(before.from)).toBe(day(range.from));
    expect(day(before.to)).toBe(day(range.to));
    expect(lengthInDays(before)).toBe(lengthInDays(range));
  });
});

describe('formatRange', () => {
  it('un giorno solo si scrive una volta', () => {
    expect(formatRange({ from: '2026-08-25', to: '2026-08-25' }, 'it')).not.toContain('–');
  });

  it('due date si scrivono con il trattino in mezzo', () => {
    expect(formatRange({ from: '2026-08-01', to: '2026-08-25' }, 'it')).toContain('–');
  });
});

describe('orderRange', () => {
  it('le due date escono in ordine comunque arrivino', () => {
    expect(orderRange('2026-08-25', '2026-08-01')).toEqual({
      from: '2026-08-01',
      to: '2026-08-25',
    });
  });
});

describe('toLocalDate e fromLocalDate', () => {
  // L'invariante che regge tutto: i tre numeri che si leggono da una Date
  // costruita con toLocalDate sono quelli scritti nella stringa, in qualunque
  // fuso giri il test. E' esattamente cio' che fromIso non garantisce — la sua
  // mezzanotte UTC, letta con i getter locali, a ovest di Greenwich e' il
  // giorno prima, ed e' il giorno prima quello che il calendario accendeva.
  it('la data locale ha i numeri che c erano scritti', () => {
    const date = toLocalDate('2026-08-01');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(7);
    expect(date.getDate()).toBe(1);
  });

  it('andata e ritorno non perdono un giorno', () => {
    for (const day of ['2026-01-01', '2026-08-01', '2026-12-31', '2024-02-29']) {
      expect(fromLocalDate(toLocalDate(day))).toBe(day);
    }
  });
});

describe('bfcmRange', () => {
  // Dal venerdi' al lunedi': quattro giorni, e sempre quei quattro.
  it('parte dal Black Friday e chiude al Cyber Monday', () => {
    expect(bfcmRange(2025)).toEqual({ from: '2025-11-28', to: '2025-12-01' });
    expect(bfcmRange(2024)).toEqual({ from: '2024-11-29', to: '2024-12-02' });
    expect(bfcmRange(2026)).toEqual({ from: '2026-11-27', to: '2026-11-30' });
  });

  it('sono sempre quattro giorni, anche a cavallo di dicembre', () => {
    expect(lengthInDays(bfcmRange(2025))).toBe(4);
    expect(lengthInDays(bfcmRange(2026))).toBe(4);
  });

  // Il caso che smonta il conto ingenuo: novembre 2029 comincia di giovedi', e
  // "il 29 meno qualcosa" darebbe il giovedi' sbagliato. Il quarto giovedi' e'
  // il 22, quindi il Black Friday e' il 23.
  it('un novembre che comincia di giovedi non sposta la festa', () => {
    expect(bfcmRange(2029)).toEqual({ from: '2029-11-23', to: '2029-11-26' });
  });
});

describe('quarterRange', () => {
  it('un trimestre concluso vale per intero', () => {
    expect(quarterRange(2026, 2, NOW)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
  });

  // Il trimestre in corso finisce oggi: darlo per chiuso il 30 settembre
  // farebbe leggere come magro un trimestre solo cominciato.
  it('il trimestre in corso finisce oggi, non alla sua fine', () => {
    expect(quarterRange(2026, 3, NOW)).toEqual({ from: '2026-07-01', to: '2026-08-25' });
  });

  it('un trimestre non ancora cominciato non esiste', () => {
    expect(quarterRange(2026, 4, NOW)).toBeNull();
  });
});

describe('presetGroups', () => {
  const keys = (id: string, now: Date) =>
    presetGroups(now)
      .find((group) => group.id === id)!
      .leaves.map(leafKey);

  it('i quattro gruppi ci sono sempre, nell ordine in cui si leggono', () => {
    expect(presetGroups(NOW).map((group) => group.id)).toEqual([
      'last',
      'periodToDate',
      'bfcm',
      'quarters',
    ]);
  });

  // Ad agosto il Black Friday di quest'anno deve ancora arrivare: offrirlo
  // vorrebbe dire proporre un periodo che finisce nel futuro, cioe' card vuote.
  it('il Black Friday compare solo quando e passato', () => {
    expect(keys('bfcm', NOW)).toEqual(['bfcm:2025', 'bfcm:2024', 'bfcm:2023']);
    const december = new Date('2026-12-15T00:00:00Z');
    expect(keys('bfcm', december)).toEqual(['bfcm:2026', 'bfcm:2025', 'bfcm:2024']);
  });

  it('i trimestri sono gli ultimi quattro gia cominciati', () => {
    expect(keys('quarters', NOW)).toEqual([
      'quarter:2026-3',
      'quarter:2026-2',
      'quarter:2026-1',
      'quarter:2025-4',
    ]);
  });

  // A gennaio si arretra nell'anno prima da soli: e' anche il motivo per cui
  // l'anno va scritto accanto al trimestre.
  it('a gennaio tre trimestri su quattro sono dell anno prima', () => {
    expect(keys('quarters', new Date('2026-01-15T00:00:00Z'))).toEqual([
      'quarter:2026-1',
      'quarter:2025-4',
      'quarter:2025-3',
      'quarter:2025-2',
    ]);
  });

  it('ogni voce offerta sa dire il suo intervallo', () => {
    for (const group of presetGroups(NOW)) {
      for (const leaf of group.leaves) {
        expect(leafRange(leaf, NOW)).not.toBeNull();
      }
    }
  });
});

describe('matchLeaf', () => {
  it('riconosce un periodo che ha un nome', () => {
    expect(matchLeaf({ from: '2026-08-19', to: '2026-08-25' }, NOW)).toEqual({
      kind: 'preset',
      preset: 'last7',
    });
  });

  it('riconosce un Black Friday', () => {
    expect(matchLeaf(bfcmRange(2025), NOW)).toEqual({ kind: 'bfcm', year: 2025 });
  });

  it('due date qualsiasi non sono nessuna voce', () => {
    expect(matchLeaf({ from: '2026-03-03', to: '2026-04-04' }, NOW)).toBeNull();
  });

  // Quando due voci coprono le stesse date vince quella senza anno: dal primo
  // luglio a oggi e' insieme "da inizio trimestre" e "il trimestre in corso", e
  // la prima e' l'intenzione piu' comune.
  it('a parita di date vince la voce senza anno', () => {
    expect(matchLeaf({ from: '2026-07-01', to: '2026-08-25' }, NOW)).toEqual({
      kind: 'preset',
      preset: 'quarterToDate',
    });
  });
});

describe('groupOfLeaf', () => {
  it('dice in quale capofila sta una voce', () => {
    expect(groupOfLeaf({ kind: 'preset', preset: 'last30' }, NOW)).toBe('last');
    expect(groupOfLeaf({ kind: 'bfcm', year: 2025 }, NOW)).toBe('bfcm');
    expect(groupOfLeaf({ kind: 'quarter', year: 2026, quarter: 2 }, NOW)).toBe('quarters');
  });

  // Oggi e ieri stanno in cima da sole: non hanno un capofila da riaprire, e
  // infatti non ne dichiarano nessuno.
  it('le due voci in cima non stanno in nessun gruppo', () => {
    for (const leaf of HEAD_LEAVES) {
      expect(groupOfLeaf(leaf, NOW)).toBeNull();
    }
  });
});

describe('leafKey', () => {
  it('voci uguali danno la stessa chiave, voci diverse no', () => {
    expect(leafKey({ kind: 'quarter', year: 2026, quarter: 2 })).toBe(
      leafKey({ kind: 'quarter', year: 2026, quarter: 2 }),
    );
    expect(leafKey({ kind: 'quarter', year: 2026, quarter: 2 })).not.toBe(
      leafKey({ kind: 'quarter', year: 2025, quarter: 2 }),
    );
    expect(leafKey({ kind: 'bfcm', year: 2025 })).not.toBe(
      leafKey({ kind: 'preset', preset: 'last7' }),
    );
  });
});

describe('formatDay e formatDayNumeric', () => {
  it('la data per esteso e quella in cifre parlano la lingua giusta', () => {
    expect(formatDay('2026-08-01', 'it')).toBe('1 agosto 2026');
    expect(formatDayNumeric('2026-08-01', 'it')).toBe('01/08/2026');
    // In inglese il mese viene prima: e' proprio il motivo per cui il campo non
    // puo' mostrare una forma sola per tutti.
    expect(formatDayNumeric('2026-08-01', 'en')).toBe('08/01/2026');
  });
});

describe('dayPlaceholder', () => {
  const it_ = { day: 'GG', month: 'MM', year: 'AAAA' };
  const en_ = { day: 'DD', month: 'MM', year: 'YYYY' };

  it('annuncia la forma che la lingua usa davvero', () => {
    expect(dayPlaceholder('it', it_)).toBe('GG/MM/AAAA');
    expect(dayPlaceholder('en', en_)).toBe('MM/DD/YYYY');
  });

  // Il segnaposto non puo' promettere un ordine e il campo accettarne un altro:
  // vengono dalla stessa lettura di Intl, quindi si controllano a vicenda.
  it('il segnaposto e cio che il campo legge sono d accordo', () => {
    for (const [locale, parts] of [
      ['it', it_],
      ['en', en_],
    ] as const) {
      const shape = dayPlaceholder(locale, parts);
      const written = formatDayNumeric('2026-08-01', locale);
      expect(shape.replace(/[A-Z]+/g, '#')).toBe(written.replace(/\d+/g, '#'));
      expect(parseDay(written, locale)).toBe('2026-08-01');
    }
  });
});

describe('parseDay', () => {
  it('legge la data nell ordine della lingua', () => {
    expect(parseDay('01/08/2026', 'it')).toBe('2026-08-01');
    // Gli stessi tre numeri, in inglese, sono l 8 gennaio.
    expect(parseDay('01/08/2026', 'en')).toBe('2026-01-08');
  });

  it('accetta anche AAAA-MM-GG, che nessuno confonde', () => {
    expect(parseDay('2026-08-01', 'it')).toBe('2026-08-01');
    expect(parseDay('2026-08-01', 'en')).toBe('2026-08-01');
  });

  it('qualunque segno separa i numeri, e due cifre d anno bastano', () => {
    expect(parseDay('1.8.26', 'it')).toBe('2026-08-01');
    expect(parseDay('1 8 2026', 'it')).toBe('2026-08-01');
    expect(parseDay('  01-08-2026  ', 'it')).toBe('2026-08-01');
  });

  // Il 31 febbraio non e' un refuso da correggere in silenzio: new Date lo
  // sposterebbe al 3 marzo, e il periodo partirebbe da un giorno che nessuno ha
  // chiesto.
  it('una data che non esiste non viene inventata', () => {
    expect(parseDay('31/02/2026', 'it')).toBeNull();
    expect(parseDay('32/01/2026', 'it')).toBeNull();
    expect(parseDay('01/13/2026', 'it')).toBeNull();
  });

  it('quello che non e una data resta niente', () => {
    expect(parseDay('ciao', 'it')).toBeNull();
    expect(parseDay('01/08', 'it')).toBeNull();
    expect(parseDay('', 'it')).toBeNull();
  });
});
