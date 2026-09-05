import { describe, it, expect } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DEDUP_WINDOW_MS,
  LEASE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_RUN_MS,
  SYNC_REQUEST_TYPES,
  backoffDelayMs,
  dedupKeyFor,
  holdsLease,
  isClaimable,
  isExhausted,
  isSyncRequestType,
  naturalDedupKey,
  nextAttemptAfterFailure,
  redactError,
  type SyncRequestRow,
} from './queue-model';

/**
 * Le regole della coda, provate dove non serve un database.
 *
 * Sono la parte che il SQL implementa e il consumatore applica: se sbagliano
 * qui, sbagliano in tutti e due i posti insieme. Le prove che contano di piu'
 * sono quelle sull'attesa (un fallimento non deve cancellare il lavoro, deve
 * distanziarlo) e sul possesso (chi non ha il gettone giusto non scrive).
 */

const ADESSO = new Date('2026-09-05T10:00:00.000Z');

function riga(over: Partial<SyncRequestRow> = {}): SyncRequestRow {
  return {
    id: 'item-1',
    shopId: 'shop-1',
    type: 'manual-sync',
    payload: null,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: ADESSO,
    leaseOwner: null,
    leaseExpiresAt: null,
    fencingToken: 0,
    ...over,
  };
}

describe('i tipi ammessi', () => {
  it('riconosce quelli in elenco', () => {
    for (const tipo of SYNC_REQUEST_TYPES) expect(isSyncRequestType(tipo)).toBe(true);
  });

  /**
   * Il caso da cui e' partito tutto: il drenaggio vecchio, davanti a un tipo che
   * non conosceva, faceva `continue` e lasciava l'item in attesa per sempre.
   * Riconoscerlo per quello che e' — sconosciuto — e' il primo passo per poterlo
   * rifiutare invece di accumularlo.
   */
  it('non riconosce quelli che non ci sono', () => {
    expect(isSyncRequestType('retry-failed-webhook')).toBe(false);
    expect(isSyncRequestType('')).toBe(false);
    expect(isSyncRequestType(undefined)).toBe(false);
    expect(isSyncRequestType({ type: 'manual-sync' })).toBe(false);
  });

  it('ha un tetto di durata per ognuno, sotto quello di una funzione su Vercel', () => {
    for (const tipo of SYNC_REQUEST_TYPES) {
      expect(MAX_RUN_MS[tipo]).toBeGreaterThan(0);
      // Cinque minuti e' il tetto della piattaforma: al tetto la corrente la
      // stacca lei, a meta' di una scrittura.
      expect(MAX_RUN_MS[tipo]).toBeLessThan(300_000);
    }
  });
});

describe('isClaimable', () => {
  it('prende un item pronto', () => {
    expect(isClaimable(riga(), ADESSO)).toBe(true);
  });

  it('non prende un item la cui attesa non e\' finita', () => {
    const fra1min = new Date(ADESSO.getTime() + 60_000);
    expect(isClaimable(riga({ nextAttemptAt: fra1min }), ADESSO)).toBe(false);
  });

  /**
   * Il caso che rende la coda viva. Un item 'processing' il cui lease e'
   * scaduto e' un'invocazione morta a meta' — su una funzione serverless
   * succede, per timeout o per deploy — e senza riprenderlo un solo incidente
   * fermerebbe quel negozio per sempre.
   */
  it('riprende un item il cui possesso e\' scaduto', () => {
    const scaduto = riga({
      status: 'processing',
      leaseOwner: 'chi-e-morto',
      leaseExpiresAt: new Date(ADESSO.getTime() - 1),
    });
    expect(isClaimable(scaduto, ADESSO)).toBe(true);
  });

  it('non ruba un item il cui possesso e\' ancora valido', () => {
    const vivo = riga({
      status: 'processing',
      leaseOwner: 'chi-sta-lavorando',
      leaseExpiresAt: new Date(ADESSO.getTime() + LEASE_TTL_MS),
    });
    expect(isClaimable(vivo, ADESSO)).toBe(false);
  });

  it('non riprende quello che e\' finito, ne\' quello in lettera morta', () => {
    expect(isClaimable(riga({ status: 'completed' }), ADESSO)).toBe(false);
    expect(isClaimable(riga({ status: 'dead_letter' }), ADESSO)).toBe(false);
  });
});

describe('holdsLease', () => {
  const preso = riga({ status: 'processing', leaseOwner: 'A', fencingToken: 7 });

  it('dice di si\' a chi ha proprietario e gettone giusti', () => {
    expect(holdsLease(preso, { id: 'item-1', owner: 'A', fencingToken: 7 })).toBe(true);
  });

  it('dice di no a un altro proprietario', () => {
    expect(holdsLease(preso, { id: 'item-1', owner: 'B', fencingToken: 7 })).toBe(false);
  });

  /**
   * Il deploy a meta' lavoro. Il processo vecchio si risveglia, e' ancora "A" —
   * stessa identita' — ma l'item nel frattempo e' stato ripreso e il gettone e'
   * salito. Senza il confronto sul gettone dichiarerebbe completato un lavoro
   * che sta facendo qualcun altro.
   */
  it('dice di no allo stesso proprietario con un gettone vecchio', () => {
    expect(holdsLease(preso, { id: 'item-1', owner: 'A', fencingToken: 6 })).toBe(false);
  });
});

describe('il backoff', () => {
  it('parte dalla base e raddoppia', () => {
    // Con jitter fisso a zero si vede la meta' garantita: l'attesa non scende
    // mai sotto quella, qualunque cosa esca dal caso.
    expect(backoffDelayMs(1, () => 0)).toBe(BACKOFF_BASE_MS / 2);
    expect(backoffDelayMs(2, () => 0)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(3, () => 0)).toBe(BACKOFF_BASE_MS * 2);
  });

  it('non supera il tetto', () => {
    expect(backoffDelayMs(50, () => 1)).toBe(BACKOFF_MAX_MS);
  });

  /**
   * Il jitter non e' un abbellimento: quando Shopify o Supabase non rispondono
   * falliscono tutti gli item insieme, e senza sparpagliamento tornerebbero
   * pronti nello stesso istante — rifacendo la stessa ondata contro un servizio
   * che si sta ancora rialzando.
   */
  it('sparpaglia i ritentativi fra la meta\' e il pieno', () => {
    const minimo = backoffDelayMs(2, () => 0);
    const massimo = backoffDelayMs(2, () => 1);
    expect(minimo).toBeLessThan(massimo);
    expect(minimo).toBe(BACKOFF_BASE_MS);
    expect(massimo).toBe(BACKOFF_BASE_MS * 2);
  });

  it('sposta il prossimo tentativo in avanti, mai indietro', () => {
    const prossimo = nextAttemptAfterFailure(1, ADESSO, () => 0);
    expect(prossimo.getTime()).toBeGreaterThan(ADESSO.getTime());
  });
});

describe('la soglia dei tentativi', () => {
  it('non si arrende prima del tetto', () => {
    expect(isExhausted(MAX_ATTEMPTS - 1)).toBe(false);
  });

  it('si arrende al tetto', () => {
    expect(isExhausted(MAX_ATTEMPTS)).toBe(true);
  });
});

describe('la deduplica', () => {
  /**
   * Due clic a distanza di un secondo sono la stessa richiesta. Era il caso
   * concreto del guasto: il pulsante accodava, e il gesto innescava anche un
   * drenaggio immediato — due corse sullo stesso negozio, con due istanti
   * d'inizio diversi, e la piu' vecchia che porta via le righe della piu'
   * recente.
   */
  it('da\' la stessa chiave a due richieste nella stessa finestra', () => {
    const primo = dedupKeyFor('manual-sync', 'shop-1', ADESSO);
    const secondo = dedupKeyFor('manual-sync', 'shop-1', new Date(ADESSO.getTime() + 1_000));
    expect(secondo).toBe(primo);
  });

  /**
   * Ma non deve fondere richieste diverse: un clic dieci minuti dopo e' una
   * richiesta nuova — il merchant ha cambiato qualcosa su Shopify e sta
   * chiedendo di rivederlo — e ignorarla sarebbe peggio che eseguirla due volte.
   */
  it('da\' chiavi diverse a due richieste in finestre diverse', () => {
    const primo = dedupKeyFor('manual-sync', 'shop-1', ADESSO);
    const dopo = dedupKeyFor('manual-sync', 'shop-1', new Date(ADESSO.getTime() + DEDUP_WINDOW_MS));
    expect(dopo).not.toBe(primo);
  });

  it('non confonde due negozi ne\' due tipi', () => {
    expect(dedupKeyFor('manual-sync', 'shop-1', ADESSO)).not.toBe(
      dedupKeyFor('manual-sync', 'shop-2', ADESSO),
    );
    expect(dedupKeyFor('manual-sync', 'shop-1', ADESSO)).not.toBe(
      dedupKeyFor('initial-bulk-sync', 'shop-1', ADESSO),
    );
  });

  it('per un lavoro senza negozio resta una chiave sola', () => {
    expect(dedupKeyFor('compliance-request', null, ADESSO)).toContain('senza-negozio');
  });

  /**
   * La chiave naturale non ha finestra di proposito: la stessa richiesta di
   * conformita' non deve produrre un secondo item nemmeno a distanza di giorni,
   * perche' vorrebbe dire una seconda esportazione dei dati di una persona.
   */
  it('la chiave naturale non dipende dal momento', () => {
    expect(naturalDedupKey('compliance-request', 'req-1')).toBe(
      naturalDedupKey('compliance-request', 'req-1'),
    );
    expect(naturalDedupKey('compliance-request', 'req-1')).not.toBe(
      naturalDedupKey('compliance-request', 'req-2'),
    );
  });
});

describe('la redazione degli errori', () => {
  /**
   * `lastError` la si legge in un log, in un pannello, in una segnalazione
   * incollata in chat. Un errore di Supabase riporta volentieri l'URL con
   * dentro la chiave; uno di PostgREST riporta il filtro della query, che sui
   * clienti e' l'email di una persona.
   */
  it('toglie le credenziali da un indirizzo', () => {
    const dentro = redactError(new Error('connect postgresql://utente:parolona@db.host:5432 fallito'));
    expect(dentro).not.toContain('parolona');
    expect(dentro).toContain('[credenziali]');
  });

  it('toglie un\'autorizzazione riportata per esteso', () => {
    const dentro = redactError(new Error('401 con Bearer shpat_0123456789abcdef0123456789abcdef'));
    expect(dentro).not.toContain('shpat_0123456789abcdef0123456789abcdef');
  });

  it('toglie una chiave nominata', () => {
    expect(redactError(new Error('apikey=abcdef12345 rifiutata'))).not.toContain('abcdef12345');
    expect(redactError(new Error('{"password":"segretissima"}'))).not.toContain('segretissima');
  });

  it('toglie un indirizzo email', () => {
    const dentro = redactError(new Error('email_address=eq.mario.rossi@example.com non trovato'));
    expect(dentro).not.toContain('mario.rossi@example.com');
    expect(dentro).toContain('[email]');
  });

  it('lascia leggibile il motivo, che e\' il punto', () => {
    expect(redactError(new Error('timeout leggendo i prodotti'))).toBe(
      'timeout leggendo i prodotti',
    );
  });

  it('accorcia i messaggi lunghissimi invece di riversarli in colonna', () => {
    expect(redactError(new Error('x'.repeat(5_000))).length).toBeLessThan(600);
  });

  it('non si rompe su qualcosa che non e\' un errore', () => {
    expect(redactError(undefined)).toBe('errore sconosciuto');
    expect(redactError('stringa nuda')).toBe('stringa nuda');
  });
});
