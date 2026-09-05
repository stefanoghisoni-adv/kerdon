import { describe, it, expect } from 'vitest';
import {
  FAILURE_SITES,
  mayContinueSilently,
  repairSpecOf,
  type FailureSiteName,
  type FailureSite,
} from './failure-taxonomy';

const NOMI = Object.keys(FAILURE_SITES) as FailureSiteName[];

/**
 * La tassonomia non e' documentazione: e' la regola che il codice interroga.
 *
 * Il guasto da cui nasce e' che "avviso e si prosegue" era una scelta
 * disponibile ovunque, e veniva presa per distrazione. Qui si verifica che
 * resti disponibile SOLO dove non costa un dato del merchant.
 */
describe('la tassonomia dei guasti', () => {
  it('l\'unica classe a cui e\' concesso proseguire in silenzio e\' quella cosmetica', () => {
    for (const nome of NOMI) {
      const site: FailureSite = FAILURE_SITES[nome];
      expect(mayContinueSilently(nome)).toBe(site.failureClass === 'cosmetic');
    }
  });

  it('i punti cosmetici sono solo i tre dettagli, e nient\'altro', () => {
    // Se un giorno qualcosa che tocca i dati del merchant venisse dichiarato
    // cosmetico, e' qui che si vedrebbe. Sono le tre letture che servono a dire
    // "aggiunto" invece di "aggiornato": senza risposta si perde il dettaglio,
    // e nessun dato cambia.
    const cosmetici = NOMI.filter((n) => FAILURE_SITES[n].failureClass === 'cosmetic');
    expect(cosmetici.sort()).toEqual([
      'detail.existing-customers',
      'detail.existing-product-rows',
      'detail.returned-rows',
    ]);
  });

  it('ogni punto riparabile sa dire su cosa e con quale operazione', () => {
    // Senza risorsa e operazione una riparazione non ha chiave, quindi non si
    // puo' ne' ritrovare ne' chiudere: sarebbe una riga che si accumula.
    for (const nome of NOMI) {
      if (FAILURE_SITES[nome].failureClass !== 'repairable') continue;
      const spec = repairSpecOf(nome);
      expect(spec).toBeTruthy();
      expect(spec!.resourceType).toBeTruthy();
      expect(spec!.operation).toBeTruthy();
    }
  });

  it('un punto critico non apre riparazioni: fa fallire la corsa', () => {
    expect(repairSpecOf('customer.upsert')).toBeNull();
    expect(repairSpecOf('order.upsert')).toBeNull();
    expect(repairSpecOf('order.line-upsert')).toBeNull();
  });

  it('quel che scrive VERSO Shopify non puo\' essere recuperato dal delta', () => {
    // E' la distinzione da cui dipende tutto il resto. Un prodotto che non si e'
    // riusciti a scrivere torna nel delta appena il confine viene tenuto
    // indietro; una data di nascita che deve andare verso Shopify no — su
    // Shopify non e' cambiato niente, e aspettarla e' aspettare un evento che
    // non puo' accadere.
    expect(repairSpecOf('customer.birthdate-writeback')!.recoveredByDelta).toBe(false);
    // Come la spazzata: la corsa incrementale non spazza, quindi nessun delta
    // la riporta.
    expect(repairSpecOf('product.sweep')!.recoveredByDelta).toBe(false);

    expect(repairSpecOf('product.upsert')!.recoveredByDelta).toBe(true);
    expect(repairSpecOf('customer.consent-revoke')!.recoveredByDelta).toBe(true);
    expect(repairSpecOf('order.stale-lines')!.recoveredByDelta).toBe(true);
  });
});
