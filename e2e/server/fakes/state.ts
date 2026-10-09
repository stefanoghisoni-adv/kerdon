// e2e/server/fakes/state.ts
//
// Quello che i finti devono rispondere, deciso dalla prova che sta girando.
//
// PERCHE' STA SU globalThis E NON IN UN MODULO NORMALE. I finti vengono
// caricati da Vite, dentro il suo grafo dei moduli; il pannello di comando che
// li imposta vive nel processo del server, fuori da quel grafo. Sono due
// istanze diverse dello stesso file, e una variabile di modulo ne avrebbe una
// per parte: la prova scriverebbe in un oggetto e il finto ne leggerebbe un
// altro, sempre vuoto. Appoggiandola all'oggetto globale, che di istanze ne ha
// una sola, i due si parlano davvero.
//
// NON C'E' NESSUNA CREDENZIALE QUI DENTRO, e non ce ne possono finire: questi
// oggetti li riempie la prova che sta girando, con valori che si e' inventata.

/** Una risposta preparata per una chiamata GraphQL all'admin di Shopify. */
export interface RispostaGraphQL {
  /** Un pezzo di testo che deve comparire nella query: la prima che combacia vince. */
  match: string;
  status?: number;
  body: unknown;
  /** Vale per una chiamata sola, poi si consuma. Serve a provare i ritentativi. */
  once?: boolean;
}

/** L'esito che il finto di Supabase deve restituire alla prossima eliminazione. */
export interface EsitoEliminazione {
  status: 'completed' | 'nothing_owned' | 'already_running' | 'failed';
  attempted?: string[];
  remaining?: string[];
  retryable?: boolean;
  error?: string;
}

/** Un profilo Klaviyo come lo restituisce `GET /api/profiles` (formato JSON:API). */
export interface ProfiloKlaviyo {
  id: string;
  attributes: {
    email?: string | null;
    phone_number?: string | null;
    external_id?: string | null;
    location?: { country?: string | null } | null;
    properties?: Record<string, unknown>;
  };
}

/** Un'autorizzazione concessa dalla pagina finta di Klaviyo, in attesa dello scambio. */
export interface CodiceKlaviyo {
  challenge: string;
  redirectUri: string;
}

/** Quello che Klaviyo finto sa e ha visto. */
export interface StatoKlaviyo {
  /** I profili dell'account collegato, nell'ordine in cui le pagine li restituiscono. */
  profili: ProfiloKlaviyo[];
  /** Il nome dell'organizzazione, che `GET /api/accounts` restituisce. */
  nomeAccount: string;
  /**
   * Quanti profili per pagina, al massimo. L'app chiede pagine da 100: un tetto
   * piu' basso obbliga l'import a seguire `links.next`, che e' la parte da provare.
   */
  dimensionePagina: number;
  codici: Record<string, CodiceKlaviyo>;
  /** I gettoni emessi: Klaviyo finto risponde solo a chi ne presenta uno. */
  gettoni: string[];
  /** Ogni richiesta arrivata, metodo e percorso: dice anche cosa NON e' stato chiesto. */
  richieste: string[];
}

/** Una chiamata all'Admin GraphQL di Shopify fatta via HTTP, con le sue variabili. */
export interface ChiamataAdmin {
  query: string;
  variables: unknown;
}

export interface StatoFinti {
  graphql: RispostaGraphQL[];
  /** Le query arrivate, per poter dire NON SOLO cosa e' tornato ma cosa e' stato chiesto. */
  graphqlLog: string[];
  /** I negozi per cui esiste una sessione offline. Gli altri fanno fallire `unauthenticated`. */
  sessioni: string[];
  eliminazione: EsitoEliminazione;
  /** Quante volte l'eliminazione e' stata chiesta: serve a provare che il 409 non ripete niente. */
  eliminazioniChieste: number;
  klaviyo: StatoKlaviyo;
  /**
   * Le chiamate GraphQL arrivate via HTTP (`ShopifyAPIClient`), con le variabili:
   * per una scrittura conta il valore mandato, non solo che sia partita.
   */
  adminLog: ChiamataAdmin[];
  /** Il database del merchant: tabella → righe. Lo legge il finto di PostgREST. */
  databaseMerchant: Record<string, Array<Record<string, unknown>>>;
}

const CHIAVE = '__kerdon_e2e_fakes__';

function vuoto(): StatoFinti {
  return {
    graphql: [],
    graphqlLog: [],
    sessioni: [],
    eliminazione: { status: 'nothing_owned' },
    eliminazioniChieste: 0,
    klaviyo: {
      profili: [],
      nomeAccount: 'Account di prova',
      dimensionePagina: 100,
      codici: {},
      gettoni: [],
      richieste: [],
    },
    adminLog: [],
    databaseMerchant: {},
  };
}

/** Lo stato condiviso, creato al primo accesso da qualunque delle due parti. */
export function stato(): StatoFinti {
  const globale = globalThis as unknown as Record<string, StatoFinti | undefined>;
  return (globale[CHIAVE] ??= vuoto());
}

/** Rimette i finti a zero: e' cio' che fa l'azzeramento fra due prove. */
export function resetFinti(): void {
  const globale = globalThis as unknown as Record<string, StatoFinti | undefined>;
  globale[CHIAVE] = vuoto();
}
