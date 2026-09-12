// e2e/tests/disconnect.spec.ts
//
// Scollegare Supabase: con i dati, senza i dati, e quando l'eliminazione non
// riesce.
//
// LA REGOLA CHE QUESTE PROVE ESISTONO PER SORVEGLIARE, e che e' anche l'unica
// che costa davvero qualcosa a sbagliare: a eliminazione FALLITA le credenziali
// NON si cancellano. Sono l'unica cosa con cui il merchant puo' ancora portare
// a termine il lavoro, e prima venivano cancellate comunque — anche dopo un
// errore — con il merchant che intanto aveva letto "fatto". Da li' in poi non
// c'era piu' modo di finire.
//
// COSA E' FINTO E COSA NO. E' finta la sola `deleteMerchantData`, perche'
// dietro c'e' un DROP TABLE su un progetto Supabase vero: non e' una cosa che
// si prova contro un servizio. Tutto quello che la rotta fa INTORNO a quella
// chiamata — l'ordine delle cancellazioni, il permesso, i codici di risposta —
// e' il codice vero davanti al database vero.

import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { test as prova } from './support/prova';
import {
  azzera,
  cosaHannoVisto,
  db,
  entraComeNegozio,
  finti,
  NEGOZIO,
  seminaNegozio,
  spostaOrologio,
} from './support/server';

const MINUTO = 60 * 1000;

interface StatoCollegamento {
  configurazioni: number;
  gettoni: number;
  setupCompletedAt: string | null;
}

/** Un negozio collegato a un progetto, con credenziali e configurazione a posto. */
async function seminaCollegato(
  request: APIRequestContext,
  datiNegozio: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const shop = await seminaNegozio(request, {
    setupCompletedAt: new Date().toISOString(),
    ...datiNegozio,
  });
  await db(request, 'supabaseConfig', 'create', {
    data: {
      shopId: shop.id,
      supabaseUrl: 'https://progetto-inventato.supabase.co',
      supabasePublicKey: 'chiave-pubblica-finta',
      supabaseServiceRoleKey: 'chiave-di-servizio-finta',
      supabaseProjectRef: 'progettoinventato',
      connectionVerifiedAt: new Date().toISOString(),
    },
    select: { id: true },
  });
  await db(request, 'supabaseOAuthToken', 'create', {
    data: {
      shopId: shop.id,
      accessToken: 'gettone-finto',
      refreshToken: 'rinnovo-finto',
      expiresAt: new Date(Date.now() + 60 * MINUTO).toISOString(),
    },
    select: { id: true },
  });
  return shop;
}

async function statoCollegamento(
  request: APIRequestContext,
  shopId: string,
): Promise<StatoCollegamento> {
  const negozio = await db<{ setupCompletedAt: string | null }>(request, 'shop', 'findUnique', {
    where: { id: shopId },
    select: { setupCompletedAt: true },
  });
  return {
    configurazioni: await db<number>(request, 'supabaseConfig', 'count', { where: { shopId } }),
    gettoni: await db<number>(request, 'supabaseOAuthToken', 'count', { where: { shopId } }),
    setupCompletedAt: negozio.setupCompletedAt,
  };
}

async function scollega(
  context: BrowserContext,
  corpo: Record<string, unknown> = {},
): Promise<{ stato: number; corpo: Record<string, unknown> }> {
  const risposta = await context.request.post('/api/supabase/disconnect', { data: corpo });
  return { stato: risposta.status(), corpo: (await risposta.json()) as Record<string, unknown> };
}

prova.describe('lo scollegamento di Supabase', () => {
  prova.beforeEach(async ({ request, context }) => {
    await azzera(request);
    await entraComeNegozio(context, NEGOZIO);
  });

  prova('senza eliminare i dati si revoca soltanto, e la configurazione si riapre', async ({
    request,
    context,
  }) => {
    const shop = await seminaCollegato(request);

    const { stato, corpo } = await scollega(context);

    expect(stato).toBe(200);
    expect(corpo.ok).toBe(true);
    const dopo = await statoCollegamento(request, shop.id);
    expect(dopo.configurazioni).toBe(0);
    expect(dopo.gettoni).toBe(0);
    // Scollegarsi riporta il negozio al punto di partenza: e' l'unico gesto che
    // riapre la configurazione.
    expect(dopo.setupCompletedAt).toBeNull();
    // E NESSUNA tabella e' stata toccata: restano dove sono, con dentro tutto.
    expect((await cosaHannoVisto(request)).eliminazioniChieste).toBe(0);
  });

  prova('eliminando i dati, a verifica riuscita si scollega e si conferma', async ({
    request,
    context,
  }) => {
    const shop = await seminaCollegato(request);
    await finti(request, {
      eliminazione: {
        status: 'completed',
        attempted: ['public.kerdon_products', 'public.kerdon_customers'],
        remaining: [],
      },
    });

    const { stato, corpo } = await scollega(context, { deleteData: true });

    expect(stato).toBe(200);
    expect(corpo.ok).toBe(true);
    expect(corpo.deleted).toEqual(['public.kerdon_products', 'public.kerdon_customers']);
    // Una volta sola: chiedere due volte un DROP TABLE sul database di un
    // merchant non e' un dettaglio.
    expect((await cosaHannoVisto(request)).eliminazioniChieste).toBe(1);
    // Token e configurazione li ha gia' tolti l'eliminazione, DOPO la verifica:
    // da qui in poi la rotta non cancella piu' niente, ed e' giusto cosi' —
    // l'ordine e' quello che tiene in piedi il caso fallito.
    const dopo = await statoCollegamento(request, shop.id);
    expect(dopo.configurazioni).toBe(0);
    expect(dopo.gettoni).toBe(0);
  });

  prova('se l eliminazione fallisce le credenziali RESTANO, ed e il punto di tutto', async ({
    request,
    context,
  }) => {
    const shop = await seminaCollegato(request);
    await finti(request, {
      eliminazione: {
        status: 'failed',
        attempted: ['public.kerdon_products'],
        remaining: ['public.kerdon_products'],
        retryable: true,
      },
    });

    const { stato, corpo } = await scollega(context, { deleteData: true });

    // 503: e' un guasto passeggero, e riprovare ha senso.
    expect(stato).toBe(503);
    expect(corpo.ok).toBe(false);
    expect(corpo.code).toBe('delete_data_failed');
    expect(corpo.remaining).toEqual(['public.kerdon_products']);

    // E QUESTO E' CIO' CHE CONTA: token e configurazione sono ancora li'. Sono
    // l'unica cosa con cui l'eliminazione si puo' ancora portare a termine, e il
    // merchant resta collegato proprio per poter riprovare.
    const dopo = await statoCollegamento(request, shop.id);
    expect(dopo.configurazioni).toBe(1);
    expect(dopo.gettoni).toBe(1);
    expect(dopo.setupCompletedAt).not.toBeNull();
  });

  prova('un guasto che riprovare non risolve si distingue da uno passeggero', async ({
    request,
    context,
  }) => {
    const shop = await seminaCollegato(request);
    await finti(request, {
      eliminazione: {
        status: 'failed',
        attempted: ['public.nome malformato'],
        remaining: ['public.nome malformato'],
        // Un nome malformato non diventa valido riprovandolo: va corretto prima.
        retryable: false,
      },
    });

    const { stato, corpo } = await scollega(context, { deleteData: true });

    expect(stato).toBe(422);
    expect(corpo.retryable).toBe(false);
    const dopo = await statoCollegamento(request, shop.id);
    expect(dopo.configurazioni).toBe(1);
  });

  prova('una seconda richiesta ravvicinata non ripete niente e lo dice', async ({
    request,
    context,
  }) => {
    const shop = await seminaCollegato(request);
    await finti(request, { eliminazione: { status: 'already_running' } });

    const { stato, corpo } = await scollega(context, { deleteData: true });

    // Non e' un successo da mostrare — l'esito vero non lo conosce — ne' un
    // guasto: e' la prima richiesta che sta ancora lavorando.
    expect(stato).toBe(409);
    expect(corpo.code).toBe('deletion_in_progress');
    const dopo = await statoCollegamento(request, shop.id);
    expect(dopo.configurazioni).toBe(1);
    expect(dopo.gettoni).toBe(1);
  });

  prova('se sul progetto non risulta niente di nostro, lo scollegamento si fa lo stesso', async ({
    request,
    context,
  }) => {
    const shop = await seminaCollegato(request);
    await finti(request, { eliminazione: { status: 'nothing_owned' } });

    const { stato, corpo } = await scollega(context, { deleteData: true });

    expect(stato).toBe(200);
    expect(corpo.ok).toBe(true);
    const dopo = await statoCollegamento(request, shop.id);
    expect(dopo.configurazioni).toBe(0);
  });

  // Un negozio sospeso deve poter uscire. Prima qui c'era un 403: chi non
  // poteva piu' usare l'app restava chiuso dentro con i propri dati ancora da
  // noi, e far dipendere la cancellazione dall'avere un abbonamento attivo e'
  // cio' che il GDPR non ammette.
  prova('un negozio sospeso scollega lo stesso: e la via d uscita', async ({
    request,
    context,
  }) => {
    const shop = await seminaCollegato(request, { authorization: 'DISABLED' });

    const { stato, corpo } = await scollega(context);

    expect(stato).toBe(200);
    expect(corpo.ok).toBe(true);
    const dopo = await statoCollegamento(request, shop.id);
    expect(dopo.configurazioni).toBe(0);
  });

  prova('senza una sessione non si arriva nemmeno alla rotta', async ({ context, request }) => {
    await seminaCollegato(request);
    await context.clearCookies();

    const risposta = await context.request.post('/api/supabase/disconnect', { data: {} });
    expect(risposta.status()).toBe(401);
  });

  prova(
    'la prova scaduta ferma l app anche se le letture di prima hanno gia scaldato le cache',
    async ({ request, context }) => {
      // LO SCENARIO, che e' quello che una prova unitaria non sa mettere in
      // scena: il merchant sta usando l'app mentre la prova sta per finire. Le
      // pagine che ha appena aperto hanno gia' riempito le cache in memoria del
      // processo — il listino delle valute ne tiene una da un minuto — e la
      // domanda e' se qualcuna di quelle risposte scaldate continui a far
      // passare un negozio la cui prova nel frattempo e' scaduta.
      const shop = await seminaCollegato(request, {
        currentPlan: 'Pro',
        isInTrial: true,
        trialEndsAt: new Date(Date.now() + 5 * MINUTO).toISOString(),
        activeChargeId: null,
      });

      // Prima: l'app funziona, e la lettura riempie le cache.
      const limiti = await context.request.get('/api/plan/limits');
      expect(limiti.status()).toBe(200);
      expect((await scollega(context)).stato).toBe(200);

      // Si rimette il collegamento e si attraversa la scadenza. L'orologio si
      // sposta: non si riscrive la data nel database, perche' a "scaduto" nel
      // sistema vero ci si arriva restandoci dentro.
      await db(request, 'shop', 'update', {
        where: { id: shop.id },
        data: { setupCompletedAt: new Date().toISOString() },
      });
      await db(request, 'supabaseConfig', 'create', {
        data: {
          shopId: shop.id,
          supabaseUrl: 'https://progetto-inventato.supabase.co',
          supabasePublicKey: 'chiave-pubblica-finta',
          supabaseServiceRoleKey: 'chiave-di-servizio-finta',
          connectionVerifiedAt: new Date().toISOString(),
        },
        select: { id: true },
      });
      await spostaOrologio(request, 10 * MINUTO);

      // Dopo: la prova e' finita. Le funzioni dell'app sono chiuse, ma questa
      // no — e' la porta da cui si esce, e si esce anche (soprattutto) quando
      // non si puo' piu' entrare.
      const dopo = await scollega(context);
      expect(dopo.stato).toBe(200);
      expect(dopo.corpo.ok).toBe(true);
    },
  );
});
