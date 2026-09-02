import { describe, it, expect } from 'vitest';
import { nextSyncAt, formatCountdown, syncCountdownLabel } from './next-sync';
// Alias: `it` e' anche il nome del caso di test in vitest.
import { it as itDict } from '~/lib/i18n/it';

const at = (iso: string) => new Date(iso);

describe('nextSyncAt', () => {
  it("somma l'intervallo del piano all'ultima corsa, e nient'altro", () => {
    const next = nextSyncAt(at('2026-08-01T04:00:00Z'), 24, at('2026-08-01T12:00:00Z'));
    expect(next?.toISOString()).toBe('2026-08-02T04:00:00.000Z');
  });

  it("l'attesa non supera mai la cadenza scritta accanto", () => {
    // "Ogni 2 giorni" sopra e "tra 3 giorni" sotto, nella stessa card, si legge
    // come un errore anche quando e' vero: chi legge crede al numero piu'
    // piccolo e trova sbagliato l'altro.
    const interval = 48;
    const next = nextSyncAt(at('2026-08-01T11:20:00Z'), interval, at('2026-08-01T12:00:00Z'))!;
    const waitHours = (next.getTime() - at('2026-08-01T12:00:00Z').getTime()) / 3_600_000;
    expect(waitHours).toBeLessThanOrEqual(interval);
  });

  it('gia scaduta: adesso, non una data nel passato', () => {
    const now = at('2026-08-05T10:00:00Z');
    expect(nextSyncAt(at('2026-07-01T03:00:00Z'), 24, now)?.toISOString()).toBe(
      now.toISOString(),
    );
  });

  it('senza una corsa precedente non si promette niente', () => {
    // Parte al primo giro utile: non c'e' un'attesa da annunciare, e inventarne
    // una sarebbe peggio del silenzio.
    expect(nextSyncAt(null, 24, at('2026-08-05T10:00:00Z'))).toBeNull();
  });

  it('senza intervallo non si promette niente', () => {
    expect(nextSyncAt(at('2026-08-01T03:00:00Z'), null, at('2026-08-05T10:00:00Z'))).toBeNull();
    expect(nextSyncAt(at('2026-08-01T03:00:00Z'), 0, at('2026-08-05T10:00:00Z'))).toBeNull();
  });

  it('regge l intervallo settimanale del piano Free', () => {
    // 168 ore = 7 giorni.
    const next = nextSyncAt(at('2026-08-01T03:00:00Z'), 168, at('2026-08-02T10:00:00Z'));
    expect(next?.toISOString()).toBe('2026-08-08T03:00:00.000Z');
  });
});

describe('formatCountdown', () => {
  it('sceglie una sola unita, la piu grande che abbia senso', () => {
    expect(formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-08T00:00:00Z'), itDict)).toBe('7 giorni');
    expect(formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-02T00:00:00Z'), itDict)).toBe('un giorno');
    expect(formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-01T05:00:00Z'), itDict)).toBe('5 ore');
    expect(formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-01T01:00:00Z'), itDict)).toBe("un'ora");
    expect(formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-01T00:30:00Z'), itDict)).toBe('30 minuti');
    expect(formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-01T00:01:00Z'), itDict)).toBe('un minuto');
  });

  it('niente da dire se e gia passata', () => {
    expect(formatCountdown(at('2026-08-02T00:00:00Z'), at('2026-08-01T00:00:00Z'), itDict)).toBeNull();
    expect(formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-01T00:00:00Z'), itDict)).toBeNull();
  });
});

describe('sotto il giorno si scrivono anche i minuti', () => {
  it('ore e minuti insieme, non ore arrotondate', () => {
    // "2 ore" per un'ora e mezza sbaglia di trenta minuti, e sono i minuti in
    // cui i numeri del merchant restano fermi.
    expect(
      formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-01T01:30:00Z'), itDict),
    ).toBe('1h 30min');
    expect(
      formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-01T03:50:00Z'), itDict),
    ).toBe('3h 50min');
  });

  it('quando i minuti sono zero resta la sola ora', () => {
    // "2h 0min" e' un modo goffo di dire "2 ore".
    expect(
      formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-01T02:00:00Z'), itDict),
    ).toBe('2 ore');
  });

  it('sopra il giorno i minuti non servono piu', () => {
    // A quella distanza mezz'ora non cambia niente di quello che si fa.
    expect(
      formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-03T04:30:00Z'), itDict),
    ).toBe('2 giorni');
  });

  it('poco sotto le 24 ore resta un conto in ore, non "un giorno"', () => {
    expect(
      formatCountdown(at('2026-08-01T00:00:00Z'), at('2026-08-01T23:45:00Z'), itDict),
    ).toBe('23h 45min');
  });
});

// La riga "Prossima" spariva dalla card, e ricaricando tornava. Non era un caso
// raro: per una corsa in ritardo la previsione E' l'istante in cui il server
// prepara la pagina, quindi al momento di disegnarla e' sempre gia' passato.
describe('syncCountdownLabel', () => {
  it('un momento nel futuro: quanto manca', () => {
    const label = syncCountdownLabel(
      '2026-08-01T14:00:00Z',
      at('2026-08-01T12:00:00Z'),
      itDict,
    );
    expect(label).toBe('Tra 2 ore');
  });

  it('un momento gia passato: la riga resta, e dice che e imminente', () => {
    const label = syncCountdownLabel(
      '2026-08-01T12:00:00Z',
      at('2026-08-01T12:00:03Z'),
      itDict,
    );
    expect(label).toBe('A breve');
  });

  it('lo stesso istante — il caso di una corsa in ritardo — non fa sparire niente', () => {
    const stesso = '2026-08-01T12:00:00Z';
    expect(syncCountdownLabel(stesso, at(stesso), itDict)).toBe('A breve');
  });

  it('nessuna prossima corsa prevista: nessuna riga, e stabilmente', () => {
    expect(syncCountdownLabel(null, at('2026-08-01T12:00:00Z'), itDict)).toBeNull();
  });

  it('una data illeggibile vale come assente, non come un errore', () => {
    expect(syncCountdownLabel('non-una-data', at('2026-08-01T12:00:00Z'), itDict)).toBeNull();
  });
});
