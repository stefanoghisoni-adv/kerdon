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
