import type { Dictionary } from '~/lib/i18n/context';
// Stato di autorizzazione di un negozio. Gestito manualmente dall'owner sulla
// tabella `shops` di Supabase, e/o impostato automaticamente (es. trial scaduto
// → PENDING). Il gating è SERVER-SIDE: anche se l'utente riabilita i pulsanti
// nell'HTML, le azioni vengono comunque rifiutate.
//
// Le autorizzazioni sono DUE e indipendenti, su due colonne distinte:
//  - `authorization`          → uso dell'app (dashboard, sincronizzazioni);
//  - `tracking_authorization` → tracciamento (letture dei dati sincronizzati).
// Spegnerne una non spegne l'altra: un negozio sospeso puo' continuare a
// tracciare con gli ultimi dati sincronizzati, e viceversa si puo' fermare il
// solo tracciamento lasciando l'app in funzione. Le funzioni qui sotto valgono
// per entrambe: e' il chiamante a passare la colonna giusta.
export type AuthorizationState = 'ENABLED' | 'PENDING' | 'DISABLED';

export function normalizeAuthorization(value: string | null | undefined): AuthorizationState {
  const v = (value ?? 'ENABLED').toString().trim().toUpperCase();
  if (v === 'DISABLED') return 'DISABLED';
  if (v === 'PENDING') return 'PENDING';
  return 'ENABLED';
}

// True solo se il negozio può usare l'app normalmente.
//
// NON CHIAMARLA PER DECIDERE. Guarda una colonna sola, e una colonna sola non e'
// mai bastata: il negozio puo' aver disinstallato, puo' non avere un database
// collegato, la funzione puo' non essere nel suo piano. Chiedere qui significa
// ricomporre la regola sul posto — che e' esattamente come venti punti dell'app
// erano finiti per dire cose diverse sullo stesso negozio.
// La domanda si fa a `~/lib/authz/capabilities`: `can(caps, 'use_app')`.
// Questa resta perche' `normalizeAuthorization` le sta accanto e i banner della
// dashboard hanno ancora bisogno dello stato per NOMINARLO, non per decidere.
export function isAuthorized(value: string | null | undefined): boolean {
  return normalizeAuthorization(value) === 'ENABLED';
}

// Gate FAIL-CLOSED per l'accesso ai dati: va passata `tracking_authorization`,
// non l'autorizzazione all'uso dell'app.
//
// `normalizeAuthorization` è deliberatamente permissiva: mappa a ENABLED tutto
// ciò che non riconosce, così la UI non si blocca su valori nulli o legacy.
// Sul percorso dati quel comportamento è però un bypass: la colonna è
// editata a mano dall'owner su Supabase, e un refuso ("DISABLD", "BANNED") concederebbe
// silenziosamente l'accesso proprio allo shop che si voleva bloccare.
// Qui l'unico valore che concede accesso è l'esatto ENABLED: qualsiasi altra
// cosa — inclusa una stringa sconosciuta — nega.
//
// NON CHIAMARLA PER DECIDERE, per la stessa ragione di `isAuthorized`: la
// severita' su questa colonna e' giusta ma non e' tutta la regola — un negozio
// che ha disinstallato l'app non la spegne, e con la sola colonna in mano
// passava. La lettura si chiede con `can(caps, 'use_read_proxy')`, che questa
// severita' se la porta dentro insieme al resto.
export function grantsDataAccess(value: string | null | undefined): boolean {
  return (value ?? '').trim().toUpperCase() === 'ENABLED';
}

// Messaggio utente per lo stato di blocco dell'USO DELL'APP (risposte d'errore
// lato server). Del tracciamento non parla: e' un'altra autorizzazione, e i
// banner della dashboard la raccontano a parte (authorization-banners.ts).
export function authorizationMessage(
  state: AuthorizationState,
  t: Pick<Dictionary, 'errors'>,
): string {
  if (state === 'DISABLED') return t.errors.appDisabled;
  if (state === 'PENDING') return t.errors.trialEnded;
  return '';
}
