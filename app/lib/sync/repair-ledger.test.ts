import { describe, it, expect } from 'vitest';
import {
  MAX_REPAIRS_PER_RUN,
  MAX_REPAIR_ATTEMPTS,
  createRepairLedger,
  nextRepairAttemptAt,
  planRepairCommit,
  repairKeyOf,
  watermarkHoldBack,
  type OpenRepair,
  type RepairDraft,
} from './repair-ledger';

const ORA = new Date('2026-03-01T10:00:00Z');
const PARTENZA = new Date('2026-03-01T08:00:00Z');

function draft(over: Partial<RepairDraft> = {}): RepairDraft {
  return {
    resourceType: 'product',
    resourceId: '1',
    operation: 'upsert',
    sourceUpdatedAt: new Date('2026-03-01T09:30:00Z'),
    reason: 'scrittura rifiutata',
    recoveredByDelta: true,
    ...over,
  };
}

function aperta(over: Partial<OpenRepair> = {}): OpenRepair {
  return {
    id: 'r1',
    resourceType: 'product',
    resourceId: '1',
    operation: 'upsert',
    sourceUpdatedAt: new Date('2026-03-01T09:30:00Z'),
    attempts: 1,
    nextAttemptAt: ORA,
    recoveredByDelta: true,
    ...over,
  };
}

describe('il registro delle riparazioni di una corsa', () => {
  it('fonde due segnalazioni sulla stessa risorsa invece di duplicarle', () => {
    const registro = createRepairLedger();
    registro.open(draft({ details: { ids: [101, 102] } }));
    registro.open(draft({ details: { ids: [102, 103] } }));

    const aperte = registro.drafts();
    expect(aperte).toHaveLength(1);
    // Gli id si uniscono senza doppioni: due pagine possono nominare la stessa
    // riga, e perderne una vorrebbe dire non sapere piu' cosa e' rimasto fuori.
    expect(aperte[0].details?.ids).toEqual([101, 102, 103]);
  });

  it('una risorsa scritta bene non lascia dietro la sua segnalazione', () => {
    const registro = createRepairLedger();
    registro.open(draft());
    registro.resolve({ resourceType: 'product', resourceId: '1', operation: 'upsert' });

    expect(registro.drafts()).toHaveLength(0);
    expect(registro.resolutions().map(repairKeyOf)).toEqual(['product:1:upsert']);
  });

  it('una risorsa che fallisce dopo essere riuscita torna aperta', () => {
    // Succede davvero: il prodotto si scrive e poi la cancellazione delle sue
    // varianti orfane non riesce. Il successo non deve coprire il guasto.
    const registro = createRepairLedger();
    registro.resolve({ resourceType: 'product', resourceId: '1', operation: 'upsert' });
    registro.open(draft());

    expect(registro.drafts()).toHaveLength(1);
    expect(registro.resolutions()).toHaveLength(0);
  });

  it('oltre il tetto smette di accumulare e lo dichiara', () => {
    // Duecento risorse andate storte non sono "qualche errore": e' qualcosa di
    // sistemico, e un elenco di duecento righe da rilavorare non aiuta nessuno.
    const registro = createRepairLedger();
    for (let i = 0; i < MAX_REPAIRS_PER_RUN + 5; i++) {
      registro.open(draft({ resourceId: String(i) }));
    }

    expect(registro.overflowed).toBe(true);
    expect(registro.drafts()).toHaveLength(MAX_REPAIRS_PER_RUN);
  });
});

describe('fin dove il confine si tiene indietro', () => {
  it('si ferma alla piu\' vecchia fra le risorse da ritrovare', () => {
    const vecchia = new Date('2026-03-01T09:00:00Z');
    const trattenuto = watermarkHoldBack(
      [
        { sourceUpdatedAt: new Date('2026-03-01T09:45:00Z'), recoveredByDelta: true },
        { sourceUpdatedAt: vecchia, recoveredByDelta: true },
      ],
      PARTENZA,
    );
    expect(trattenuto).toEqual(vecchia);
  });

  it('chi non torna dal delta non trattiene niente', () => {
    // La data di nascita va VERSO Shopify: rileggere Shopify non la aggiusta, e
    // bloccare il confine per lei vorrebbe dire rileggere il catalogo a ogni
    // giro senza avvicinarsi di un passo.
    const trattenuto = watermarkHoldBack(
      [{ sourceUpdatedAt: new Date('2026-03-01T09:00:00Z'), recoveredByDelta: false }],
      PARTENZA,
    );
    expect(trattenuto).toBeNull();
  });

  it('senza data si torna al punto da cui la corsa ha letto, non al suo inizio', () => {
    // Fermarsi all'inizio della corsa non tratterrebbe niente — il confine
    // sarebbe finito li' comunque — e la risorsa verrebbe scavalcata
    // esattamente come prima.
    const trattenuto = watermarkHoldBack(
      [{ sourceUpdatedAt: null, recoveredByDelta: true }],
      PARTENZA,
    );
    expect(trattenuto).toEqual(PARTENZA);
  });

  it('senza niente aperto il confine avanza intero', () => {
    expect(watermarkHoldBack([], PARTENZA)).toBeNull();
  });
});

describe('cosa si scrive alla chiusura della corsa', () => {
  it('conta il tentativo sopra quelli gia\' fatti', () => {
    const registro = createRepairLedger();
    registro.open(draft());

    const piano = planRepairCommit({
      ledger: registro,
      existing: [aperta({ attempts: 2 })],
      deltaFloor: PARTENZA,
      now: ORA,
    });

    expect(piano.writes[0].attempts).toBe(3);
    expect(piano.writes[0].status).toBe('pending');
    expect(piano.writes[0].nextAttemptAt.getTime()).toBeGreaterThan(ORA.getTime());
  });

  it('all\'ultimo tentativo smette, e smettendo libera il confine', () => {
    // La lettera morta e' una decisione: quella risorsa non e' allineata e
    // nessuno la sta piu' rimettendo a posto. Continuare a trattenere il
    // confine per lei vorrebbe dire rileggere Shopify da quel punto per
    // sempre, senza che serva a niente. Per questo si segnala forte.
    const registro = createRepairLedger();
    registro.open(draft());

    const piano = planRepairCommit({
      ledger: registro,
      existing: [aperta({ attempts: MAX_REPAIR_ATTEMPTS - 1 })],
      deltaFloor: PARTENZA,
      now: ORA,
    });

    expect(piano.writes[0].status).toBe('dead_letter');
    expect(piano.deadLettered).toHaveLength(1);
    expect(piano.openAfter).toBe(0);
    expect(piano.holdBackTo).toBeNull();
  });

  it('una riparazione chiusa toglie il trattenimento e lo stato parziale', () => {
    const registro = createRepairLedger();
    registro.resolve({ resourceType: 'product', resourceId: '1', operation: 'upsert' });

    const piano = planRepairCommit({
      ledger: registro,
      existing: [aperta()],
      deltaFloor: PARTENZA,
      now: ORA,
    });

    expect(piano.resolvedIds).toEqual(['r1']);
    expect(piano.openAfter).toBe(0);
    expect(piano.holdBackTo).toBeNull();
  });

  it('le riparazioni di corse precedenti che nessuno ha toccato restano, e trattengono', () => {
    // Una corsa che non incontra la risorsa rimasta indietro non ha nessun
    // titolo per dichiararla a posto: il confine deve continuare ad
    // aspettarla.
    const piano = planRepairCommit({
      ledger: createRepairLedger(),
      existing: [aperta({ sourceUpdatedAt: new Date('2026-02-01T00:00:00Z') })],
      deltaFloor: PARTENZA,
      now: ORA,
    });

    expect(piano.openAfter).toBe(1);
    expect(piano.holdBackTo).toEqual(new Date('2026-02-01T00:00:00Z'));
  });

  it('l\'attesa fra un tentativo e l\'altro cresce', () => {
    const primo = nextRepairAttemptAt(1, ORA).getTime() - ORA.getTime();
    const terzo = nextRepairAttemptAt(3, ORA).getTime() - ORA.getTime();
    expect(terzo).toBeGreaterThan(primo);
  });
});
