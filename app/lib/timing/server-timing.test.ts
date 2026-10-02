import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerTiming } from './server-timing';

afterEach(() => {
  vi.useRealTimers();
});

describe('ServerTiming', () => {
  it('misura le fasi e le scrive nel formato che il browser legge', async () => {
    vi.useFakeTimers();
    const timing = new ServerTiming();

    await timing.measure('auth', async () => {
      vi.advanceTimersByTime(120);
    });
    timing.record('plan', 8.4);

    expect(timing.header()).toBe('auth;dur=120, plan;dur=8.4');
  });

  it('registra la fase anche quando fallisce, e lascia passare l\'errore', async () => {
    const timing = new ServerTiming();

    await expect(
      timing.measure('report', async () => {
        throw new Error('rotto');
      }),
    ).rejects.toThrow('rotto');

    expect(timing.header()).toMatch(/^report;dur=\d/);
  });

  it('il riepilogo per i log elenca le fasi in ordine', () => {
    const timing = new ServerTiming();
    timing.record('token', 40);
    timing.record('report', 310.26);

    expect(timing.summary()).toBe('token=40ms report=310.3ms');
  });

  it('senza fasi non scrive niente', () => {
    expect(new ServerTiming().header()).toBe('');
  });
});
