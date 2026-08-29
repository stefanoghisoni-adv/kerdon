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
const cache = new Map<string, { result: ReadContextResult; expiresAt: number }>();

export function clearReadContextCache(): void {
  cache.clear();
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

  const result = await loadReadContext(hash);

  // I token sconosciuti NON entrano in cache: sono il caso che un chiamante
  // ostile può generare a volontà, e cacharli lo lascerebbe riempire la Map.
  // Sono anche l'unico esito che non risparmia lavoro utile se ripetuto.
  if (result.kind !== 'unknown') {
    prune(now);
    cache.set(hash, { result, expiresAt: now + TTL_MS });
  }
  return result;
}

async function loadReadContext(hash: string): Promise<ReadContextResult> {
  const shop = await prisma.shop.findUnique({
    where: { readProxyTokenHash: hash },
    include: { supabaseConfig: true },
  });
  if (!shop) return { kind: 'unknown' };

  const config = shop.supabaseConfig;
  if (!config?.supabaseProjectRef || !config.supabaseServiceRoleKey) {
    return { kind: 'not_configured' };
  }

  let serviceRoleKey: string;
  try {
    serviceRoleKey = decrypt(config.supabaseServiceRoleKey);
  } catch {
    return { kind: 'not_configured' };
  }

  const plan = await findPlanByName(shop.currentPlan);

  return {
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
  };
}
