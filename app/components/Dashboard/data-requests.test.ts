import { describe, it, expect } from 'vitest';

/**
 * La regola di cosa e' ritirabile, provata sulla query che la esprime.
 *
 * Una copia dei dati si consegna solo se esiste ancora: la finestra e' di
 * trenta giorni e passata quella il cron la svuota. Una riga che offre un file
 * scaduto e' peggio di nessuna riga — il merchant clicca, non ottiene niente, e
 * crede che l'app sia rotta proprio nel momento in cui deve rispondere a una
 * persona entro un termine di legge.
 */
function ritirabile(r: {
  status: string;
  topic: string;
  exportExpiresAt: Date | null;
}, ora: Date): boolean {
  return (
    r.topic === 'customers/data_request' &&
    r.status === 'completed' &&
    r.exportExpiresAt !== null &&
    r.exportExpiresAt.getTime() > ora.getTime()
  );
}

const ORA = new Date('2026-09-04T12:00:00Z');
const fra = (giorni: number) => new Date(ORA.getTime() + giorni * 86_400_000);

describe('quali copie si possono ritirare', () => {
  it('completata e ancora dentro la finestra', () => {
    expect(
      ritirabile(
        { status: 'completed', topic: 'customers/data_request', exportExpiresAt: fra(10) },
        ORA,
      ),
    ).toBe(true);
  });

  it('scaduta: non si offre', () => {
    expect(
      ritirabile(
        { status: 'completed', topic: 'customers/data_request', exportExpiresAt: fra(-1) },
        ORA,
      ),
    ).toBe(false);
  });

  it('ancora in lavorazione: non c e niente da dare', () => {
    for (const status of ['queued', 'processing', 'failed', 'dead_letter']) {
      expect(
        ritirabile({ status, topic: 'customers/data_request', exportExpiresAt: fra(10) }, ORA),
      ).toBe(false);
    }
  });

  // Una cancellazione non ha un contenuto da consegnare: ha un esito. Offrire
  // un file per quella vorrebbe dire promettere qualcosa che non esiste.
  it('le cancellazioni non si scaricano', () => {
    for (const topic of ['customers/redact', 'shop/redact']) {
      expect(
        ritirabile({ status: 'completed', topic, exportExpiresAt: fra(10) }, ORA),
      ).toBe(false);
    }
  });

  it('senza scadenza registrata la copia non c e piu', () => {
    expect(
      ritirabile(
        { status: 'completed', topic: 'customers/data_request', exportExpiresAt: null },
        ORA,
      ),
    ).toBe(false);
  });
});
