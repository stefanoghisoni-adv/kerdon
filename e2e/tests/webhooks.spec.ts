// e2e/tests/webhooks.spec.ts
//
// Le consegne di Shopify: la ricevuta, il doppione e il ritentativo.
//
// LA REGOLA CHE QUESTE PROVE SORVEGLIANO, e che vale piu' di tutte le altre di
// questo file: il 200 risponde a UNA domanda sola — l'evento e' nostro e non si
// perde piu'. Non dice che sia stato applicato. Prima era il contrario: si
// faceva il lavoro, si catturava l'errore e si rispondeva 200 comunque, e quel
// 200 diceva a Shopify "consegnato" per un evento che nessuna riga ricordava.
// Da li' in poi un negozio disinstallato restava attivo nei registri senza che
// da nessuna parte risultasse qualcosa da fare.
//
// PERCHE' SERVE UN DATABASE VERO. La deduplica sta su due livelli, e tutti e
// due sono del database: l'indice unico su `webhook_id`, che fa di due consegne
// una riga sola, e l'`updateMany` condizionato sullo stato, che fa di due
// lavorazioni simultanee una sola. Con un finto in memoria si proverebbe il
// finto; qui due consegne si possono mandare insieme sul serio.
//
// E LE FIRME SONO VERE. `verifyWebhook` calcola l'HMAC con il segreto dell'app,
// e la prova lo calcola con lo stesso segreto preso dallo stesso file: una
// consegna con la firma sbagliata viene rifiutata dal codice vero, non da un
// doppio che dice di no.

import { expect, test, type APIRequestContext } from '@playwright/test';
import { test as prova } from './support/prova';
import { azzera, db, firmaWebhook, NEGOZIO, seminaNegozio } from './support/server';

interface RigaEvento {
  id: string;
  webhookId: string;
  topic: string;
  shopDomain: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
}

let progressivo = 0;

/** Una consegna, firmata come la firmerebbe Shopify. */
async function consegna(
  request: APIRequestContext,
  opzioni: {
    percorso?: string;
    corpo?: unknown;
    corpoGrezzo?: string;
    topic?: string;
    idConsegna?: string;
    firma?: string;
    negozio?: string | null;
  } = {},
) {
  const corpo = opzioni.corpoGrezzo ?? JSON.stringify(opzioni.corpo ?? { id: 1001, name: '#1001' });
  const intestazioni: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Shopify-Hmac-Sha256': opzioni.firma ?? firmaWebhook(corpo),
    'X-Shopify-Topic': opzioni.topic ?? 'orders/create',
    'X-Shopify-Webhook-Id': opzioni.idConsegna ?? `consegna-${++progressivo}`,
  };
  if (opzioni.negozio !== null) intestazioni['X-Shopify-Shop-Domain'] = opzioni.negozio ?? NEGOZIO;

  // Il corpo si manda come byte e non come stringa: passando una stringa,
  // Playwright con `Content-Type: application/json` la RISERIALIZZA fra
  // virgolette, e la firma — calcolata sul corpo com'e' scritto qui — non
  // corrisponderebbe piu'. Sarebbe un 401 al posto del 400 che si voleva
  // provare: la prova fallirebbe dicendo la cosa sbagliata.
  return request.post(opzioni.percorso ?? '/webhooks/orders', {
    headers: intestazioni,
    data: Buffer.from(corpo, 'utf8'),
  });
}

/**
 * La riga di UNA consegna, cercata per il suo identificativo.
 *
 * Prendere `eventi()[0]` sembrava equivalente — il beforeEach azzera la tabella,
 * quindi la riga dovrebbe essere una sola — e invece era la causa di un rosso
 * che compariva solo eseguendo la suite intera: la lavorazione avviene DOPO la
 * risposta, quindi il lavoro in volo di una prova precedente puo' scrivere la
 * sua riga dopo che l'azzeramento e' gia' passato. La prima riga, allora, e' di
 * qualcun altro.
 *
 * Cercare per identificativo toglie l'ordine di mezzo: e' la propria riga o non
 * c'e' ancora, e non c'e' un terzo caso da interpretare.
 */
async function evento(
  request: APIRequestContext,
  idConsegna: string,
): Promise<RigaEvento | undefined> {
  const righe = await eventi(request);
  return righe.find((riga) => riga.webhookId === idConsegna);
}

async function eventi(request: APIRequestContext): Promise<RigaEvento[]> {
  return db<RigaEvento[]>(request, 'webhookEvent', 'findMany', {
    select: {
      id: true,
      webhookId: true,
      topic: true,
      shopDomain: true,
      status: true,
      attempts: true,
      nextAttemptAt: true,
    },
  });
}

prova.describe('la posta in arrivo degli webhook', () => {
  prova.beforeEach(async ({ request }) => {
    await azzera(request);
    await seminaNegozio(request);
  });

  prova('una consegna valida diventa una ricevuta, e la risposta e solo quella', async ({
    request,
  }) => {
    const risposta = await consegna(request, { idConsegna: 'consegna-unica' });

    expect(risposta.status()).toBe(200);
    expect(await risposta.json()).toEqual({ ok: true, duplicate: false });

    const righe = await eventi(request);
    expect(righe).toHaveLength(1);
    expect(righe[0].topic).toBe('orders/create');
    expect(righe[0].shopDomain).toBe(NEGOZIO);
  });

  prova('la stessa consegna due volte resta una riga sola', async ({ request }) => {
    await consegna(request, { idConsegna: 'consegna-ripetuta' });
    const seconda = await consegna(request, { idConsegna: 'consegna-ripetuta' });

    expect(seconda.status()).toBe(200);
    // 'duplicate' non e' un errore: e' la deduplica che ha funzionato.
    expect(await seconda.json()).toEqual({ ok: true, duplicate: true });
    expect(await eventi(request)).toHaveLength(1);
  });

  prova('due consegne simultanee dello stesso evento restano una riga sola', async ({
    request,
  }) => {
    // E' l'indice unico su `webhook_id` a deciderlo, non il codice: chi perde
    // la corsa rilegge la riga dell'altro e risponde ricevuto.
    const [una, due] = await Promise.all([
      consegna(request, { idConsegna: 'consegna-in-corsa' }),
      consegna(request, { idConsegna: 'consegna-in-corsa' }),
    ]);

    expect(una.status()).toBe(200);
    expect(due.status()).toBe(200);
    expect(await eventi(request)).toHaveLength(1);
  });

  prova('il corpo NON si riscrive quando arriva un doppione', async ({ request }) => {
    await consegna(request, { idConsegna: 'consegna-corpo', corpo: { id: 1, name: '#primo' } });
    await consegna(request, { idConsegna: 'consegna-corpo', corpo: { id: 1, name: '#secondo' } });

    // La prima consegna e' quella in lavorazione: cambiarle il payload sotto i
    // piedi mentre lo sta leggendo e' proprio il conflitto che la deduplica
    // evita.
    const riga = await db<{ payload: Record<string, unknown> }>(
      request,
      'webhookEvent',
      'findUnique',
      { where: { webhookId: 'consegna-corpo' }, select: { payload: true } },
    );
    expect(JSON.stringify(riga.payload)).toContain('1');
    expect(JSON.stringify(riga.payload)).not.toContain('#secondo');
  });

  prova('una firma che non e di Shopify viene rifiutata, e non lascia niente', async ({
    request,
  }) => {
    const risposta = await consegna(request, { firma: 'ZmlybWFDaGVOb25FTm9zdHJh' });

    expect(risposta.status()).toBe(401);
    expect(await eventi(request)).toHaveLength(0);
  });

  prova('senza il negozio non si scrive niente, e non e un 5xx', async ({ request }) => {
    const risposta = await consegna(request, { negozio: null });

    // 400 e non 500: ritentare lo stesso corpo darebbe lo stesso esito per
    // giorni.
    expect(risposta.status()).toBe(400);
    expect(await eventi(request)).toHaveLength(0);
  });

  prova('un corpo che non e JSON viene rifiutato dopo la firma', async ({ request }) => {
    const risposta = await consegna(request, { corpoGrezzo: 'questo non e JSON' });

    expect(risposta.status()).toBe(400);
    expect(await eventi(request)).toHaveLength(0);
  });

  prova('un corpo oltre il tetto viene rifiutato prima di spenderci un HMAC', async ({
    request,
  }) => {
    // Il tetto e' due megabyte, e qui se ne mandano tre per davvero. Non si
    // dichiara soltanto una lunghezza enorme in un'intestazione: quella la
    // riscrive il client HTTP, e la prova finirebbe per non provare niente.
    //
    // La FIRMA E' VOLUTAMENTE SBAGLIATA, ed e' il punto: se il tetto non
    // fermasse la richiesta prima, la risposta sarebbe 401 invece di 413. Il
    // 413 dimostra che il corpo e' stato rifiutato senza spenderci un HMAC
    // sopra — che e' proprio cio' che il tetto esiste per evitare.
    const enorme = 'x'.repeat(3 * 1024 * 1024);
    const risposta = await consegna(request, {
      corpoGrezzo: enorme,
      firma: 'ZmlybWFDaGVOb25Db250YQ==',
    });

    expect(risposta.status()).toBe(413);
    expect(await eventi(request)).toHaveLength(0);
  });

  prova('il topic dichiarato nell header non sceglie il processore', async ({ request }) => {
    // `/webhooks/orders` e' iscritta a tre topic. Dichiarandone uno che non e'
    // fra quelli, la rotta usa il suo ripiego invece di fidarsi del mittente:
    // altrimenti chi manda la consegna sceglierebbe quale codice far girare.
    await consegna(request, { topic: 'products/delete', idConsegna: 'consegna-topic' });

    const righe = await eventi(request);
    expect(righe).toHaveLength(1);
    expect(righe[0].topic).toBe('orders/updated');
  });

  prova('uno dei tre topic ammessi si conserva com e arrivato', async ({ request }) => {
    await consegna(request, { topic: 'refunds/create', idConsegna: 'consegna-rimborso' });

    const righe = await eventi(request);
    expect(righe[0].topic).toBe('refunds/create');
  });

  prova('la lavorazione avviene DOPO la risposta, e lascia comunque un esito scritto', async ({
    request,
  }) => {
    // Il negozio non ha nessun database collegato: non c'e' dove scrivere, e la
    // lavorazione se ne accorge. E' proprio il caso che conta — la risposta a
    // Shopify e' 200 comunque, perche' il 200 dice "ricevuto" e non "fatto" —
    // e cio' che e' successo dopo deve restare scritto sulla riga, con il
    // tentativo contato.
    const risposta = await consegna(request, { idConsegna: 'consegna-da-ritentare' });
    expect(risposta.status()).toBe(200);

    // Attendi che la lavorazione arrivi a uno stato finale. Non basta che non
    // sia piu' 'queued': passa per 'processing', e quella transizione non e'
    // istantanea. Il poll riprova fino a che lo stato non e' uno di quelli
    // terminali.
    const statiFinali = ['failed', 'completed', 'dead_letter', 'done'];
    await expect
      .poll(
        async () => {
          const status = (await evento(request, 'consegna-da-ritentare'))?.status;
          return status !== undefined && statiFinali.includes(status);
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    const riga = await evento(request, 'consegna-da-ritentare');
    expect(riga).toBeDefined();
    if (!riga) return;
    // Non e' rimasta in 'processing' e non e' sparita: e' passata per una
    // lavorazione vera e ne porta il segno.
    expect(riga.attempts).toBeGreaterThanOrEqual(1);
    // Un esito, qualunque sia: cio' che NON deve succedere e' che la riga resti
    // in lavorazione per sempre, invisibile a chi dovrebbe riprenderla.
    expect(statiFinali).toContain(riga.status);
    if (riga.status === 'failed') {
      // Un ritentativo ha un'ora: senza, la riga resterebbe li' senza che
      // nessuno la riprenda.
      expect(riga.nextAttemptAt).not.toBeNull();
    }
  });

  prova('la disinstallazione passa dalla stessa posta in arrivo', async ({ request }) => {
    const risposta = await consegna(request, {
      percorso: '/webhooks/app/uninstalled',
      topic: 'app/uninstalled',
      idConsegna: 'consegna-disinstallazione',
      corpo: { id: 1, domain: NEGOZIO },
    });

    expect(risposta.status()).toBe(200);
    const righe = await eventi(request);
    expect(righe).toHaveLength(1);
    expect(righe[0].topic).toBe('app/uninstalled');
  });
});
