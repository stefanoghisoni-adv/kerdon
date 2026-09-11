import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES,
  can,
  denialOf,
  evaluateShopCapabilities,
  type Capability,
  type DenialReason,
  type ShopCapabilityFacts,
} from './capabilities';

/**
 * I test della policy.
 *
 * La regola d'oro qui e' che ogni prova nomini uno stato e cio' che quello stato
 * deve NEGARE. Una policy si rompe in silenzio: se domani una condizione
 * sparisse, tutto continuerebbe a funzionare — meglio di prima, anzi, perche'
 * passerebbe piu' gente. L'unica cosa che se ne accorge e' un test che pretende
 * un rifiuto.
 */

/** Un negozio a posto: tutto acceso, cosi' ogni prova spegne una cosa sola. */
const SANO: ShopCapabilityFacts = {
  lifecycleStatus: 'active',
  uninstalledAt: null,
  authorization: 'ENABLED',
  trackingAuthorization: 'ENABLED',
  connectionVerifiedAt: new Date('2026-01-01T00:00:00Z'),
  scopes: 'read_products,read_customers,read_orders,read_all_orders',
  plan: { customersSyncEnabled: true, productFeedsEnabled: true },
};

const con = (over: Partial<ShopCapabilityFacts>): ShopCapabilityFacts => ({
  ...SANO,
  ...over,
});

/** Le capacita' concesse, in ordine, per confrontarle in blocco. */
function concesse(facts: ShopCapabilityFacts | null): Capability[] {
  const caps = evaluateShopCapabilities(facts);
  return CAPABILITIES.filter((capability) => can(caps, capability));
}

/** Il motivo del rifiuto di una capacita'. */
function motivo(
  facts: ShopCapabilityFacts | null,
  capability: Capability,
): DenialReason | null {
  return denialOf(evaluateShopCapabilities(facts), capability);
}

describe('policy — il negozio a posto', () => {
  it('concede tutto', () => {
    expect(concesse(SANO)).toEqual([...CAPABILITIES]);
  });

  it("risponde su ogni capacita' dell'elenco, senza buchi", () => {
    const caps = evaluateShopCapabilities(SANO);
    for (const capability of CAPABILITIES) {
      expect(caps[capability]).toBeDefined();
      expect(caps[capability].denial).toBeNull();
    }
  });

  it("una capacita' concessa non porta motivo", () => {
    expect(motivo(SANO, 'use_app')).toBeNull();
  });
});

describe('policy — negozio non identificato', () => {
  it("nega tutto, e il motivo e' sempre lo stesso", () => {
    for (const facts of [null, undefined]) {
      const caps = evaluateShopCapabilities(facts);
      for (const capability of CAPABILITIES) {
        expect(can(caps, capability)).toBe(false);
        expect(denialOf(caps, capability)).toBe('unknown_shop');
      }
    }
  });

  it("non fa eccezione per la lettura: e' proprio il caso in cui non si sa a chi si darebbero i dati", () => {
    expect(motivo(null, 'use_read_proxy')).toBe('unknown_shop');
  });
});

/**
 * IL MOTIVO CHE BATTE TUTTI GLI ALTRI.
 *
 * Un negozio la cui cancellazione e' cominciata non puo' fare NIENTE, nemmeno
 * le cose che a un negozio sospeso restano concesse. Prima questa condizione
 * non esisteva affatto: `shop/redact` cominciava a cancellare e nel frattempo
 * il cron sincronizzava, le notifiche di Shopify scrivevano clienti e ordini, e
 * il proxy serviva letture con la chiave di servizio ancora in cache. Ognuna di
 * quelle scritture, presa da sola, era corretta. Insieme facevano una
 * cancellazione che non cancellava.
 */
describe('policy — cancellazione del negozio in corso', () => {
  const inCancellazione = con({ lifecycleStatus: 'erasing' });

  it('nega tutto, senza eccezioni', () => {
    expect(concesse(inCancellazione)).toEqual([]);
  });

  it('lo dice con un motivo suo, su ogni capacita\'', () => {
    for (const capability of CAPABILITIES) {
      expect(motivo(inCancellazione, capability)).toBe('erasing');
    }
  });

  /**
   * La lettura e' la capacita' che sopravvive a piu' cose: un negozio con l'app
   * sospesa continua a poter leggere i dati gia' sincronizzati. Alla
   * cancellazione no — e questo e' il caso che pesa di piu', perche' il proxy e'
   * l'unica rotta pubblica e il token del merchant resta incollato nel suo
   * container anche dopo che lui se n'e' andato.
   */
  it('nega anche la lettura, che sopravvive a tutto il resto', () => {
    expect(motivo(inCancellazione, 'use_read_proxy')).toBe('erasing');
  });

  it('viene prima della disinstallazione, che e\' il motivo piu\' vicino', () => {
    // Un negozio in cancellazione e' quasi sempre anche disinstallato:
    // `shop/redact` arriva quarantotto ore dopo. Il motivo che si legge dev'essere
    // il piu' definitivo dei due.
    expect(
      motivo(con({ lifecycleStatus: 'erasing', uninstalledAt: new Date() }), 'use_app'),
    ).toBe('erasing');
  });

  it("un negozio 'active' non e\' toccato da questa regola", () => {
    expect(concesse(con({ lifecycleStatus: 'active' }))).toEqual([...CAPABILITIES]);
  });

  /**
   * In dubbio NON si nega, e qui e' l'eccezione alla regola generale della
   * policy: un valore mai visto non e' 'erasing', e trattarlo come tale
   * spegnerebbe ogni negozio la cui colonna fosse scritta male — un danno molto
   * piu' grande di quello che si eviterebbe.
   */
  it('un valore sconosciuto non spegne il negozio', () => {
    expect(concesse(con({ lifecycleStatus: 'qualcosa-di-mai-visto' }))).toEqual([
      ...CAPABILITIES,
    ]);
    expect(concesse(con({ lifecycleStatus: null }))).toEqual([...CAPABILITIES]);
  });
});

describe('policy — app disinstallata', () => {
  const disinstallato = con({ uninstalledAt: new Date('2026-02-01T00:00:00Z') });

  it("nega tutto: non c'e' piu' nessun consenso da esercitare", () => {
    expect(concesse(disinstallato)).toEqual([]);
  });

  it("nega anche la lettura, che ha un'autorizzazione sua", () => {
    // Il buco vero: il tracciamento e' indipendente dall'uso dell'app, ma non
    // dalla disinstallazione. Chi disinstalla ha tolto tutto.
    expect(motivo(disinstallato, 'use_read_proxy')).toBe('uninstalled');
  });

  it('la disinstallazione viene prima di ogni altro motivo', () => {
    // Negozio disinstallato E sospeso E scollegato E senza piano: il motivo
    // dichiarato dev'essere quello che conta, non il primo che si incontra.
    const tutto = con({
      uninstalledAt: new Date(),
      authorization: 'DISABLED',
      trackingAuthorization: 'DISABLED',
      connectionVerifiedAt: null,
      scopes: null,
      plan: null,
    });
    expect(motivo(tutto, 'sync_products')).toBe('uninstalled');
    expect(motivo(tutto, 'sync_customers')).toBe('uninstalled');
    expect(motivo(tutto, 'sync_orders')).toBe('uninstalled');
    expect(motivo(tutto, 'use_feeds')).toBe('uninstalled');
    expect(motivo(tutto, 'use_read_proxy')).toBe('uninstalled');
  });
});

describe("policy — uso dell'app sospeso", () => {
  it('PENDING (trial finito) nega uso e sincronizzazioni', () => {
    const facts = con({ authorization: 'PENDING' });
    expect(concesse(facts)).toEqual(['use_read_proxy']);
    expect(motivo(facts, 'use_app')).toBe('not_authorized');
  });

  it('DISABLED (sospeso) nega uso e sincronizzazioni', () => {
    const facts = con({ authorization: 'DISABLED' });
    expect(concesse(facts)).toEqual(['use_read_proxy']);
    expect(motivo(facts, 'sync_products')).toBe('not_authorized');
  });

  it("lascia leggere i dati gia' sincronizzati: e' un'altra autorizzazione", () => {
    // Fermi, ma utilizzabili. Spegnere l'app non spegne il tracciamento.
    expect(can(evaluateShopCapabilities(con({ authorization: 'DISABLED' })), 'use_read_proxy')).toBe(
      true,
    );
  });

  it('ma NON lascia scrivere: leggere e inerte, scrivere no', () => {
    // E' la sola riga in cui le due capacita' del tracciamento divergono, ed e'
    // la ragione per cui sono due. Continuare a scrivere mentre tutto il resto
    // e' fermo lascerebbe al merchant, alla riattivazione, dati raccolti in un
    // periodo in cui l'app per lui non esisteva.
    const sospeso = con({ authorization: 'DISABLED' });
    expect(can(evaluateShopCapabilities(sospeso), 'ingest_tracking')).toBe(false);
    expect(motivo(sospeso, 'ingest_tracking')).toBe('not_authorized');
  });
});

describe("policy — la scrittura di tracciamento", () => {
  it('e concessa a un negozio sano', () => {
    expect(can(evaluateShopCapabilities(SANO), 'ingest_tracking')).toBe(true);
  });

  it("segue l'autorizzazione del tracciamento, come la lettura", () => {
    const fermo = con({ trackingAuthorization: 'PENDING' });
    expect(motivo(fermo, 'ingest_tracking')).toBe('tracking_suspended');
  });

  it("un'app disinstallata non scrive piu' niente", () => {
    expect(motivo(con({ uninstalledAt: new Date() }), 'ingest_tracking')).toBe('uninstalled');
  });

  it('senza progetto collegato non c e dove scrivere', () => {
    expect(motivo(con({ connectionVerifiedAt: null }), 'ingest_tracking')).toBe('not_connected');
  });
});

describe("policy — il valore della colonna, letto senza generosita'", () => {
  // Questi sono i casi che oggi PASSEREBBERO e non devono. La colonna la scrive
  // l'owner a mano: `normalizeAuthorization` mappa a ENABLED tutto cio' che non
  // riconosce, quindi un refuso concederebbe l'accesso proprio al negozio che si
  // voleva fermare. Qui l'unico valore che concede e' l'esatto ENABLED.
  const refusi = ['DISABLD', 'BANNED', 'disabilitato', 'SUSPENDED', 'ENABLE', 'ENABLEDD', '0'];

  for (const refuso of refusi) {
    it(`"${refuso}" non concede niente`, () => {
      expect(motivo(con({ authorization: refuso }), 'use_app')).toBe('not_authorized');
      expect(motivo(con({ trackingAuthorization: refuso }), 'use_read_proxy')).toBe(
        'tracking_suspended',
      );
    });
  }

  it('la colonna vuota o assente nega: in dubbio non si passa', () => {
    for (const vuoto of [null, undefined, '', '   ']) {
      expect(motivo(con({ authorization: vuoto }), 'use_app')).toBe('not_authorized');
      expect(motivo(con({ trackingAuthorization: vuoto }), 'use_read_proxy')).toBe(
        'tracking_suspended',
      );
    }
  });

  it('accetta lo stesso valore scritto in altro modo: spazi e maiuscole non contano', () => {
    for (const buono of ['enabled', '  ENABLED  ', 'Enabled', '\tenabled\n']) {
      expect(motivo(con({ authorization: buono }), 'use_app')).toBeNull();
      expect(motivo(con({ trackingAuthorization: buono }), 'use_read_proxy')).toBeNull();
    }
  });
});

describe('policy — tracciamento sospeso', () => {
  const facts = con({ trackingAuthorization: 'DISABLED' });

  it('nega la sola lettura', () => {
    expect(motivo(facts, 'use_read_proxy')).toBe('tracking_suspended');
  });

  it("non tocca la sincronizzazione: e' l'altra autorizzazione", () => {
    expect(can(evaluateShopCapabilities(facts), 'sync_products')).toBe(true);
    expect(can(evaluateShopCapabilities(facts), 'use_app')).toBe(true);
  });
});

describe('policy — nessun progetto collegato', () => {
  const scollegato = con({ connectionVerifiedAt: null });

  it("lascia usare l'app: e' durante la configurazione che il collegamento ancora non c'e'", () => {
    expect(motivo(scollegato, 'use_app')).toBeNull();
  });

  it("nega tutto cio' che scriverebbe: non c'e' dove scrivere", () => {
    expect(motivo(scollegato, 'sync_products')).toBe('not_connected');
    expect(motivo(scollegato, 'sync_customers')).toBe('not_connected');
    expect(motivo(scollegato, 'sync_orders')).toBe('not_connected');
    expect(motivo(scollegato, 'use_feeds')).toBe('not_connected');
  });

  it("nega la lettura: non c'e' niente da leggere", () => {
    expect(motivo(scollegato, 'use_read_proxy')).toBe('not_connected');
  });

  it("vale anche quando la data e' assente del tutto, non solo quando e' null", () => {
    expect(motivo(con({ connectionVerifiedAt: undefined }), 'sync_products')).toBe(
      'not_connected',
    );
  });

  it("la sospensione dell'app viene prima dello scollegamento", () => {
    const facts = con({ authorization: 'DISABLED', connectionVerifiedAt: null });
    expect(motivo(facts, 'sync_products')).toBe('not_authorized');
  });
});

describe('policy — il piano', () => {
  it('senza clienti nel piano, i clienti non si sincronizzano', () => {
    const facts = con({ plan: { customersSyncEnabled: false, productFeedsEnabled: true } });
    expect(motivo(facts, 'sync_customers')).toBe('plan_required');
    expect(motivo(facts, 'sync_products')).toBeNull();
    expect(motivo(facts, 'use_feeds')).toBeNull();
  });

  it('senza feed nel piano, i feed non si accendono', () => {
    const facts = con({ plan: { customersSyncEnabled: true, productFeedsEnabled: false } });
    expect(motivo(facts, 'use_feeds')).toBe('plan_required');
    expect(motivo(facts, 'sync_customers')).toBeNull();
  });

  it('piano non trovato nel listino: conta come "non lo comprende"', () => {
    // Un nome di piano rinominato nel listino non deve regalare le funzioni che
    // quel piano non aveva: e' l'esito prudente, ed e' quello che il codice
    // faceva gia' ovunque con `plan?.qualcosa ?? false`.
    for (const assente of [null, undefined]) {
      const facts = con({ plan: assente });
      expect(motivo(facts, 'sync_customers')).toBe('plan_required');
      expect(motivo(facts, 'use_feeds')).toBe('plan_required');
    }
  });

  it("il piano non entra dove non c'entra", () => {
    const facts = con({ plan: null });
    expect(motivo(facts, 'use_app')).toBeNull();
    expect(motivo(facts, 'sync_products')).toBeNull();
    expect(motivo(facts, 'sync_orders')).toBeNull();
    expect(motivo(facts, 'use_read_proxy')).toBeNull();
  });

  it('lo scollegamento viene prima del piano', () => {
    const facts = con({ connectionVerifiedAt: null, plan: null });
    expect(motivo(facts, 'sync_customers')).toBe('not_connected');
    expect(motivo(facts, 'use_feeds')).toBe('not_connected');
  });
});

describe('policy — il permesso sugli ordini', () => {
  it('senza i due scope, gli ordini non si sincronizzano', () => {
    expect(motivo(con({ scopes: 'read_products,read_customers' }), 'sync_orders')).toBe(
      'scope_required',
    );
  });

  it("read_all_orders da solo non basta: e' un'estensione di read_orders", () => {
    expect(motivo(con({ scopes: 'read_products,read_all_orders' }), 'sync_orders')).toBe(
      'scope_required',
    );
  });

  it('read_orders da solo non basta', () => {
    expect(motivo(con({ scopes: 'read_products,read_orders' }), 'sync_orders')).toBe(
      'scope_required',
    );
  });

  it('scope assenti o vuoti negano', () => {
    for (const vuoto of [null, undefined, '']) {
      expect(motivo(con({ scopes: vuoto }), 'sync_orders')).toBe('scope_required');
    }
  });

  it('il permesso mancante non tocca le altre sincronizzazioni', () => {
    const facts = con({ scopes: 'read_products' });
    expect(motivo(facts, 'sync_products')).toBeNull();
    expect(motivo(facts, 'sync_customers')).toBeNull();
  });

  it('lo scollegamento viene prima del permesso', () => {
    const facts = con({ connectionVerifiedAt: null, scopes: null });
    expect(motivo(facts, 'sync_orders')).toBe('not_connected');
  });
});

describe('policy — la lettura non eredita le condizioni della scrittura', () => {
  it('il piano senza clienti non chiude il proxy', () => {
    expect(motivo(con({ plan: null }), 'use_read_proxy')).toBeNull();
  });

  it('gli scope mancanti non chiudono il proxy', () => {
    expect(motivo(con({ scopes: null }), 'use_read_proxy')).toBeNull();
  });

  it("l'ordine dei motivi e' disinstallazione, tracciamento, collegamento", () => {
    expect(
      motivo(con({ trackingAuthorization: 'DISABLED', connectionVerifiedAt: null }), 'use_read_proxy'),
    ).toBe('tracking_suspended');
  });
});

describe('policy — la prova gratuita che finisce', () => {
  /**
   * Il buco: la scadenza esisteva solo dove qualcuno passava a scriverla — il
   * loader della dashboard. Il merchant che non riapriva l'app continuava a
   * sincronizzare, a farsi servire il feed e a leggere i suoi dati per mesi
   * dopo la fine della prova. Qui la scadenza e' una risposta della policy, e
   * la policy risponde a tutti nello stesso modo.
   */
  const SCADENZA = new Date('2026-03-01T00:00:00.000Z');

  const inProva = (over: Partial<ShopCapabilityFacts> = {}) =>
    con({ isInTrial: true, trialEndsAt: SCADENZA, activeChargeId: null, ...over });

  it("un istante prima della scadenza non cambia niente", () => {
    const facts = inProva({ now: new Date(SCADENZA.getTime() - 1) });
    expect(concesse(facts)).toEqual([...CAPABILITIES]);
  });

  it('allo scoccare della scadenza si ferma tutto', () => {
    // Il confine e' l'istante stesso: alla scadenza la prova e' finita, non le
    // manca ancora un millisecondo.
    const facts = inProva({ now: SCADENZA });
    expect(concesse(facts)).toEqual([]);
    for (const capability of CAPABILITIES) {
      expect(motivo(facts, capability)).toBe('trial_expired');
    }
  });

  it('ferma anche le letture, che hanno un\'autorizzazione loro', () => {
    // Il container nella vetrina del merchant continuava a farsi servire i dati
    // dei clienti a tempo indeterminato: e' la parte che nessuno guardava.
    expect(motivo(inProva({ now: SCADENZA }), 'use_read_proxy')).toBe('trial_expired');
  });

  it("non dipende da nessuna scrittura: la colonna dice ancora ENABLED", () => {
    // E' il punto. Il riconciliatore che porta la colonna in PENDING puo' non
    // essere mai passato — il merchant non riapre l'app — e la risposta non
    // deve cambiare per questo.
    const facts = inProva({ authorization: 'ENABLED', now: SCADENZA });
    expect(motivo(facts, 'sync_products')).toBe('trial_expired');
  });

  it("un abbonamento attivo vuol dire che il merchant paga: la prova non lo tocca", () => {
    // La sottoscrizione a pagamento con i giorni di prova concessi da Shopify:
    // alla fine di quei giorni comincia l'addebito, non la sospensione. Senza
    // questa regola il primo giorno di fatturazione spegnerebbe l'app a un
    // cliente pagante.
    const facts = inProva({ activeChargeId: '1234', now: SCADENZA });
    expect(concesse(facts)).toEqual([...CAPABILITIES]);
  });

  it('il piano assegnato dall owner non ha una prova che possa scadere', () => {
    // Lifetime non si compra: farlo scadere spegnerebbe l'app a chi non ha
    // nessun modo di riaccenderla, visto che la tab Piano a lui non risponde.
    const facts = inProva({
      plan: { customersSyncEnabled: true, productFeedsEnabled: true, planName: 'lifetime' },
      now: SCADENZA,
    });
    expect(concesse(facts)).toEqual([...CAPABILITIES]);
  });

  it('un piano gratuito senza prova non scade mai', () => {
    // Nessuna data scritta = niente da far scadere. Non si ricostruisce da
    // `installedAt` piu' i giorni del piano: quel conto dava una seconda
    // scadenza, diversa da questa a ogni cambio di listino.
    for (const senza of [null, undefined]) {
      expect(concesse(inProva({ trialEndsAt: senza, now: SCADENZA }))).toEqual([...CAPABILITIES]);
    }
  });

  it("una prova gia' chiusa non riscade", () => {
    // Cambio di piano: `isInTrial` passa a false e la data resta indietro.
    const facts = inProva({ isInTrial: false, now: new Date('2027-01-01T00:00:00Z') });
    expect(concesse(facts)).toEqual([...CAPABILITIES]);
  });

  it("la disinstallazione e la sospensione vengono prima", () => {
    // Sono decisioni prese, e sono quelle che il merchant si vede raccontate
    // nel banner; la prova scaduta copre il caso che nessuno ha ancora toccato.
    const scaduta = { now: SCADENZA };
    expect(motivo(inProva({ ...scaduta, uninstalledAt: new Date() }), 'use_app')).toBe(
      'uninstalled',
    );
    expect(motivo(inProva({ ...scaduta, authorization: 'DISABLED' }), 'use_app')).toBe(
      'not_authorized',
    );
    expect(
      motivo(inProva({ ...scaduta, trackingAuthorization: 'DISABLED' }), 'use_read_proxy'),
    ).toBe('tracking_suspended');
  });

  it('viene prima dello scollegamento: non e\' il database che manca', () => {
    const facts = inProva({ connectionVerifiedAt: null, now: SCADENZA });
    expect(motivo(facts, 'use_read_proxy')).toBe('trial_expired');
  });

  it("senza un istante iniettato si guarda l'orologio, e una scadenza del passato e' passata", () => {
    // `now` esiste per i test; in esercizio la policy legge l'ora da se'.
    expect(motivo(inProva({ trialEndsAt: new Date('2020-01-01T00:00:00Z') }), 'use_app')).toBe(
      'trial_expired',
    );
  });
});
