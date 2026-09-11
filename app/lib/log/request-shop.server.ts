// app/lib/log/request-shop.server.ts
//
// Quale negozio sta facendo la richiesta, per chi scrive nei log.
//
// IL PROBLEMA. La libreria di Shopify scrive "Authenticating admin request |
// {shop: null}" a ogni richiesta autenticata, e quel null non e' un guasto: il
// suo helper legge il dominio SOLO dal parametro `?shop=` nella URL, e le
// chiamate che l'app fa da sola — le card della dashboard, le statistiche, i
// limiti del piano — non ce l'hanno. Si autenticano con il gettone di sessione
// nell'intestazione, dove il dominio c'e' ma la libreria non lo cerca.
//
// Finche' il negozio e' uno solo la riga e' inutile; con dieci merchant sarebbe
// peggio che inutile, perche' un log di errori senza il negozio non si puo'
// leggere — ed e' esattamente la riga che si va a cercare quando qualcosa non
// va.
//
// LA SOLUZIONE. Il gettone di sessione e' un JWT, e il dominio sta nel suo
// campo `dest`. Lo si legge all'ingresso di `authenticate.admin`, lo si tiene
// per la durata di quella richiesta, e chi scrive un log lo trova.
//
// NON SI VERIFICA LA FIRMA, di proposito, ed e' sicuro perche' questo valore
// NON autorizza niente: serve a scrivere una parola in una riga di log. A
// verificare il gettone ci pensa la libreria un istante dopo, ed e' quella
// verifica a decidere se la richiesta passa. Un gettone falsificato qui
// otterrebbe una cosa sola: un nome sbagliato in un log, e la richiesta
// rifiutata lo stesso.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string | null>();

/**
 * Il dominio dentro un gettone di sessione, senza verificarne la firma.
 *
 * `dest` e' un indirizzo intero (`https://negozio.myshopify.com`): si tiene il
 * solo nome host, che e' cio' che compare ovunque altrove nei log.
 */
export function shopFromSessionToken(token: string | null | undefined): string | null {
  if (!token) return null;

  const parti = token.split('.');
  if (parti.length !== 3) return null;

  try {
    // Base64 con l'alfabeto della URL: i due caratteri che cambiano vanno
    // rimessi prima di decodificare, altrimenti il JSON esce storto proprio sui
    // gettoni che li contengono — cioe' non sempre, ma una volta ogni tanto.
    const payload = Buffer.from(
      parti[1].replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');

    const dest = (JSON.parse(payload) as { dest?: unknown }).dest;
    if (typeof dest !== 'string') return null;

    const host = dest.startsWith('http') ? new URL(dest).hostname : dest;
    // Solo domini di Shopify: qui dentro non deve poter entrare un valore
    // qualsiasi preso da un gettone che nessuno ha verificato.
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(host) ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Il gettone di sessione di una richiesta, e da dove puo' arrivare.
 *
 * Nell'intestazione per le chiamate che l'app fa da se', nella URL alla prima
 * apertura dentro l'admin: sono due momenti della stessa sessione, e si
 * guardano tutti e due.
 */
export function sessionTokenOf(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }

  try {
    return new URL(request.url).searchParams.get('id_token');
  } catch {
    return null;
  }
}

/** Il negozio di questa richiesta, se qualcuno l'ha messo. */
export function currentShop(): string | null {
  return storage.getStore() ?? null;
}

/**
 * Da dove viene il negozio di una richiesta.
 *
 * Prima il parametro nella URL, che e' quello che la libreria guarda gia' e che
 * quindi tiene le due letture d'accordo; poi il gettone, che e' l'unico posto
 * dove il dominio esiste per le chiamate interne.
 */
export function shopOfRequest(request: Request): string | null {
  try {
    const fromUrl = new URL(request.url).searchParams.get('shop');
    if (fromUrl) return fromUrl.toLowerCase();
  } catch {
    // Una URL illeggibile non e' una ragione per non loggare: si prova col
    // gettone, che sta nell'intestazione e non c'entra con la URL.
  }

  return shopFromSessionToken(sessionTokenOf(request));
}

/** Esegue `fn` sapendo di quale negozio si sta parlando. */
export function withRequestShop<T>(request: Request, fn: () => T): T {
  return storage.run(shopOfRequest(request), fn);
}

/**
 * Rimette il negozio nei messaggi della libreria che escono senza.
 *
 * Si riscrive il testo invece di zittire la riga: quel messaggio segna l'inizio
 * di ogni richiesta autenticata, ed e' il riferimento da cui si contano i tempi
 * quando si guarda perche' qualcosa e' lento.
 */
export function withShopInMessage(message: string): string {
  const shop = currentShop();
  if (!shop) return message;
  return message.replace('{shop: null}', `{shop: ${shop}}`);
}
