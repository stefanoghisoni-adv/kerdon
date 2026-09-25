// e2e/tests/billing-callback.spec.ts
//
// Il ritorno dall'approvazione dell'addebito, attraversato per intero.
//
// PERCHE' QUI E NON IN UNA PROVA UNITARIA. `billing.callback.test.ts` prova gia'
// la funzione con dei doppi al posto del database. Quello che non puo' provare
// e' cio' su cui l'idempotenza si regge DAVVERO: che sia POSTGRES a decidere
// chi passa. Il tentativo si verifica e si spende nella stessa `updateMany`,
// dentro una transazione, e la ragione scritta nel commento della rotta e' che
// «fra la lettura e la scrittura ci stanno comodamente due callback
// ravvicinate». Con un finto in memoria quella frase non si puo' mettere alla
// prova: il finto risponderebbe quello che gli e' stato insegnato. Qui il
// database e' vero, la transazione e' vera, e due callback si possono mandare
// insieme sul serio.
//
// E c'e' un secondo pezzo che solo un browser puo' vedere: il rimando di PRIMO
// LIVELLO. Shopify riporta il merchant su questo indirizzo fuori dall'iframe, e
// la rotta lo rimanda dentro l'admin. Un giro che si inceppa li' lascia un
// riquadro vuoto a chi ha appena pagato, ed e' successo.

import { ADMIN_FINTO, ADMIN_FINTO_DESTINAZIONE, expect, test } from './support/prova';
import {
  abbonamento,
  azzera,
  db,
  finti,
  firmaStato,
  NEGOZIO,
  ALTRO_NEGOZIO,
  rispostePerCallback,
  seminaNegozio,
  seminaTentativo,
} from './support/server';

const ADDEBITO = '900100200';
const NONCE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

interface RigaNegozio {
  id: string;
  currentPlan: string;
  activeChargeId: string | null;
  billingCycle: string | null;
  planStartedAt: string | null;
  planConfirmedAt: string | null;
  trialEndsAt: string | null;
  setupCompletedAt: string | null;
}

interface RigaAddebito {
  status: string;
  activatedAt: string | null;
  callbackNonceUsedAt: string | null;
  trialEndsAt: string | null;
}

/** Il negozio e il suo tentativo aperto, pronti per una callback che deve riuscire. */
async function scenarioDiPartenza(
  request: import('@playwright/test').APIRequestContext,
  opzioni: { trialDays?: number; piano?: string } = {},
) {
  const piano = opzioni.piano ?? 'Growth';
  const shop = await seminaNegozio(request, { currentPlan: 'Basic' });
  await seminaTentativo(request, {
    shopId: shop.id,
    shopifyChargeId: Number(ADDEBITO),
    planType: piano,
    price: '29.00',
    currency: 'EUR',
    billingCycle: 'monthly',
    callbackNonce: NONCE,
  });
  await finti(request, {
    sessioni: [NEGOZIO],
    graphql: rispostePerCallback(
      abbonamento({
        chargeId: ADDEBITO,
        name: piano,
        amount: '29.00',
        trialDays: opzioni.trialDays ?? 0,
      }),
    ),
  });
  return { shop, piano };
}

function urlCallback(stato: string | null, charge = ADDEBITO, shop = NEGOZIO): string {
  const params = new URLSearchParams({ charge_id: charge, shop });
  if (stato) params.set('state', stato);
  return `/billing/callback?${params.toString()}`;
}

const statoBuono = () =>
  firmaStato({
    nonce: NONCE,
    shopDomain: NEGOZIO,
    planName: 'Growth',
    listPrice: 29,
    currency: 'EUR',
    interval: 'monthly',
  });

async function leggiNegozio(request: import('@playwright/test').APIRequestContext) {
  return db<RigaNegozio>(request, 'shop', 'findUnique', {
    where: { shopDomain: NEGOZIO },
    select: {
      id: true,
      currentPlan: true,
      activeChargeId: true,
      billingCycle: true,
      planStartedAt: true,
      planConfirmedAt: true,
      trialEndsAt: true,
      setupCompletedAt: true,
    },
  });
}

async function leggiAddebito(request: import('@playwright/test').APIRequestContext) {
  return db<RigaAddebito>(request, 'billingCharge', 'findUnique', {
    where: { shopifyChargeId: Number(ADDEBITO) },
    select: { status: true, activatedAt: true, callbackNonceUsedAt: true, trialEndsAt: true },
  });
}

test.describe('il ritorno dall approvazione dell addebito', () => {
  test.beforeEach(async ({ request }) => {
    await azzera(request);
  });

  test('un tentativo riconosciuto attiva il piano e rimanda dentro l admin', async ({ request }) => {
    await scenarioDiPartenza(request, { trialDays: 7 });

    const risposta = await request.get(urlCallback(statoBuono()), { maxRedirects: 0 });

    expect(risposta.status()).toBe(302);
    const destinazione = risposta.headers()['location'];
    // Si rientra DALL'ADMIN, non dall'indirizzo dell'app: cosi' e' l'admin ad
    // aprire il riquadro con la sessione gia' buona. Il giro in cui era l'app a
    // rientrare da sola si inceppava e lasciava una pagina bianca a chi aveva
    // appena pagato.
    expect(destinazione).toContain('https://admin.shopify.com/store/kerdon-prova/apps/');
    expect(destinazione).toContain('billing=ok');
    // Nessun sotto-percorso dopo l'id dell'app: con `/plan` in coda il riquadro
    // restava vuoto, senza contenuto e senza menu.
    expect(destinazione).not.toMatch(/\/apps\/[^?]+\//);

    const negozio = await leggiNegozio(request);
    expect(negozio.currentPlan).toBe('Growth');
    expect(negozio.activeChargeId).toBe(ADDEBITO);
    expect(negozio.billingCycle).toBe('monthly');
    // Approvare un piano a pagamento E' confermare il piano: il quarto passo
    // della configurazione risulta fatto, e nella STESSA scrittura del piano —
    // due update separate potrebbero riuscire a meta' e lascerebbero il negozio
    // sul piano nuovo con la configurazione ancora aperta.
    expect(negozio.planConfirmedAt).not.toBeNull();
    expect(negozio.planStartedAt).not.toBeNull();

    const addebito = await leggiAddebito(request);
    expect(addebito.status).toBe('active');
    expect(addebito.callbackNonceUsedAt).not.toBeNull();
    // I giorni di prova sono quelli che Shopify ha davvero concesso.
    expect(addebito.trialEndsAt).not.toBeNull();
  });

  test('ricaricare la pagina non riapplica niente: nessun timestamp si sposta', async ({
    request,
  }) => {
    await scenarioDiPartenza(request, { trialDays: 7 });
    const stato = statoBuono();

    await request.get(urlCallback(stato), { maxRedirects: 0 });
    const primo = await leggiNegozio(request);
    const primoAddebito = await leggiAddebito(request);

    // Le risposte preparate si erano consumate? No: il finto le tiene, perche'
    // una ricarica rifa' davvero le stesse letture.
    const seconda = await request.get(urlCallback(stato), { maxRedirects: 0 });

    // IL DIFETTO CHE QUESTA PROVA FERMA: finche' bastava un abbonamento attivo,
    // un semplice F5 riapplicava il piano — `planStartedAt` e `trialEndsAt`
    // ripartivano da capo, cioe' il periodo di prova si allungava di un giro a
    // ogni ricarica.
    expect(seconda.headers()['location']).toContain('billing=ok');
    const secondo = await leggiNegozio(request);
    expect(secondo.planStartedAt).toBe(primo.planStartedAt);
    expect(secondo.trialEndsAt).toBe(primo.trialEndsAt);
    expect((await leggiAddebito(request)).callbackNonceUsedAt).toBe(
      primoAddebito.callbackNonceUsedAt,
    );
  });

  test('due callback insieme attivano una volta sola', async ({ request }) => {
    await scenarioDiPartenza(request);
    const stato = statoBuono();

    // Insieme sul serio: e' il caso che il commento della rotta descrive — il
    // merchant che ricarica, la scheda rimasta aperta — e l'unica cosa che lo
    // rende innocuo e' che le condizioni stiano nella WHERE, cioe' che a
    // decidere sia il database una volta sola.
    const [una, due] = await Promise.all([
      request.get(urlCallback(stato), { maxRedirects: 0 }),
      request.get(urlCallback(stato), { maxRedirects: 0 }),
    ]);

    // L'INVARIANTE, che e' quello che conta: una sola attivazione. Una riga
    // sola, in stato attivo, con un solo nonce speso.
    const addebiti = await db<{ status: string; callbackNonceUsedAt: string | null }[]>(
      request,
      'billingCharge',
      'findMany',
      {
        where: { shopifyChargeId: Number(ADDEBITO) },
        select: { status: true, callbackNonceUsedAt: true },
      },
    );
    expect(addebiti).toHaveLength(1);
    expect(addebiti[0].status).toBe('active');
    expect(addebiti[0].callbackNonceUsedAt).not.toBeNull();

    const esiti = [una, due].map((r) => new URL(r.headers()['location']).searchParams.get('billing'));
    // Almeno una delle due dice che e' andata: quella che ha attivato.
    expect(esiti).toContain('ok');

    // E QUI C'E' UNA COSA DA SAPERE, che solo una corsa vera fa vedere. La
    // seconda callback puo' rispondere 'ko' pur essendo tutto riuscito: arriva
    // mentre la transazione dell'altra non ha ancora fatto COMMIT, quindi non
    // spende il tentativo E non vede ancora il negozio sul piano nuovo. Non e'
    // un difetto dei dati — il piano c'e', l'addebito e' uno solo — ma il
    // merchant di quella scheda legge "non e' andata" per qualcosa che e'
    // andata. Non si corregge qui: si dichiara, perche' una prova che nascose
    // il caso e' peggio di una che lo scrive.
    expect(esiti.filter((e) => e === 'ok').length).toBeGreaterThanOrEqual(1);
  });

  test('senza state non si attiva niente, e il negozio resta dov era', async ({ request }) => {
    await scenarioDiPartenza(request);

    const risposta = await request.get(urlCallback(null), { maxRedirects: 0 });

    // Una callback senza state puo' solo CONFERMARE un piano gia' applicato.
    // Qui il negozio e' ancora su Basic, quindi non c'e' niente da confermare.
    expect(risposta.headers()['location']).toContain('billing=ko');
    const negozio = await leggiNegozio(request);
    expect(negozio.currentPlan).toBe('Basic');
    expect(negozio.activeChargeId).toBeNull();
    expect((await leggiAddebito(request)).status).toBe('pending');
  });

  test('uno state firmato male non vale piu di uno assente', async ({ request }) => {
    await scenarioDiPartenza(request);

    // Stessa forma, firma di un altro: la callback non deve nemmeno provare a
    // leggerne il contenuto.
    const contraffatto = `${statoBuono().split('.')[0]}.firmaCheNonEnostra`;
    const risposta = await request.get(urlCallback(contraffatto), { maxRedirects: 0 });

    expect(risposta.headers()['location']).toContain('billing=ko');
    expect((await leggiNegozio(request)).currentPlan).toBe('Basic');
  });

  test('lo state di un altro negozio non attiva niente', async ({ request }) => {
    await scenarioDiPartenza(request);

    const altrui = firmaStato({
      nonce: NONCE,
      shopDomain: ALTRO_NEGOZIO,
      planName: 'Growth',
      listPrice: 29,
      currency: 'EUR',
      interval: 'monthly',
    });
    const risposta = await request.get(urlCallback(altrui), { maxRedirects: 0 });

    expect(risposta.headers()['location']).toContain('billing=ko');
    expect((await leggiNegozio(request)).currentPlan).toBe('Basic');
    expect((await leggiAddebito(request)).status).toBe('pending');
  });

  test('uno state per un piano diverso da quello confermato non attiva niente', async ({
    request,
  }) => {
    await scenarioDiPartenza(request);

    // "Scale" e non "Core": uno state "Core" a 29 e' quello firmato fra il 23 e
    // il 26 settembre 2026 per il piano che oggi si chiama Growth, e l'app lo
    // riconosce come tale. "Scale" a 29 non e' di nessuno scaglione di allora.
    const altroPiano = firmaStato({
      nonce: NONCE,
      shopDomain: NEGOZIO,
      planName: 'Scale',
      listPrice: 29,
      currency: 'EUR',
      interval: 'monthly',
    });
    const risposta = await request.get(urlCallback(altroPiano), { maxRedirects: 0 });

    expect(risposta.headers()['location']).toContain('billing=ko');
    expect((await leggiNegozio(request)).currentPlan).toBe('Basic');
  });

  test('uno state scaduto non attiva niente', async ({ request }) => {
    await scenarioDiPartenza(request);

    const scaduto = firmaStato(
      {
        nonce: NONCE,
        shopDomain: NEGOZIO,
        planName: 'Growth',
        listPrice: 29,
        currency: 'EUR',
        interval: 'monthly',
      },
      Date.now() - 1000,
    );
    const risposta = await request.get(urlCallback(scaduto), { maxRedirects: 0 });

    expect(risposta.headers()['location']).toContain('billing=ko');
    expect((await leggiNegozio(request)).currentPlan).toBe('Basic');
  });

  test('un addebito rifiutato viene registrato, e nessun piano si muove', async ({ request }) => {
    const shop = await seminaNegozio(request, { currentPlan: 'Basic' });
    await seminaTentativo(request, {
      shopId: shop.id,
      shopifyChargeId: Number(ADDEBITO),
      planType: 'Growth',
      callbackNonce: NONCE,
    });
    await finti(request, {
      sessioni: [NEGOZIO],
      graphql: rispostePerCallback(
        abbonamento({ chargeId: ADDEBITO, name: 'Growth', status: 'DECLINED' }),
      ),
    });

    const risposta = await request.get(urlCallback(statoBuono()), { maxRedirects: 0 });

    expect(risposta.headers()['location']).toContain('billing=ko');
    // Non e' un'attivazione ma una riconciliazione: si prende atto di uno stato
    // che Shopify dichiara per conto suo.
    expect((await leggiAddebito(request)).status).toBe('declined');
    expect((await leggiNegozio(request)).currentPlan).toBe('Basic');
  });

  test('un charge_id inventato non tocca niente', async ({ request }) => {
    await scenarioDiPartenza(request);
    await finti(request, {
      sessioni: [NEGOZIO],
      // Shopify non conosce quell'id: `node` torna null.
      graphql: [{ match: 'BillingSubscriptionById', body: { data: { node: null } } }],
    });

    const risposta = await request.get(urlCallback(statoBuono(), '777000111'), {
      maxRedirects: 0,
    });

    expect(risposta.headers()['location']).toContain('billing=ko');
    expect((await leggiNegozio(request)).currentPlan).toBe('Basic');
    expect((await leggiAddebito(request)).status).toBe('pending');
  });

  test('un negozio senza sessione salvata non arriva nemmeno a leggere l abbonamento', async ({
    request,
  }) => {
    await scenarioDiPartenza(request);
    // Nessuna sessione offline per quel negozio: e' il ramo in cui
    // `unauthenticated.admin` fallisce, e da li' non si costruisce nessun
    // client — quindi un charge_id indovinato non ottiene niente.
    await finti(request, { sessioni: [] });

    const risposta = await request.get(urlCallback(statoBuono()), { maxRedirects: 0 });
    expect(risposta.headers()['location']).toContain('billing=ko');
  });

  test('un dominio che non e di Shopify viene rifiutato prima di qualunque lettura', async ({
    request,
  }) => {
    await scenarioDiPartenza(request);

    const risposta = await request.get(
      `/billing/callback?charge_id=${ADDEBITO}&state=${statoBuono()}&shop=negozio.example.com`,
      { maxRedirects: 0 },
    );

    expect(risposta.headers()['location']).toContain('billing=ko');
    expect((await leggiNegozio(request)).currentPlan).toBe('Basic');
  });

  test('nel browser il rimando di primo livello porta davvero dentro l admin', async ({
    page,
    request,
  }) => {
    await scenarioDiPartenza(request);

    // L'admin di Shopify non si chiama davvero: lo serve la rete chiusa di
    // `support/prova.ts`. E' l'unico modo di provare che il giro ARRIVA — un
    // 302 letto da un client HTTP dice dove punta, non che un browser lo segua
    // fino in fondo, e quel giro si e' gia' inceppato una volta lasciando un
    // riquadro vuoto a chi aveva appena pagato.
    await page.goto(urlCallback(statoBuono()));

    await expect(page.locator(ADMIN_FINTO)).toBeVisible();

    // Dove l'app aveva davvero mandato il browser.
    const destinazione = new URL(
      (await page.locator(ADMIN_FINTO_DESTINAZIONE).innerText()).trim(),
    );
    expect(destinazione.host).toBe('admin.shopify.com');
    expect(destinazione.pathname).toBe('/store/kerdon-prova/apps/chiave-di-prova-e2e');
    expect(destinazione.searchParams.get('billing')).toBe('ok');
    // Primo piano scelto: la dashboard deve poterlo dire, e lo sa solo adesso —
    // un istante dopo la configurazione risultera' chiusa e quel "prima" non
    // sara' piu' ricostruibile.
    expect(destinazione.searchParams.get('first')).toBe('1');
  });
});
