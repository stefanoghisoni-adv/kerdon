import { useCallback, useState } from 'react';
import { useFetcher } from '@remix-run/react';
import { BASE_CURRENCY } from '~/lib/billing/money';
import type { PlanForSuggestion } from './plan-suggestion';

// Parente di `nav-loading.ts` e di `filter-nav.ts`, e nato dallo stesso
// malinteso.
//
// L'invito "Aggiorna a Business" compare in piu' punti della stessa card, e
// finche' erano collegamenti alla tab Piano il loro stato di attesa veniva da
// una sola `useNavLoading('/plan')`: una destinazione condivisa, quindi un
// cerchietto condiviso. Premendone uno partivano tutti, perche' nessuno di loro
// sapeva chi fosse stato premuto — sapevano solo dove stavano andando.
//
// Adesso quei comandi non vanno da nessuna parte: aprono il confronto fra i
// piani. E la cura e' la stessa di allora, non una condizione in piu': ogni
// comando tiene il proprio stato, cosi' due comandi non hanno piu' niente da
// spartire e la domanda "chi e' stato premuto?" non si pone nemmeno.

export interface UpgradeRequestInput {
  /** Questo comando e' stato premuto e non e' ancora stato richiuso. */
  requested: boolean;
  /** Il confronto fra i due piani si puo' gia' mostrare. */
  ready: boolean;
}

export interface UpgradeRequestState {
  /** Il cerchietto accanto al comando premuto. */
  loading: boolean;
  /** Il confronto e' aperto. */
  open: boolean;
}

/**
 * Cosa mostra un comando "Aggiorna a…" premuto.
 *
 * Fra il clic e il confronto c'e' una domanda al server — i due piani a
 * confronto non stanno nella pagina che ospita il comando — quindi l'attesa
 * esiste ed e' giusto che si veda. Ma si vede addosso al comando premuto e a
 * nessun altro: l'attesa e' di chi l'ha chiesta.
 */
export function upgradeRequestState({ requested, ready }: UpgradeRequestInput): UpgradeRequestState {
  if (!requested) return { loading: false, open: false };
  return { loading: !ready, open: ready };
}

/**
 * Il listino e i numeri del negozio, per come li legge il confronto.
 *
 * `totalProducts` e `optIn` possono mancare: sono i "quanti ne hai adesso"
 * accanto ai tetti, un aiuto alla lettura e non il confronto stesso. Il
 * confronto si apre appena si sa quali sono i due piani; se i conteggi arrivano
 * dopo, arrivano dopo.
 */
export interface PlanUpgradeData {
  currentPlan: PlanForSuggestion | null;
  plans: PlanForSuggestion[];
  currency: string;
  totalProducts: number | null;
  optIn: number | null;
}

interface LimitsResponse {
  currentPlan?: PlanForSuggestion | null;
  plans?: PlanForSuggestion[];
  currency?: string;
}

interface ReadinessResponse {
  readyCount: number;
  problemCount: number;
}

interface CustomerStatsResponse {
  optIn?: number;
}

export interface PlanUpgrade extends UpgradeRequestState {
  /** Da chiamare quando si preme il comando. */
  request: () => void;
  /** Da chiamare quando si chiude il confronto. */
  close: () => void;
  data: PlanUpgradeData | null;
}

/**
 * Lo stato di un comando "Aggiorna a…": il suo, e di nessun altro.
 *
 * I dati se li procura qui invece di farseli passare, per la stessa ragione per
 * cui se li procurava l'avviso del tetto prodotti: i punti che invitano ad
 * aggiornare stanno su pagine diverse, e chiedere a ognuna di caricarseli nel
 * proprio loader vorrebbe dire quattro occasioni di mostrare numeri diversi per
 * la stessa cosa.
 *
 * E se li procura al clic, non all'apertura della pagina: sono tre domande al
 * server che nella stragrande maggioranza delle visite nessuno guardera' mai.
 * Chi invece i dati li ha gia' — l'avviso del tetto, che senza non saprebbe
 * nemmeno se comparire — li passa in `preloaded` e non fa chiedere niente a
 * nessuno.
 */
export function usePlanUpgrade(preloaded?: PlanUpgradeData | null): PlanUpgrade {
  const [requested, setRequested] = useState(false);
  const limits = useFetcher<LimitsResponse>();
  const readiness = useFetcher<ReadinessResponse>();
  const customers = useFetcher<CustomerStatsResponse>();

  const request = useCallback(() => {
    setRequested(true);
    if (preloaded) return;
    // `state === 'idle' && !data`: una domanda sola per comando, anche se il
    // merchant chiude e riapre il confronto.
    if (limits.state === 'idle' && !limits.data) limits.load('/api/plan/limits');
    if (readiness.state === 'idle' && !readiness.data) readiness.load('/api/stats/products');
    if (customers.state === 'idle' && !customers.data) customers.load('/api/stats/customers');
  }, [preloaded, limits, readiness, customers]);

  const close = useCallback(() => setRequested(false), []);

  // Il listino comanda: e' l'unica risposta senza la quale non c'e' niente da
  // confrontare. Il tetto prodotti e i clienti con consenso arrivano dallo
  // stesso clic ma da endpoint che possono metterci di piu' — leggono il
  // catalogo — e farli aspettare al confronto vorrebbe dire tenere il merchant
  // davanti a un cerchietto per una cifra fra parentesi.
  const fetched: PlanUpgradeData | null = limits.data
    ? {
        currentPlan: limits.data.currentPlan ?? null,
        plans: limits.data.plans ?? [],
        currency: limits.data.currency ?? BASE_CURRENCY,
        totalProducts: readiness.data
          ? readiness.data.readyCount + readiness.data.problemCount
          : null,
        optIn: customers.data?.optIn ?? null,
      }
    : null;

  const data = preloaded ?? fetched;

  return {
    ...upgradeRequestState({ requested, ready: data != null }),
    request,
    close,
    data,
  };
}
