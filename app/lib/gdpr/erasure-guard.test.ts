import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('~/lib/read-proxy/context.server', () => ({
  invalidateReadContextForShop: vi.fn(),
  invalidateReadContextForDomain: vi.fn(),
}));

import { prisma } from '~/db.server';
import {
  invalidateReadContextForDomain,
  invalidateReadContextForShop,
} from '~/lib/read-proxy/context.server';
import {
  ShopErasureInProgressError,
  assertShopWritable,
  beginShopErasure,
  isErasing,
} from './erasure-guard.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Il gesto che chiude un negozio alle scritture.
 *
 * Quello che difende: fra l'inizio di `shop/redact` e la sua fine passa del
 * tempo, e in quel tempo l'app continuerebbe a lavorare come se niente fosse —
 * una sincronizzazione avviata un minuto prima, una notifica di Shopify appena
 * arrivata, il proxy di lettura con la chiave di servizio ancora in cache. Ogni
 * scrittura di quelle, presa da sola, e' corretta. Insieme fanno una
 * cancellazione che non cancella.
 */

const SHOP_ID = 'shop-1';
const SHOP_DOMAIN = 'negozio.myshopify.com';

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.shop.update as any).mockResolvedValue({ erasureGeneration: 4 });
  (prisma.shop.findUnique as any).mockResolvedValue({
    lifecycleStatus: 'active',
    erasureGeneration: 3,
  });
});

describe('marcare l inizio della cancellazione', () => {
  it('scrive lo stato e alza il gettone nella stessa istruzione', async () => {
    const generazione = await beginShopErasure(SHOP_ID, SHOP_DOMAIN);

    expect(generazione).toBe(4);
    const args = (prisma.shop.update as any).mock.calls[0][0];
    expect(args.where).toEqual({ id: SHOP_ID });
    expect(args.data.lifecycleStatus).toBe('erasing');
    expect(args.data.erasureGeneration).toEqual({ increment: 1 });
  });

  /**
   * LA RIGA CHE VALE PIU' DI TUTTE QUI DENTRO. La cache del proxy non tiene
   * una copia dei dati: tiene una DECISIONE gia' presa — "puo' leggere" — e la
   * chiave di servizio del merchant in chiaro accanto. Senza svuotarla, per una
   * finestra di trenta secondi il proxy continuerebbe a servire i clienti di un
   * negozio la cui cancellazione e' gia' cominciata, con una chiave che stiamo
   * per revocare.
   */
  it('butta via quel che le cache si ricordavano del negozio', async () => {
    await beginShopErasure(SHOP_ID, SHOP_DOMAIN);

    expect(invalidateReadContextForShop).toHaveBeenCalledWith(SHOP_ID);
    // Anche per dominio: il negozio si nomina in due modi, e la riga in cache
    // puo' essere entrata con l'uno o con l'altro.
    expect(invalidateReadContextForDomain).toHaveBeenCalledWith(SHOP_DOMAIN);
  });

  it('se la scrittura non riesce, solleva: non si comincia a cancellare', async () => {
    (prisma.shop.update as any).mockRejectedValue(new Error('connessione persa'));

    await expect(beginShopErasure(SHOP_ID, SHOP_DOMAIN)).rejects.toThrow('connessione persa');
  });
});

describe('la verifica prima di una scrittura', () => {
  it('passa su un negozio vivo con il gettone che ci si aspetta', async () => {
    await expect(assertShopWritable(SHOP_ID, 3)).resolves.toBeUndefined();
  });

  it('nega quando la cancellazione e gia cominciata', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue({
      lifecycleStatus: 'erasing',
      erasureGeneration: 3,
    });

    await expect(assertShopWritable(SHOP_ID, 3)).rejects.toBeInstanceOf(
      ShopErasureInProgressError,
    );
  });

  /**
   * IL CASO DELLA CORSA PARTITA PRIMA. La sincronizzazione era gia' in volo
   * quando la cancellazione e' cominciata ed e' finita: adesso il negozio non
   * e' piu' 'erasing' — non c'e' piu' affatto, o e' stato ricreato — ma il
   * gettone e' andato avanti, e quel numero e' l'unica cosa che dice a questa
   * corsa che il mondo e' cambiato sotto di lei.
   */
  it('nega quando il gettone e cambiato durante il lavoro', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue({
      lifecycleStatus: 'active',
      erasureGeneration: 4,
    });

    await expect(assertShopWritable(SHOP_ID, 3)).rejects.toThrow(/gettone cambiato/);
  });

  it('nega quando la riga del negozio non c e piu', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue(null);

    await expect(assertShopWritable(SHOP_ID, 3)).rejects.toBeInstanceOf(
      ShopErasureInProgressError,
    );
  });

  /**
   * Chi non aveva un gettone da confrontare — un chiamante che non lo tiene —
   * ottiene comunque il controllo sullo stato, che e' quello che conta di piu':
   * la generazione serve a chi era gia' partito, lo stato a chiunque.
   */
  it('senza gettone atteso controlla comunque lo stato', async () => {
    await expect(assertShopWritable(SHOP_ID, null)).resolves.toBeUndefined();

    (prisma.shop.findUnique as any).mockResolvedValue({
      lifecycleStatus: 'erasing',
      erasureGeneration: 99,
    });
    await expect(assertShopWritable(SHOP_ID, null)).rejects.toBeInstanceOf(
      ShopErasureInProgressError,
    );
  });
});

describe('leggere lo stato', () => {
  it('riconosce il solo valore esatto', () => {
    expect(isErasing('erasing')).toBe(true);
    expect(isErasing(' erasing ')).toBe(true);
    expect(isErasing('active')).toBe(false);
    expect(isErasing(null)).toBe(false);
    expect(isErasing(undefined)).toBe(false);
    // In dubbio NON si nega, qui: un valore mai visto non e' 'erasing', e
    // trattarlo come tale spegnerebbe ogni negozio la cui colonna fosse scritta
    // male — un danno molto piu' grande di quello che si eviterebbe.
    expect(isErasing('ERASING')).toBe(false);
  });
});
