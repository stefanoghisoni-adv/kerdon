import { describe, it, expect } from 'vitest';
import { nextSyncAt, formatCountdown } from './next-sync';
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
