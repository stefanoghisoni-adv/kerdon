// e2e/tests/lucchetto.spec.ts
//
// Il lucchetto del negozio: due lavorazioni che chiedono insieme, e una sola
// che passa.
//
// PERCHE' NON PUO' STARE IN UNA PROVA UNITARIA. A decidere chi passa non e' una
// riga di TypeScript: e' una singola istruzione SQL — `INSERT ... ON CONFLICT
// DO UPDATE ... WHERE expires_at <= now` — e tutto il file `shop-lock.server.ts`
// esiste per non dover MAI fare "leggo, controllo, poi scrivo", che con due
// invocazioni simultanee darebbe il lucchetto a tutte e due. Un doppio in
// memoria proverebbe il doppio; qui sotto c'e' Postgres, e le due richieste
// partono davvero insieme.
//
// E CIO' CHE IL LUCCHETTO PROTEGGE non e' un contatore: e' il database di un
// merchant, dove il lavoro che viene dopo cancella righe. Il file lo dice in
// tondo — «fail-closed, ed e' il punto di tutto questo file: non si prosegue
// senza lucchetto nemmeno solo per stavolta».

import { expect, test as prova } from './support/prova';
import { azzera, db, seminaNegozio } from './support/server';

interface Lucchetto {
  shopId: string;
  owner: string;
  fencingToken: number;
  expiresAt: string;
}

async function corsa(
  request: import('@playwright/test').APIRequestContext,
  shopId: string,
  holdMs = 250,
): Promise<string[]> {
  const risposta = await request.post('/__test/lock-race', { data: { shopId, holdMs } });
  const corpo = (await risposta.json()) as { esiti: string[]; error?: string };
  expect(corpo.error, 'corsa al lucchetto').toBeUndefined();
  return corpo.esiti;
}

async function lucchetti(
  request: import('@playwright/test').APIRequestContext,
): Promise<Lucchetto[]> {
  return db<Lucchetto[]>(request, 'shopLock', 'findMany', {
    select: { shopId: true, owner: true, fencingToken: true, expiresAt: true },
  });
}

prova.describe('il lucchetto di un negozio', () => {
  prova.beforeEach(async ({ request }) => {
    await azzera(request);
  });

  prova('due lavorazioni insieme: una lavora, l altra trova occupato', async ({ request }) => {
    const shop = await seminaNegozio(request);

    const esiti = await corsa(request, shop.id);

    // Esattamente una delle due. Non "almeno una": se passassero entrambe, due
    // corse scriverebbero insieme nel database dello stesso merchant.
    expect(esiti.sort()).toEqual(['eseguito', 'occupato']);
  });

  prova('mentre si lavora il lucchetto c e, e a lavoro finito viene rilasciato', async ({
    request,
  }) => {
    const shop = await seminaNegozio(request);

    // Si guarda DURANTE, non dopo: a lavoro finito il lucchetto e' gia' stato
    // rilasciato, e una prova che guardasse solo alla fine non distinguerebbe
    // "preso e rilasciato" da "mai preso".
    const inCorso = corsa(request, shop.id, 2_000);

    await expect
      .poll(async () => (await lucchetti(request)).length, { timeout: 5_000 })
      .toBe(1);

    const preso = (await lucchetti(request))[0];
    expect(preso.shopId).toBe(shop.id);
    expect(preso.owner).not.toBe('');
    // Il gettone identifica LA PRESA, non il negozio: e' quello che ogni
    // scrittura distruttiva riverifica prima di partire.
    expect(preso.fencingToken).toBeGreaterThanOrEqual(1);
    // E ha una scadenza: un lavoratore che muore non lascia un negozio bloccato
    // per sempre.
    expect(new Date(preso.expiresAt).getTime()).toBeGreaterThan(Date.now());

    expect((await inCorso).sort()).toEqual(['eseguito', 'occupato']);
    expect(await lucchetti(request)).toHaveLength(0);
  });

  prova('due negozi diversi non si aspettano a vicenda', async ({ request }) => {
    const uno = await seminaNegozio(request, {}, 'kerdon-uno.myshopify.com');
    const due = await seminaNegozio(request, {}, 'kerdon-due.myshopify.com');

    const [esitiUno, esitiDue] = await Promise.all([
      corsa(request, uno.id, 200),
      corsa(request, due.id, 200),
    ]);

    // Il lucchetto e' PER NEGOZIO: se fosse globale, la sincronizzazione di un
    // merchant terrebbe fermo quella di tutti gli altri.
    expect(esitiUno).toContain('eseguito');
    expect(esitiDue).toContain('eseguito');
  });

  prova('un negozio in cancellazione non ottiene il lucchetto', async ({ request }) => {
    // Fail-closed: un negozio la cui cancellazione e' gia' cominciata non va
    // lavorato, e non e' un errore — e' il risultato voluto. Senza, si
    // finirebbe per scrivere dentro un negozio gia' cancellato.
    const shop = await seminaNegozio(request, { lifecycleStatus: 'erasing' });

    const esiti = await corsa(request, shop.id, 50);

    expect(esiti).toEqual(['occupato', 'occupato']);
    // E quel che si era preso e' stato rilasciato subito: nessun lucchetto
    // resta appeso a un negozio che nessuno lavorera'.
    expect(await lucchetti(request)).toHaveLength(0);
  });
});
