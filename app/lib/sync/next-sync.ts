import type { Dictionary } from '~/lib/i18n/context';

/**
 * Quando ripartira' la sincronizzazione periodica.
 *
 * Ultima corsa piu' l'intervallo del piano, e basta.
 *
 * Prima si aggiungeva un secondo vincolo: il cron non gira di continuo, gira a
 * un'ora fissa, quindi la corsa "scaduta" alle 04:00 partiva al passaggio utile
 * successivo e il conto lo diceva. Era vero e si leggeva come un errore —
 * "ogni 2 giorni" sopra, "tra 3 giorni" sotto, nella stessa card. Un'attesa non
 * puo' superare la cadenza che le sta scritta accanto: chi legge crede al
 * numero piu' piccolo, e trova sbagliato l'altro.
 *
 * Resta vero che il cron passa a ore fisse, e resta il motivo per cui questa
 * data e' una previsione e non un appuntamento.
 */

/**
 * Istante della prossima sincronizzazione, o `null` se non e' prevedibile
 * (nessuna corsa precedente: parte al primo giro utile e non c'e' un'attesa da
 * annunciare).
 */
export function nextSyncAt(
  lastCompletedAt: Date | null,
  intervalHours: number | null,
  now: Date,
): Date | null {
  if (lastCompletedAt == null || intervalHours == null || !(intervalHours > 0)) {
    return null;
  }

  const dueAt = new Date(lastCompletedAt.getTime() + intervalHours * 3600 * 1000);
  // Gia' scaduta: parte al primo passaggio utile, che puo' essere adesso.
  return dueAt.getTime() > now.getTime() ? dueAt : now;
}

/**
 * "2 giorni", "3 ore", "un minuto": quanto manca, in italiano.
 *
 * Una sola unita', la piu' grande che abbia senso: "1 giorno e 4 ore" e' piu'
 * preciso ma nessuno lo legge per decidere qualcosa, e la precisione qui e'
 * finta — dipende da quando passa il cron.
 */
export function formatCountdown(
  from: Date,
  to: Date,
  t: Pick<Dictionary, 'sync'>,
): string | null {
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return null;

  const minutes = Math.round(ms / 60000);
  if (minutes < 60) {
    return minutes <= 1 ? t.sync.countdown.oneMinute : t.sync.countdown.minutes(minutes);
  }

  if (minutes < 24 * 60) {
    // Ore E minuti, non ore arrotondate. `Math.round(minutes / 60)` faceva
    // diventare "2 ore" un'ora e mezza: un'attesa raccontata con quasi un'ora
    // di scarto, ed e' proprio il tempo in cui i numeri del merchant restano
    // fermi. Sotto il giorno quello scarto pesa; sopra, no.
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (m === 0) return h === 1 ? t.sync.countdown.oneHour : t.sync.countdown.hours(h);
    return t.sync.countdown.hoursMinutes(h, m);
  }

  const days = Math.round(minutes / (24 * 60));
  return days === 1 ? t.sync.countdown.oneDay : t.sync.countdown.days(days);
}
