import { describe, it, expect } from 'vitest';
import {
  currentShop,
  sessionTokenOf,
  shopFromSessionToken,
  shopOfRequest,
  withRequestShop,
  withShopInMessage,
} from './request-shop.server';

/** Un gettone di sessione con il `dest` chiesto. La firma non conta: non si verifica. */
function gettone(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.firma-finta`;
}

const DEST = 'https://coreward-demo.myshopify.com';

describe('il negozio dentro il gettone di sessione', () => {
  it('si legge dal campo dest, come nome host', () => {
    expect(shopFromSessionToken(gettone({ dest: DEST }))).toBe('coreward-demo.myshopify.com');
  });

  it('regge un dest gia' + ' senza schema', () => {
    expect(shopFromSessionToken(gettone({ dest: 'negozio.myshopify.com' }))).toBe(
      'negozio.myshopify.com',
    );
  });

  // I gettoni veri sono in base64 con l'alfabeto della URL: se non si rimettono
  // i due caratteri che cambiano, il JSON esce storto ogni tanto — cioe' nel
  // modo peggiore, perche' sembra funzionare.
  it('regge i due caratteri dell alfabeto per URL', () => {
    const con = gettone({ dest: DEST, nota: '???>>>~~~' + 'ÿþ' });
    expect(con).not.toContain('+');
    expect(shopFromSessionToken(con)).toBe('coreward-demo.myshopify.com');
  });

  it('un dominio che non e di Shopify non passa', () => {
    expect(shopFromSessionToken(gettone({ dest: 'https://cattivo.example.com' }))).toBeNull();
    expect(shopFromSessionToken(gettone({ dest: 'https://negozio.myshopify.com.evil.com' }))).toBeNull();
  });

  it('un gettone storto non solleva, restituisce niente', () => {
    expect(shopFromSessionToken(null)).toBeNull();
    expect(shopFromSessionToken('')).toBeNull();
    expect(shopFromSessionToken('non-un-jwt')).toBeNull();
    expect(shopFromSessionToken('a.b.c')).toBeNull();
    expect(shopFromSessionToken(gettone({ senzaDest: 1 }))).toBeNull();
  });
});

describe('da dove si prende il gettone', () => {
  it('dall intestazione, per le chiamate che l app fa da se', () => {
    const req = new Request('https://api.kerdon.io/api/stats/products', {
      headers: { Authorization: `Bearer ${gettone({ dest: DEST })}` },
    });
    expect(sessionTokenOf(req)).toBeTruthy();
    expect(shopOfRequest(req)).toBe('coreward-demo.myshopify.com');
  });

  it('dalla URL, alla prima apertura dentro l admin', () => {
    const req = new Request(`https://api.kerdon.io/?id_token=${gettone({ dest: DEST })}`);
    expect(shopOfRequest(req)).toBe('coreward-demo.myshopify.com');
  });

  // E' il parametro che la libreria guarda gia': leggerlo per primo tiene le due
  // letture d'accordo, invece di far comparire due nomi diversi nello stesso log.
  // Il valore finisce in una riga di log, e una riga di log e' testo: un `shop`
  // con dentro un a capo non sposta un dato, ne SCRIVE UNO NUOVO — una riga
  // inventata con la gravita' che vuole chi l'ha mandata, in mezzo alle nostre.
  it('un parametro shop con dentro un a capo non entra nei log', () => {
    const veleno = 'x.myshopify.com\n[shopify-app/ERROR] cancellazione riuscita';
    const req = new Request(
      `https://api.kerdon.io/?shop=${encodeURIComponent(veleno)}`,
    );
    expect(shopOfRequest(req)).toBeNull();

    withRequestShop(req, () => {
      expect(withShopInMessage('{shop: null}')).toBe('{shop: null}');
    });
  });

  it('un parametro shop che non e di Shopify non entra nei log', () => {
    for (const finto of ['cattivo.example.com', 'negozio.myshopify.com.evil.com', '', ' ']) {
      const req = new Request(`https://api.kerdon.io/?shop=${encodeURIComponent(finto)}`);
      expect(shopOfRequest(req)).toBeNull();
    }
  });

  it('il parametro shop viene prima del gettone', () => {
    const req = new Request('https://api.kerdon.io/?shop=Altro.myshopify.com', {
      headers: { Authorization: `Bearer ${gettone({ dest: DEST })}` },
    });
    expect(shopOfRequest(req)).toBe('altro.myshopify.com');
  });

  it('senza niente da leggere non inventa un negozio', () => {
    expect(shopOfRequest(new Request('https://api.kerdon.io/api/stats/products'))).toBeNull();
  });
});

describe('il negozio nei messaggi', () => {
  const req = new Request('https://api.kerdon.io/api/stats/products', {
    headers: { Authorization: `Bearer ${gettone({ dest: DEST })}` },
  });

  it('rimette il nome dove la libreria scriveva null', () => {
    withRequestShop(req, () => {
      expect(withShopInMessage('Authenticating admin request | {shop: null}')).toBe(
        'Authenticating admin request | {shop: coreward-demo.myshopify.com}',
      );
    });
  });

  it('un messaggio che il negozio ce l ha gia resta com e', () => {
    withRequestShop(req, () => {
      const m = 'Authenticating admin request | {shop: altro.myshopify.com}';
      expect(withShopInMessage(m)).toBe(m);
    });
  });

  it('fuori da una richiesta non cambia niente', () => {
    expect(currentShop()).toBeNull();
    expect(withShopInMessage('{shop: null}')).toBe('{shop: null}');
  });

  // Due richieste in volo insieme non devono vedersi a vicenda: e' la ragione
  // per cui il valore sta nel contesto della chiamata e non in una variabile.
  it('due richieste insieme non si confondono', async () => {
    const altro = new Request('https://api.kerdon.io/?shop=due.myshopify.com');

    await Promise.all([
      withRequestShop(req, async () => {
        await new Promise((r) => setTimeout(r, 5));
        expect(currentShop()).toBe('coreward-demo.myshopify.com');
      }),
      withRequestShop(altro, async () => {
        expect(currentShop()).toBe('due.myshopify.com');
      }),
    ]);
  });
});
