// e2e/server/fakes/shopify.server.ts
//
// L'admin di Shopify, finto e sotto controllo. Prende il posto di
// `~/shopify.server` nel solo server di prova.
//
// PERCHE' QUESTO E' L'UNICO PEZZO CHE SI FINGE. Tutto il resto delle prove usa
// il codice vero: le rotte sono quelle, il database e' un Postgres vero, la
// firma degli webhook e' verificata davvero. Shopify no, e non per comodita':
// autenticarsi per davvero vorrebbe dire un gettone di sessione firmato dal
// segreto di un'app registrata e uno scambio di gettoni contro i server di
// Shopify. Cioe' credenziali di produzione dentro una prova — che e' la cosa
// che non si fa — oppure un negozio di sviluppo vero, e allora la prova
// smetterebbe di essere ripetibile il giorno in cui quel negozio cambia.
//
// COSA RESTA VERO ANCHE QUI. Il negozio di una richiesta non se lo sceglie
// l'applicazione: arriva da un cookie che la prova ha piantato, esattamente
// come in produzione arriva dal gettone di sessione. Le rotte non sanno da
// dove venga, e non cambiano una riga. E un negozio senza sessione salvata fa
// fallire `unauthenticated.admin` come lo farebbe fallire davvero: e' il ramo
// da cui la callback dell'addebito esce con "non e' andata", ed e' un ramo che
// va provato.

import { stato } from './state';

/** Il cookie con cui la prova dichiara per quale negozio sta parlando. */
export const COOKIE_NEGOZIO = 'e2e_shop';

function negozioDiRichiesta(request: Request): string | null {
  const intestazione = request.headers.get('cookie') ?? '';
  for (const pezzo of intestazione.split(';')) {
    const uguale = pezzo.indexOf('=');
    if (uguale < 0) continue;
    if (pezzo.slice(0, uguale).trim() !== COOKIE_NEGOZIO) continue;
    return decodeURIComponent(pezzo.slice(uguale + 1).trim()) || null;
  }
  return null;
}

/**
 * Il client GraphQL: risponde quello che la prova ha preparato.
 *
 * Senza niente di preparato SOLLEVA, e non restituisce un corpo vuoto. Un finto
 * che risponde "{}" a una query che nessuno aveva previsto fa passare la prova
 * per la strada sbagliata — la rotta legge un abbonamento assente e prende il
 * ramo del rifiuto — e chi legge il verde crede di aver provato l'attivazione.
 * Meglio un errore che dice quale query non era prevista.
 */
function clientGraphQL() {
  return {
    async graphql(query: string): Promise<Response> {
      const s = stato();
      s.graphqlLog.push(query);

      const indice = s.graphql.findIndex((r) => query.includes(r.match));
      if (indice < 0) {
        throw new Error(
          `nessuna risposta preparata per questa query GraphQL: ${query.slice(0, 120)}`,
        );
      }

      const risposta = s.graphql[indice];
      if (risposta.once) s.graphql.splice(indice, 1);

      return new Response(JSON.stringify(risposta.body), {
        status: risposta.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

function sessioneDi(shop: string) {
  return {
    id: `offline_${shop}`,
    shop,
    state: '',
    isOnline: false,
    scope: process.env.SHOPIFY_SCOPES ?? '',
    accessToken: 'gettone-di-prova',
    expires: undefined as Date | undefined,
  };
}

export const authenticate = {
  async admin(request: Request) {
    const shop = negozioDiRichiesta(request);
    if (!shop) {
      // Come in produzione: senza una sessione valida la richiesta non entra
      // nella rotta. E' una Response lanciata, che e' il modo in cui Remix
      // interrompe un loader.
      throw new Response('Unauthorized', { status: 401 });
    }
    return {
      session: sessioneDi(shop),
      admin: clientGraphQL(),
      cors: (response: Response) => response,
      redirect: (url: string) => Response.redirect(url, 302),
    };
  },

  async webhook(request: Request) {
    const shop = request.headers.get('X-Shopify-Shop-Domain') ?? '';
    return {
      shop,
      topic: request.headers.get('X-Shopify-Topic') ?? '',
      session: sessioneDi(shop),
      admin: clientGraphQL(),
      payload: {},
      webhookId: request.headers.get('X-Shopify-Webhook-Id') ?? '',
      apiVersion: '2026-07',
    };
  },
};

export const unauthenticated = {
  async admin(shop: string) {
    if (!stato().sessioni.includes(shop)) {
      throw new Error(`nessuna sessione offline per ${shop}`);
    }
    return { session: sessioneDi(shop), admin: clientGraphQL() };
  },
};

export const apiVersion = '2026-07';
export const addDocumentResponseHeaders = () => {};
export const login = async () => new Response(null, { status: 302 });
export const registerWebhooks = async () => {};
export const sessionStorage = {
  async loadSession() {
    return undefined;
  },
};

export default {
  authenticate,
  unauthenticated,
  addDocumentResponseHeaders,
  login,
  registerWebhooks,
  sessionStorage,
};
