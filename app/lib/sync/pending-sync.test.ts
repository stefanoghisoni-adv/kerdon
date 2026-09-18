import { describe, it, expect } from 'vitest';
import {
  PENDING_SYNC_HORIZON_MS,
  PENDING_SYNC_REQUEST_FILTER,
  PENDING_SYNC_REQUEST_STATUSES,
  PENDING_SYNC_REQUEST_TYPES,
  STALE_RUNNING_JOB_MS,
  pendingSyncSince,
  syncRequestIsInFlight,
  type PendingSyncRequest,
} from './pending-sync';
import { LEASE_TTL_MS, MAX_ATTEMPTS, backoffDelayMs } from '~/lib/queue/queue-model';

const ADESSO = new Date('2026-03-10T10:00:00.000Z');
const fra = (ms: number) => new Date(ADESSO.getTime() + ms);

function richiesta(over: Partial<PendingSyncRequest> = {}): PendingSyncRequest {
  return {
    status: 'queued',
    nextAttemptAt: ADESSO,
    leaseExpiresAt: null,
    createdAt: ADESSO,
    ...over,
  };
}

describe('syncRequestIsInFlight', () => {
  it('una richiesta appena accodata e in volo, anche senza nessuna riga in sync_job', () => {
    // E' IL CASO DA CUI E' PARTITO TUTTO. Fra il clic e la partenza del lavoro
    // in `sync_job` non c'e' niente da guardare: la dashboard si affidava a un
    // `useState` con l'ora del clic, e quel ricordo moriva cambiando scheda.
    // Qui la risposta viene dalla riga della coda, che nessuna navigazione puo'
    // cancellare.
    expect(syncRequestIsInFlight(richiesta(), ADESSO)).toBe(true);
  });

  it('qualcuno la sta lavorando finche la presa e viva', () => {
    // Il battito rinnova la presa per tutta la durata della corsa: questo ramo
    // copre l'intera sincronizzazione senza che nessuno debba indovinare quanto
    // dura.
    const presa = richiesta({ status: 'processing', leaseExpiresAt: fra(LEASE_TTL_MS / 2) });
    expect(syncRequestIsInFlight(presa, ADESSO)).toBe(true);
  });

  it('una presa scaduta non e nessuno che lavora', () => {
    // Un'invocazione morta a meta'. La coda la riprendera', ma fino ad allora
    // non c'e' niente in corso da annunciare — ed e' cosi' che il pulsante
    // torna premibile entro un minuto invece di restare spento per sempre.
    const morta = richiesta({ status: 'processing', leaseExpiresAt: fra(-1) });
    expect(syncRequestIsInFlight(morta, ADESSO)).toBe(false);
  });

  it('un tentativo fallito che sta per essere rifatto e ancora la stessa corsa', () => {
    // Il primo backoff sta fra i trenta secondi e il minuto. Spegnere l'avviso
    // li' e riaccenderlo subito dopo racconterebbe due corse dove ce n'e' una.
    const primoBackoff = backoffDelayMs(1, () => 1);
    expect(primoBackoff).toBeLessThan(PENDING_SYNC_HORIZON_MS);
    const riprova = richiesta({ nextAttemptAt: fra(primoBackoff) });
    expect(syncRequestIsInFlight(riprova, ADESSO)).toBe(true);
  });

  it('dopo che si insiste da un pezzo il pulsante torna al merchant', () => {
    // Backoff cresciuto oltre l'orizzonte: la coda continuera' per conto suo,
    // ma tenere il merchant davanti a una rotellina per mezz'ora sarebbe
    // prendersi la sua attesa senza dargli niente in cambio.
    const backoffLungo = backoffDelayMs(4, () => 1);
    expect(backoffLungo).toBeGreaterThan(PENDING_SYNC_HORIZON_MS);
    const lontana = richiesta({ nextAttemptAt: fra(backoffLungo) });
    expect(syncRequestIsInFlight(lontana, ADESSO)).toBe(false);
  });

  it('se il drenaggio non arriva, l attesa non dura per sempre', () => {
    // Innesco fallito, cron fermo: la richiesta resta pronta e nessuno la
    // prende. E' lo stesso caso che prima copriva la scadenza nel browser, ora
    // misurato sulla riga invece che sull'orologio di chi guarda.
    const abbandonata = richiesta({ nextAttemptAt: fra(-PENDING_SYNC_HORIZON_MS - 1) });
    expect(syncRequestIsInFlight(abbandonata, ADESSO)).toBe(false);
  });

  it('la lettera morta e uno stato finito: il pulsante torna premibile', () => {
    // E' lo stato in cui la coda smette di riprovare da sola. Aspettarla
    // sarebbe aspettare per sempre, ed e' esattamente lo stato che non deve
    // esistere.
    expect(syncRequestIsInFlight(richiesta({ status: 'dead_letter' }), ADESSO)).toBe(false);
    expect(syncRequestIsInFlight(richiesta({ status: 'completed' }), ADESSO)).toBe(false);
  });
});

describe('pendingSyncSince', () => {
  it('senza richieste e senza corse, non c e niente in volo', () => {
    expect(pendingSyncSince({ requests: [], now: ADESSO })).toBeNull();
  });

  it('restituisce quando il lavoro e stato CHIESTO, non quando e partito', () => {
    // E' la data che la card mostra accanto alla riga "in corso": l'attesa del
    // merchant comincia al clic, non quando la coda si degna di partire.
    const chiesta = fra(-90_000);
    const since = pendingSyncSince({
      requests: [
        richiesta({
          status: 'processing',
          leaseExpiresAt: fra(LEASE_TTL_MS),
          createdAt: chiesta,
        }),
      ],
      runningJobStartedAt: fra(-10_000),
      now: ADESSO,
    });
    expect(since?.toISOString()).toBe(chiesta.toISOString());
  });

  it('una corsa gia partita tiene su l avviso anche se la coda risulta chiusa', () => {
    // Le due letture avvengono in istanti diversi: una riga chiusa un attimo
    // prima non deve poter spegnere l'avviso sopra una corsa che sta ancora
    // scrivendo nel database del merchant.
    const partita = fra(-30_000);
    const since = pendingSyncSince({
      requests: [],
      runningJobStartedAt: partita,
      now: ADESSO,
    });
    expect(since?.toISOString()).toBe(partita.toISOString());
  });

  it('una corsa rimasta appesa su running non tiene spento il pulsante per sempre', () => {
    // Oltre il tetto di durata il drenaggio avrebbe gia' interrotto il lavoro e
    // riscritto la riga: se dice ancora 'running' e' un'invocazione stroncata
    // dalla piattaforma, e nessuno la sta piu' eseguendo.
    const appesa = fra(-STALE_RUNNING_JOB_MS - 1);
    expect(pendingSyncSince({ requests: [], runningJobStartedAt: appesa, now: ADESSO })).toBeNull();
  });

  it('dopo l ultimo tentativo il lavoro e finito e l attesa finisce con lui', () => {
    // La corsa del merchant che ha premuto il pulsante e fallita fino in fondo:
    // la coda si e' arresa, e l'avviso deve arrendersi con lei invece di
    // lasciare il pulsante spento.
    const esaurita = richiesta({ status: 'dead_letter', createdAt: fra(-600_000) });
    expect(MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(pendingSyncSince({ requests: [esaurita], now: ADESSO })).toBeNull();
  });

  it('con piu richieste in volo vale la piu antica', () => {
    const vecchia = fra(-120_000);
    const since = pendingSyncSince({
      requests: [
        richiesta({ createdAt: fra(-10_000) }),
        richiesta({ createdAt: vecchia }),
      ],
      now: ADESSO,
    });
    expect(since?.toISOString()).toBe(vecchia.toISOString());
  });

  it('le richieste gia chiuse non contano nemmeno se sono le sole', () => {
    const chiuse = [richiesta({ status: 'completed' }), richiesta({ status: 'dead_letter' })];
    expect(pendingSyncSince({ requests: chiuse, now: ADESSO })).toBeNull();
  });
});

describe('PENDING_SYNC_REQUEST_FILTER', () => {
  it('il filtro per il database dice le stesse cose della regola', () => {
    // Sta accanto alla regola apposta: due scritture della stessa condizione si
    // disallineano al primo cambiamento, e la seconda e' quella che nessuno
    // guarda.
    expect(PENDING_SYNC_REQUEST_FILTER.type.in).toEqual([...PENDING_SYNC_REQUEST_TYPES]);
    expect(PENDING_SYNC_REQUEST_FILTER.status.in).toEqual([...PENDING_SYNC_REQUEST_STATUSES]);
  });

  it('non chiede al database righe gia concluse', () => {
    expect(PENDING_SYNC_REQUEST_FILTER.status.in).not.toContain('completed');
    expect(PENDING_SYNC_REQUEST_FILTER.status.in).not.toContain('dead_letter');
  });

  it('i controlli periodici non accendono l avviso della sincronizzazione manuale', () => {
    // Sono lavoro automatico che il merchant non ha chiesto: spegnergli il
    // pulsante e dirgli "stiamo eseguendo la sincronizzazione manuale" gli
    // attribuirebbe un gesto che non ha fatto.
    expect(PENDING_SYNC_REQUEST_FILTER.type.in).not.toContain('periodic-sync-check');
    expect(PENDING_SYNC_REQUEST_FILTER.type.in).not.toContain('compliance-request');
  });
});
