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

/**
 * L'etichetta della riga "Prossima", che c'e' sempre finche' una prossima corsa
 * si sa.
 *
 * `formatCountdown` restituisce null quando il momento e' passato, ed e'
 * giusto: un'attesa negativa non si scrive. Ma chi la chiamava faceva sparire
 * la riga intera, e quel caso non e' raro — e' la norma. `nextSyncAt` per una
 * corsa gia' scaduta restituisce ADESSO, cioe' l'istante in cui il server ha
 * preparato la pagina: quando quella pagina arriva al browser e viene disegnata
 * quell'istante e' gia' passato, sempre, anche solo per il tempo del viaggio.
 * Risultato: la card mostrava due righe invece di tre, e ricaricando tornavano
 * tre perche' nel frattempo la corsa era avvenuta.
 *
 * Una riga che compare e scompare da sola e' peggio di un'attesa imprecisa:
 * chi guarda non impara mai dove sta quel dato. Quindi quando il momento e'
 * passato non si toglie niente, si dice che la corsa e' imminente — che e'
 * anche la verita': era in ritardo, e parte al primo passaggio utile.
 *
 * Resta null solo quando una prossima corsa davvero non si sa: nessuna corsa
 * precedente da cui contare, o nessuna cadenza. Li' la riga non c'e' proprio,
 * e non e' un'assenza intermittente.
 */
export function syncCountdownLabel(
  nextSync: string | Date | null,
  now: Date,
  t: Pick<Dictionary, 'sync'>,
): string | null {
  if (nextSync == null) return null;

  const at = nextSync instanceof Date ? nextSync : new Date(nextSync);
  if (Number.isNaN(at.getTime())) return null;

  const countdown = formatCountdown(now, at, t);
  return countdown ? t.sync.inLabel(countdown) : t.sync.imminent;
}
