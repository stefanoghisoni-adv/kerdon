/**
 * Quale strada ha scelto il merchant per installare il tracciamento, e dove
 * risponde il suo endpoint.
 *
 * PERCHE' STA DENTRO `platforms` E NON IN COLONNE SUE. Non e' una scelta di
 * disegno: e' un vincolo di adesso. Servirebbero tre colonne su
 * `TrackingSetup` — la strada, l'indirizzo dell'endpoint, il momento in cui la
 * verifica e' passata — e lo schema non si tocca (ci lavora un altro agente).
 * `platforms` e' un array di stringhe che esiste gia' ed e' per negozio: ci si
 * puo' appoggiare senza migrazioni. Il prezzo e' che quell'array porta due cose
 * diverse, e per non confonderle le nostre voci hanno un prefisso riservato che
 * nessun nome di piattaforma potra' mai avere.
 *
 * Il giorno in cui le colonne ci sono, questo file diventa la funzione che
 * legge quelle colonne e i chiamanti non se ne accorgono: e' esattamente per
 * questo che nessuno, fuori di qui, sa come sono fatte le voci.
 *
 * LA VERIFICA STA QUI DENTRO E NON ALTROVE per la ragione opposta a quella per
 * cui sembra strana: il momento in cui il giro si e' chiuso vale per QUELLA
 * strada e per QUEL indirizzo. Cambiare uno dei due la annulla — e lo fa
 * `withInstall`, cosi' nessun chiamante puo' dimenticarsene.
 */

/** Le due strade supportate. Non ce ne sono altre, e non e' un elenco aperto. */
export type InstallPath = 'sgtm' | 'cloudflare';

export const INSTALL_PATHS: InstallPath[] = ['sgtm', 'cloudflare'];

export function isInstallPath(value: unknown): value is InstallPath {
  return value === 'sgtm' || value === 'cloudflare';
}

/** Cosa sappiamo dell'installazione di un negozio. */
export interface InstallState {
  path: InstallPath | null;
  /** L'indirizzo first-party a cui il tag della vetrina chiede l'identificativo. */
  endpoint: string | null;
  /** Quando la verifica e' passata per intero. `null` = mai, o non piu'. */
  verifiedAt: Date | null;
}

export const NO_INSTALL: InstallState = { path: null, endpoint: null, verifiedAt: null };

/**
 * L'indirizzo dell'endpoint, come lo accettiamo.
 *
 * Si normalizza qui e non a valle perche' e' cio' che va confrontato: un
 * indirizzo salvato con lo slash finale e uno senza sono lo stesso endpoint, e
 * se li trattassimo come diversi il salvataggio annullerebbe una verifica
 * appena passata.
 *
 * Solo `https`: su `http` il cookie non puo' essere `Secure`, e un cookie non
 * `Secure` su un dominio di negozio e' un identificativo che viaggia in chiaro.
 * Meglio rifiutarlo qui, dove il merchant lo sta ancora scrivendo, che scoprirlo
 * dalla verifica.
 */
export function normalizeEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.')) return null;

  // Query e frammento si buttano: l'indirizzo e' un punto in cui si chiama, e i
  // parametri li mettiamo noi. Uno scritto a mano dal merchant finirebbe
  // duplicato accanto al nostro, con due valori diversi per la stessa chiave.
  url.search = '';
  url.hash = '';

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * Lo stato dell'installazione, come sta sulla riga.
 *
 * Prende la riga e non tre argomenti sciolti perche' e' cosi' che arriva da
 * Prisma, e perche' i tre valori si leggono sempre insieme: una strada senza
 * indirizzo o un indirizzo senza verifica non dicono niente da soli.
 */
export function readInstallState(
  setup:
    | { installPath?: string | null; endpoint?: string | null; verifiedAt?: Date | null }
    | null
    | undefined,
): InstallState {
  if (!setup) return NO_INSTALL;

  const at = setup.verifiedAt ?? null;
  return {
    path: isInstallPath(setup.installPath) ? setup.installPath : null,
    endpoint: normalizeEndpoint(setup.endpoint),
    // Una data illeggibile vale come nessuna verifica: dire "verificato" per un
    // valore che non sappiamo leggere sarebbe la bugia peggiore fra le due.
    verifiedAt: at && !Number.isNaN(at.getTime()) ? at : null,
  };
}

/** Lo stato nella forma che Prisma vuole per scriverlo. */
export function installStateData(state: InstallState): {
  installPath: string | null;
  endpoint: string | null;
  verifiedAt: Date | null;
} {
  return { installPath: state.path, endpoint: state.endpoint, verifiedAt: state.verifiedAt };
}

/**
 * La scelta del merchant, applicata a quello che c'era.
 *
 * CAMBIARE STRADA O INDIRIZZO ANNULLA LA VERIFICA, sempre. La verifica dice
 * "questo giro si chiude": e' una frase su una configurazione precisa, non un
 * bollino sul negozio. Tenerla dopo un cambio vorrebbe dire dichiarare
 * funzionante un percorso che nessuno ha mai provato — ed e' esattamente il
 * modo in cui un merchant arriva in fondo, vede tutto a posto e non traccia
 * niente.
 */
export function withInstall(
  before: InstallState,
  choice: { path: InstallPath | null; endpoint: string | null },
): InstallState {
  const same = before.path === choice.path && before.endpoint === choice.endpoint;

  return {
    path: choice.path,
    endpoint: choice.endpoint,
    verifiedAt: same ? before.verifiedAt : null,
  };
}

/**
 * La configurazione del tracciamento e' completa.
 *
 * Non basta aver scelto una strada e aver scritto un indirizzo: quelli sono una
 * dichiarazione di intenti. E' completa quando la verifica e' passata, perche'
 * e' l'unica cosa che abbia guardato il giro davvero.
 */
export function isTrackingInstallComplete(state: InstallState): boolean {
  return state.path !== null && state.endpoint !== null && state.verifiedAt !== null;
}
