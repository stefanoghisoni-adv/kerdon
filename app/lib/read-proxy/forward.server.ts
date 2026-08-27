import type { ShopReadContext } from './context.server';

// products sempre; customers solo se il piano include la sync clienti.
export function allowedReadTables(customersEnabled: boolean): string[] {
  return customersEnabled ? ['products', 'customers'] : ['products'];
}

// Elenco ESPLICITO delle risorse che si possono embeddare dentro un `select`.
//
// Prima qui c'era l'elenco opposto — i divieti — e valeva solo per le due
// tabelle che gestiamo noi: tutto il resto del progetto passava. Ma noi
// inoltriamo con la service_role, che non vede le RLS, quindi "tabella del
// merchant" non vuol dire "tabella che non ci riguarda": vuol dire tabella che
// stiamo leggendo per conto di chiunque abbia il token. Un elenco di divieti su
// una superficie che non conosciamo (lo schema del merchant, con le sue chiavi
// esterne e le sue viste) e' incompleto per costruzione, e ogni tabella che il
// merchant aggiunge domani lo rende un po' piu' incompleto.
//
// Oggi l'elenco e' vuoto, e non e' una dimenticanza: le uniche tabelle che il
// proxy serve sono products e customers, non hanno chiavi esterne fra loro, e
// nessun uso legittimo del tracciamento embedda niente. customers in
// particolare non potra' mai entrarci, perche' il consenso marketing e'
// applicato solo al livello top e un customers embeddato scavalcherebbe il
// gate. Se un giorno servisse una relazione, si aggiunge qui il nome — dopo
// aver deciso come farci passare sopra i controlli di piano e di consenso.
const ALLOWED_EMBED_TABLES: readonly string[] = [];

export function allowedEmbedTables(): readonly string[] {
  return ALLOWED_EMBED_TABLES;
}

// Funzioni di aggregazione PostgREST: nel `select` si scrivono come `count()` o
// `price.sum()`, cioe' con le parentesi VUOTE. Gli embedding hanno sempre
// parentesi piene (devono elencare almeno una colonna). E' l'unico modo per non
// scambiare un aggregato — uso legittimo — per una risorsa collegata; qualunque
// altro nome con parentesi vuote non lo sappiamo classificare e si nega.
const AGGREGATE_FUNCTIONS = ['count', 'sum', 'avg', 'max', 'min'];

// Caratteri che ci aspettiamo in un `select` legittimo: identificatori, alias
// (`:`), hint di join (`!`), spread e cast (`.`, `:`), percorsi JSON (`->`),
// aggregati e embedding (`(`, `)`), separatori. Tutto il resto — virgolette su
// tutte, che permetterebbero identificatori arbitrari che il nostro
// riconoscitore non vedrebbe — rende la stringa non interpretabile con
// certezza, e allora si nega.
const SELECT_SAFE_CHARS = /^[A-Za-z0-9_,:*()!.\->\s]*$/;

// Nome della risorsa embeddata seguito dalla parentesi, tollerando alias
// (`alias:customers(...)`), spread (`...customers(...)`) e hint di join
// (`customers!inner(...)`). L'alias non viene catturato perche' cerchiamo
// sempre l'identificatore ATTACCATO alla parentesi.
const EMBED_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)(?:!\s*[A-Za-z0-9_]+)?\s*\(/g;

// Parametri che allargano la lettura oltre la tabella richiesta o che su una
// lettura non vogliono dire niente. `columns` e `on_conflict` esistono solo per
// le scritture: su una GET sono rumore, e rumore che non sappiamo interpretare
// si nega invece di inoltrarlo.
const FORBIDDEN_PARAMS = ['columns', 'on_conflict'];

// Gli unici nomi di parametro con un punto che sono legittimi al livello top:
// la negazione degli operatori logici. Ogni altro punto nel NOME di un
// parametro e' un riferimento a una risorsa collegata (`orders.limit=1`,
// `customers.email_address=eq.x`), cioe' esattamente la superficie che stiamo
// chiudendo. Il punto nel VALORE invece e' normale (`order=id.desc`).
const DOTTED_PARAMS_ALLOWED = ['not.and', 'not.or'];

// Nomi delle risorse embeddate in TUTTI i `select` della query. `getAll` e non
// `get`: con `?select=*&select=*,orders(*)` il primo valore e' innocuo e il
// secondo no, e leggere solo il primo era di per se' una via d'uscita.
//
// Torna `null` quando la stringa non e' interpretabile con certezza (caratteri
// fuori dal set atteso, parentesi sbilanciate, parentesi vuote che non sono un
// aggregato noto): chi chiama deve trattarlo come un rifiuto, non come "nessun
// embedding".
export function embeddedTableNames(search: string): string[] | null {
  const selects = new URLSearchParams(search).getAll('select');
  const names: string[] = [];

  for (const select of selects) {
    if (!SELECT_SAFE_CHARS.test(select)) return null;

    // Parentesi sbilanciate: il nostro riconoscitore e quello di PostgREST
    // leggerebbero due cose diverse, e la differenza e' dove si nascondono i
    // bypass. Non proviamo a indovinare.
    let depth = 0;
    for (const ch of select) {
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth < 0) return null;
      }
    }
    if (depth !== 0) return null;

    for (const match of select.matchAll(EMBED_PATTERN)) {
      const name = match[1].toLowerCase();
      // Contenuto fra questa parentesi e la sua chiusura: vuoto = aggregato,
      // pieno = embedding.
      const openIndex = match.index + match[0].length - 1;
      const closeIndex = matchingParen(select, openIndex);
      if (closeIndex === null) return null;
      const inner = select.slice(openIndex + 1, closeIndex).trim();

      if (inner === '') {
        // `count()`, `price.sum()`: uso legittimo. Qualunque altro nome con
        // parentesi vuote non sappiamo cosa sia.
        if (!AGGREGATE_FUNCTIONS.includes(name)) return null;
        continue;
      }
      names.push(name);
    }
  }

  return names;
}

// Indice della parentesi che chiude quella aperta in `openIndex`, o null se non
// c'e'. Serve a distinguere `customers(*)` da `count()` anche quando sono
// annidati.
function matchingParen(text: string, openIndex: number): number | null {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

export type QueryVerdict = { ok: true } | { ok: false; reason: string };

// Unico controllo sulla querystring prima dell'inoltro. Tutto cio' che non
// riconosciamo con certezza finisce nel ramo che nega: e' un proxy che parla
// con la service_role, e in dubbio si perde una lettura, non dei dati.
export function inspectReadQuery(search: string, allowedEmbeds: readonly string[]): QueryVerdict {
  const params = new URLSearchParams(search);

  for (const [rawName] of params) {
    const name = rawName.toLowerCase();

    if (FORBIDDEN_PARAMS.includes(name)) {
      return { ok: false, reason: `Parametro non ammesso: ${name}` };
    }

    // Filtri, ordinamenti e limiti su una risorsa collegata: `orders.limit=1`,
    // `customers.email_address=eq.x`, `orders.order=id.desc`. Vivono fuori dal
    // `select`, quindi guardare solo il `select` non bastava.
    if (name.includes('.') && !DOTTED_PARAMS_ALLOWED.includes(name)) {
      return { ok: false, reason: `Filtro su risorsa collegata non ammesso: ${rawName}` };
    }
  }

  const embeds = embeddedTableNames(search);
  if (embeds === null) {
    return { ok: false, reason: 'Select non interpretabile.' };
  }

  // Il rovescio della logica: non si cerca cio' che e' vietato, si pretende che
  // ogni nome trovato sia in elenco. Una tabella che non abbiamo mai visto —
  // orders, order_lines, o qualunque cosa il merchant abbia nel suo progetto —
  // cade qui senza che nessuno debba averla prevista.
  for (const name of embeds) {
    // customers non e' embeddabile e basta, qualunque cosa dica l'elenco: il
    // consenso al marketing si applica al livello top del proxy, quindi un
    // customers raggiunto per chiave esterna uscirebbe senza che nessuno abbia
    // controllato il consenso. Ripetuto qui e non solo nell'elenco perche' un
    // domani qualcuno potrebbe aggiungerlo li' senza sapere questa parte.
    if (name === 'customers') {
      return { ok: false, reason: 'Embedding di customers non ammesso.' };
    }
    if (!allowedEmbeds.includes(name)) {
      return { ok: false, reason: `Embedding non ammesso: ${name}` };
    }
  }

  return { ok: true };
}

// Host derivato SOLO dal ref memorizzato: nessun input utente nell'host (anti-SSRF).
export function buildSupabaseReadUrl(projectRef: string, table: string, search: string): string {
  // Validazione difensiva: difende da bug futuri o usi diretti (la route filtra già table sull'allowlist).
  if (!/^[a-z_]+$/.test(table)) {
    throw new Error(`Nome tabella non valido: ${table}`);
  }
  if (!/^[a-z0-9]+$/.test(projectRef)) {
    throw new Error(`Project ref non valido: ${projectRef}`);
  }
  const qs = search && search !== '?' ? search : '';
  return `https://${projectRef}.supabase.co/rest/v1/${table}${qs}`;
}

export interface ForwardResult {
  status: number;
  body: string;
  contentType: string;
}

export async function forwardRead(
  ctx: ShopReadContext,
  table: string,
  search: string,
): Promise<ForwardResult> {
  const url = buildSupabaseReadUrl(ctx.projectRef, table, search);
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: ctx.serviceRoleKey,
      Authorization: `Bearer ${ctx.serviceRoleKey}`,
      Accept: 'application/json',
    },
  });
  const body = await res.text();
  return {
    status: res.status,
    body,
    contentType: res.headers.get('content-type') ?? 'application/json',
  };
}
