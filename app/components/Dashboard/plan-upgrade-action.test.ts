import { describe, it, expect } from 'vitest';

import { upgradeRequestState } from './plan-upgrade-action';

describe('upgradeRequestState', () => {
  it('premuto e confronto non ancora pronto → il cerchietto gira', () => {
    expect(upgradeRequestState({ requested: true, ready: false })).toEqual({
      loading: true,
      open: false,
    });
  });

  it('premuto e confronto pronto → si apre, e il cerchietto si spegne', () => {
    expect(upgradeRequestState({ requested: true, ready: true })).toEqual({
      loading: false,
      open: true,
    });
  });

  it('non premuto → niente, anche se il confronto sarebbe pronto', () => {
    // I dati restano in mano al comando anche dopo una chiusura: se bastassero
    // loro, il confronto si riaprirebbe da solo appena chiuso.
    expect(upgradeRequestState({ requested: false, ready: true })).toEqual({
      loading: false,
      open: false,
    });
  });

  it('due inviti nella stessa card: aspetta solo quello premuto', () => {
    // E' il caso che ha fatto nascere questo modulo. In Impostazioni la card
    // dell'account porta due "Aggiorna a…" — clienti e feed — e finche' erano
    // due collegamenti alla tab Piano il loro stato veniva da una sola
    // `useNavLoading('/plan')`: la stessa destinazione, quindi lo stesso
    // cerchietto, quindi premendone uno partivano tutti e due.
    //
    // Ora ognuno ha il proprio stato e non c'e' piu' niente da spartire.
    const clienti = upgradeRequestState({ requested: true, ready: false });
    const feed = upgradeRequestState({ requested: false, ready: false });

    expect(clienti.loading).toBe(true);
    expect(feed.loading).toBe(false);
    expect(feed.open).toBe(false);
  });

  it('due inviti che propongono lo STESSO piano restano comunque distinti', () => {
    // Il caso peggiore del difetto di prima: sulla stessa card i due inviti
    // possono proporre lo stesso piano — Business include sia i clienti sia i
    // feed. Uno stato tenuto per destinazione li rimetterebbe insieme; qui a
    // decidere e' chi e' stato premuto, e il piano proposto non c'entra.
    const premuto = upgradeRequestState({ requested: true, ready: true });
    const altro = upgradeRequestState({ requested: false, ready: true });

    expect(premuto.open).toBe(true);
    expect(altro.open).toBe(false);
  });
});
