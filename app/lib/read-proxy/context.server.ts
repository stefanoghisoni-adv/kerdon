import { prisma } from '~/db.server';
import { decrypt } from '~/utils/crypto.server';
import { normalizeAuthorization, type AuthorizationState } from '~/utils/authorization.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilitiesWithPlan } from '~/lib/authz/shop-capabilities.server';
import { hashReadProxyToken } from './token.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';

export interface ShopReadContext {
  shopId: string;
  // Stato normalizzato del TRACCIAMENTO — non quello dell'uso dell'app: qui si
  // decide se le letture passano, e le due autorizzazioni sono indipendenti.
  // Per messaggi e diagnostica. NON usarlo come gate.
  trackingAuthorization: AuthorizationState;
  // Unico gate valido per l'accesso ai dati: la risposta della policy alla
  // capacita' `use_read_proxy`, fail-closed.
  canReadData: boolean;
  projectRef: string;
  serviceRoleKey: string;
  customersEnabled: boolean;
}

export type ReadContextResult =
  | { kind: 'unknown' }
  | { kind: 'not_configured' }
  | { kind: 'ok'; ctx: ShopReadContext };

// Cache per-istanza: evita un round-trip al DB owner ad ogni lettura di
// tracciamento. TTL 30s = finestra massima di obsolescenza dello stato shop.
const TTL_MS = 30_000;
// Tetto alla dimensione: questo è l'unico endpoint pubblico dell'app e la
// chiave della cache deriva da un token fornito dal chiamante. Senza tetto,
// una raffica di token casuali farebbe crescere la Map senza limite su
// un'istanza di lunga durata.
const MAX_ENTRIES = 500;
const cache = new Map<
  string,
  {
    result: ReadContextResult;
    expiresAt: number;
    /** Di chi e' questa riga: i due modi in cui un negozio si nomina. */
    shopId: string | null;
    shopDomain: string | null;
  }
>();

export function clearReadContextCache(): void {
  cache.clear();
}

/**
 * Butta via quel che si sapeva di questo negozio.
 *
 * Nella cache non c'e' una copia dei dati: c'e' una DECISIONE — `canReadData` —
 * presa quando la riga e' entrata. Da chiamare quando cambia uno dei fatti da
 * cui quella decisione e' uscita: la prova che scade, l'app disinstallata, le
 * due colonne dell'autorizzazione, il piano. Senza, per una finestra di trenta
 * secondi il proxy continua a rispondere a un negozio che nel frattempo e'
 * stato fermato — e trenta secondi su un endpoint pubblico non sono pochi.
 *
 * Il negozio puo' avere piu' di una riga (il token e' cambiato, e la vecchia e'
 * ancora in cache): si tolgono tutte.
 */
export function invalidateReadContextForShop(shopId: string): void {
  dimentica((entry) => entry.shopId === shopId);
}

/**
 * Come sopra, per chi del negozio ha solo il dominio.
 *
 * E' il caso della disinstallazione: il webhook di Shopify porta il dominio e
 * niente altro, e andare a leggere l'id costerebbe una query in piu' proprio
 * nel momento in cui non serve a nient'altro.
 */
export function invalidateReadContextForDomain(shopDomain: string): void {
  dimentica((entry) => entry.shopDomain === shopDomain);
}

function dimentica(
  riguarda: (entry: { shopId: string | null; shopDomain: string | null }) => boolean,
): void {
  for (const [key, entry] of cache) {
    if (riguarda(entry)) cache.delete(key);
  }
}

// Rimuove le entry scadute; se non basta, sfratta le più vecchie (la Map
// itera in ordine di inserimento).
function prune(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export async function resolveShopReadContext(token: string): Promise<ReadContextResult> {
  const hash = hashReadProxyToken(token);
  const now = Date.now();
  const cached = cache.get(hash);
  if (cached && cached.expiresAt > now) return cached.result;

  const { result, shopId, shopDomain, trialEndsAt } = await loadReadContext(hash);

  // I token sconosciuti NON entrano in cache: sono il caso che un chiamante
  // ostile può generare a volontà, e cacharli lo lascerebbe riempire la Map.
  // Sono anche l'unico esito che non risparmia lavoro utile se ripetuto.
  if (result.kind !== 'unknown') {
    prune(now);
    cache.set(hash, {
      result,
      expiresAt: expiryFor(now, trialEndsAt),
      shopId,
      shopDomain,
    });
  }
  return result;
}

/**
 * Fino a quando questa risposta si puo' riusare.
 *
 * Di norma i trenta secondi soliti, ma mai oltre la fine della prova: dentro la
 * riga c'e' un "puo' leggere" gia' deciso, e una prova che finisce fra cinque
 * secondi lo renderebbe falso mentre la cache lo ripete ancora per venticinque.
 * E' l'unica scadenza che si sa in anticipo, quindi e' anche l'unica che non ha
 * bisogno di nessuno che venga ad avvisare.
 */
function expiryFor(now: number, trialEndsAt: Date | null): number {
  const standard = now + TTL_MS;
  const trialEnd = trialEndsAt?.getTime();
  if (trialEnd == null || trialEnd <= now) return standard;
  return Math.min(standard, trialEnd);
}

/** L'esito, e i due fatti che servono a decidere quanto tenerlo. */
interface LoadedContext {
  result: ReadContextResult;
  /** Di chi e' la riga, per poterla buttare quando quel negozio cambia. */
  shopId: string | null;
  shopDomain: string | null;
  trialEndsAt: Date | null;
}

async function loadReadContext(hash: string): Promise<LoadedContext> {
  const shop = await prisma.shop.findUnique({
    where: { readProxyTokenHash: hash },
    include: { supabaseConfig: true },
  });
  if (!shop) {
    return { result: { kind: 'unknown' }, shopId: null, shopDomain: null, trialEndsAt: null };
  }

  // Da qui in giu' il negozio si conosce: qualunque esito, la riga porta il suo
  // id e la sua scadenza, cosi' la si puo' buttare quando quel negozio cambia.
  const conosciuto = {
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    trialEndsAt: shop.trialEndsAt,
  };

  const config = shop.supabaseConfig;
  if (!config?.supabaseProjectRef || !config.supabaseServiceRoleKey) {
    return { result: { kind: 'not_configured' }, ...conosciuto };
  }

  let serviceRoleKey: string;
  try {
    serviceRoleKey = decrypt(config.supabaseServiceRoleKey);
  } catch {
    return { result: { kind: 'not_configured' }, ...conosciuto };
  }

  const plan = await findPlanByName(shop.currentPlan);

  return {
    ...conosciuto,
    result: {
      kind: 'ok',
      ctx: {
        shopId: shop.id,
        // Il tracciamento ha la sua autorizzazione: un negozio con l'app sospesa
        // puo' continuare a leggere i dati gia' sincronizzati.
        trackingAuthorization: normalizeAuthorization(shop.trackingAuthorization),
        // La decisione non si compone piu' qui.
        //
        // Guardare la sola colonna del tracciamento bastava a fermare chi era
        // stato sospeso, ma non chi se n'era andato: l'app disinstallata non
        // spegne quella colonna — spegne l'app — e il token di lettura, che nella
        // vetrina resta incollato nel container del merchant, continuava a
        // rispondere. Un negozio che aveva chiuso con noi seguitava a farsi
        // servire i propri clienti da questa rotta, a tempo indeterminato.
        // `use_read_proxy` tiene insieme le tre condizioni che contano qui, e le
        // tiene nello stesso posto di tutte le altre.
        canReadData: can(shopCapabilitiesWithPlan(shop, plan), 'use_read_proxy'),
        projectRef: config.supabaseProjectRef,
        serviceRoleKey,
        customersEnabled: plan?.customersSyncEnabled ?? false,
      },
    },
  };
}
