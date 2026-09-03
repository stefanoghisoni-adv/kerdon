import { prisma } from '~/db.server';
import { encrypt } from '~/utils/crypto.server';
import { freePlanName } from '~/lib/billing/find-plan.server';

// Sottoinsieme minimo della sessione Shopify che ci serve per materializzare
// il record shop. Evita l'accoppiamento diretto col tipo Session di Shopify.
interface ShopSession {
  shop: string;
  accessToken?: string;
  scope?: string;
}

// Dati di creazione di un nuovo shop a partire dalla sessione Shopify.
// Condiviso tra l'hook afterAuth e il self-heal dei loader.
//
// Il piano iniziale si legge dal listino invece di scriverlo qui: e' lo stesso
// nome che sta in plans.plan_name, quindi rinominare un piano non lascia piu'
// indietro i negozi nuovi. Sul database owner c'e' anche una foreign key che
// rifiuta un nome fuori dal listino.
export async function shopCreateData(session: ShopSession) {
  return {
    shopDomain: session.shop,
    accessToken: encrypt(session.accessToken ?? ''),
    scopes: session.scope ?? '',
    currentPlan: await freePlanName(),
    isInTrial: true,
    trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    installedAt: new Date(),
  };
}

/**
 * I permessi concessi, riallineati a quelli che il negozio ci sta dando adesso.
 *
 * `shops.scopes` si scriveva in due soli momenti: alla creazione della riga e
 * nel callback OAuth. Bastava che i permessi cambiassero dopo — l'app ne chiede
 * di nuovi, il merchant li concede, e con l'autenticazione embedded quel giro
 * non ripassa da `afterAuth` — perche' la nostra copia restasse indietro per
 * sempre.
 *
 * Non e' un dettaglio contabile: da quella colonna si decide cosa l'app puo'
 * fare. Con gli ordini concessi su Shopify ma non ancora scritti qui, il
 * profitto, il margine, i prodotti piu' venduti e la tab Clienti si spengono
 * tutti insieme dicendo che il permesso manca — e il merchant, che su Shopify
 * lo vede concesso, non ha modo di capire cosa deve fare.
 *
 * La sessione porta sempre i permessi veri di adesso: se differiscono, si
 * riscrivono. Costa una scrittura la prima volta dopo un cambio e nessuna in
 * tutte le altre, perche' da li' in poi i due valori coincidono.
 *
 * Si confronta l'insieme, non la stringa: Shopify non garantisce un ordine, e
 * confrontare "a,b" con "b,a" avrebbe prodotto una scrittura a ogni apertura
 * della dashboard.
 */
async function refreshScopes<T extends { id: string; scopes: string | null }>(
  shop: T,
  session: ShopSession,
): Promise<T> {
  const granted = session.scope?.trim();
  if (!granted) return shop;

  const asSet = (value: string | null | undefined) =>
    new Set(
      (value ?? '')
        .split(',')
        .map((scope) => scope.trim().toLowerCase())
        .filter(Boolean),
    );

  const now = asSet(granted);
  const saved = asSet(shop.scopes);
  const uguali = now.size === saved.size && [...now].every((scope) => saved.has(scope));
  if (uguali) return shop;

  console.log(
    `[shop] permessi riallineati per ${session.shop}: da "${shop.scopes ?? ''}" a "${granted}"`,
  );
  await prisma.shop.update({ where: { id: shop.id }, data: { scopes: granted } });
  return { ...shop, scopes: granted };
}

// Ritorna lo shop della sessione corrente, creandolo se manca (self-heal).
// Una sessione valida senza riga shop — reinstallazione, cancellazione manuale
// del record, o race durante l'embedded auth prima che afterAuth completi — non
// deve mandare l'app in 404: il record viene materializzato al volo.
export async function getOrCreateShop(session: ShopSession) {
  // Percorso veloce: una SELECT. L'upsert incondizionato costava una write
  // transaction sul primario a OGNI apertura della dashboard, solo per leggere.
  // La scrittura ora avviene solo quando lo shop manca davvero (primo accesso
  // dopo l'installazione o self-heal), cioè quasi mai.
  const existing = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { supabaseConfig: true },
  });
  if (existing) return refreshScopes(existing, session);

  // Resta un upsert (non un create): se afterAuth ha materializzato lo shop tra
  // la SELECT e questa riga, la corsa si risolve senza violare l'unique.
  return prisma.shop.upsert({
    where: { shopDomain: session.shop },
    create: await shopCreateData(session),
    update: {},
    include: { supabaseConfig: true },
  });
}
