import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '~/db.server';
import { encrypt, decrypt } from '~/utils/crypto.server';
import { refreshAccessToken, SupabaseTokenError } from './supabase-management.server';

/**
 * Il `state` di un giro OAuth: chi ha cominciato, e quando scade.
 *
 * Non c'e' nessuna tabella e nessun cookie. Il valore si porta dentro il
 * negozio che ha avviato l'autorizzazione, firmato con il segreto dell'app: la
 * pagina di ritorno vive fuori dall'admin di Shopify e non ha una sessione, ma
 * sa comunque di chi si tratta, e chi torna non puo' cambiarlo senza
 * invalidare la firma.
 *
 * Vale dieci minuti: e' il tempo di un'autorizzazione, non di una sessione.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error('ENCRYPTION_SECRET non configurato');
  return secret;
}

export function signState(shopId: string, now: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ shopId, exp: now + STATE_TTL_MS }),
  ).toString('base64url');
  const sig = createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyState(
  state: string,
  now: number = Date.now(),
): { shopId: string } | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  // Il confronto a tempo costante non basta se le lunghezze differiscono:
  // timingSafeEqual lancerebbe, e un'eccezione qui sarebbe gia' una risposta.
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      shopId?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.shopId !== 'string' || typeof parsed.exp !== 'number') return null;
    if (now > parsed.exp) return null;
    return { shopId: parsed.shopId };
  } catch {
    return null;
  }
}

export async function saveTokens(
  shopId: string,
  t: { access_token: string; refresh_token: string; expires_in: number },
): Promise<void> {
  const expiresAt = new Date(Date.now() + t.expires_in * 1000);
  const data = {
    accessToken: encrypt(t.access_token),
    refreshToken: encrypt(t.refresh_token),
    expiresAt,
  };
  await prisma.supabaseOAuthToken.upsert({
    where: { shopId },
    create: { shopId, ...data },
    update: data,
  });
}

/**
 * LA CORSA CHE QUESTO PEZZO DI FILE ESISTE PER EVITARE.
 *
 * Supabase ruota il refresh token a ogni uso: appena lo spendi, quello che
 * avevi in mano non vale piu'. Il token d'accesso dura un'ora, quindi una
 * volta ogni ora la prima richiesta che passa di qui lo trova scaduto e lo
 * rinnova. Il guaio e' che di richieste, in quell'istante, non ce n'e' una.
 *
 * La dashboard apre le sue card tutte insieme: nei log del 20 settembre si
 * contano sei chiamate a `/api/stats/*` dentro lo stesso secondo. Senza niente
 * che le metta in fila, tutte e sei leggono la stessa riga, trovano lo stesso
 * token scaduto e partono con lo STESSO refresh token. Una vince. Le altre
 * cinque presentano un refresh token che Supabase ha gia' consumato e si
 * prendono un 404 — e il merchant si vedeva scritto "serve ricollegare
 * Supabase" per una condizione che due minuti dopo era gia' passata da sola.
 *
 * Le difese sono tre, e servono tutte e tre perche' coprono tratti diversi:
 *
 *   1. `rinnoviInCorso` — le richieste che vivono nello stesso processo.
 *      Costa una Map e non tocca niente.
 *   2. `prendiIlTurno` — le richieste che finiscono su istanze diverse, che
 *      e' il caso normale su Vercel: la memoria di un'istanza non le vede. Il
 *      turno si prende sul database owner, l'unica cosa che vedono tutte, e
 *      si prende SOLO quando il token e' gia' scaduto: sul percorso normale
 *      qui non ci si arriva nemmeno, si legge la riga e si esce.
 *   3. la rilettura dopo un errore — l'ultima rete. Se il rinnovo fallisce,
 *      prima di dire che qualcosa non va si torna a guardare la riga: se nel
 *      frattempo qualcun altro ha salvato un token buono, quell'errore era una
 *      corsa persa e non deve diventare un messaggio al merchant.
 */

/** Il margine con cui un token si considera gia' scaduto. */
const SKEW_MS = 60_000;

/**
 * Quanto aspetta chi ha perso il turno, e ogni quanto torna a guardare.
 *
 * Tre secondi e' piu' di quanto serva a un rinnovo riuscito (una chiamata
 * sola) ed e' meno di quanto il merchant aspetterebbe volentieri davanti a una
 * card vuota. Chi esce a mani vuote non fallisce in modo definitivo: dice che
 * e' passeggero, e al caricamento dopo il token c'e'.
 */
const ATTESA_PASSO_MS = 100;
const ATTESA_MAX_MS = 3_000;

/** Quel che serve del token per decidere: niente id, niente date inutili. */
interface RigaToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  updatedAt: Date;
}

/**
 * I rinnovi in volo dentro QUESTA invocazione, uno per negozio.
 *
 * Due loader della stessa pagina girano nello stesso processo: farli rinnovare
 * due volte sarebbe garantirsi la corsa in casa propria. Chi arriva secondo si
 * attacca alla promessa del primo — stessa chiamata, stesso esito, anche
 * quando l'esito e' un errore.
 */
const rinnoviInCorso = new Map<string, Promise<string>>();

/**
 * Il permesso lo sta gia' rinnovando qualcun altro, e non ha ancora finito.
 *
 * NON e' un guasto: e' la fila. Va tenuto distinto sia dal permesso revocato
 * (li' serve il merchant) sia dal database irraggiungibile (li' serve
 * Supabase), perche' al merchant si deve dire una frase vera — e la frase vera
 * qui e' "fra un istante c'e'", non "ricollega" e non "dopo la prima
 * sincronizzazione".
 */
export class RinnovoPermessoInCorsoError extends Error {
  constructor() {
    super('Rinnovo del permesso Supabase gia in corso per questo negozio');
    this.name = 'RinnovoPermessoInCorsoError';
  }
}

/** Riconosce l'attesa del rinnovo da qualunque punto della catena. */
export function isRinnovoPermessoInCorso(error: unknown): boolean {
  return error instanceof RinnovoPermessoInCorsoError;
}

function tokenAncoraBuono(expiresAt: Date, ora: number = Date.now()): boolean {
  return expiresAt.getTime() - SKEW_MS > ora;
}

function attendi(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getValidAccessToken(shopId: string): Promise<string> {
  const row = await prisma.supabaseOAuthToken.findUnique({ where: { shopId } });
  if (!row) throw new Error('Supabase non collegato per questo shop');

  // Il caso di gran lunga piu' frequente: una lettura e via. Tutto quel che
  // c'e' sotto si paga una volta all'ora, quando il token scade davvero.
  if (tokenAncoraBuono(row.expiresAt)) {
    return decrypt(row.accessToken);
  }

  const giaInCorso = rinnoviInCorso.get(shopId);
  if (giaInCorso) return giaInCorso;

  const giro = rinnovaIlPermesso(shopId, row);
  rinnoviInCorso.set(shopId, giro);
  try {
    return await giro;
  } finally {
    // Si toglie sempre, anche dopo un errore: una promessa fallita lasciata
    // nella mappa terrebbe fermo il negozio fino al riavvio dell'istanza.
    rinnoviInCorso.delete(shopId);
  }
}

/**
 * Il rinnovo vero, gia' protetto dalla concorrenza dentro il processo.
 *
 * Da qui in giu' la difesa e' fra istanze diverse, e quindi passa dal
 * database.
 */
async function rinnovaIlPermesso(shopId: string, riga: RigaToken): Promise<string> {
  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.SUPABASE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Integrazione Supabase non configurata');
  }

  if (!(await prendiIlTurno(shopId, riga.updatedAt, Date.now()))) {
    // Il turno e' di un altro: si aspetta il SUO token invece di chiederne un
    // secondo. Chiederlo vorrebbe dire spendere un refresh token che a questo
    // punto e' quasi certamente gia' stato consumato — cioe' rifare esattamente
    // l'errore del 20 settembre, con in piu' il rischio di bruciare il rinnovo
    // buono dell'altro.
    const altrui = await attendiIlTokenNuovo(shopId);
    if (altrui) return altrui;

    // L'altro non ha pubblicato niente entro l'attesa: puo' essere lento, puo'
    // essere morto con la sua invocazione. In tutti e due i casi non c'e'
    // niente da chiedere al merchant, e non si prova un secondo rinnovo: il
    // turno e' segnato sulla riga, quindi la richiesta dopo lo trovera' libero
    // (la riga e' cambiata, la presa si rifa' sul valore nuovo) e rinnovera'
    // lei. Qui si dice solo che adesso il numero non c'e'.
    throw new RinnovoPermessoInCorsoError();
  }

  let rinnovato;
  try {
    rinnovato = await refreshAccessToken({
      refreshToken: decrypt(riga.refreshToken),
      clientId,
      clientSecret,
    });
  } catch (e) {
    // LA RILETTURA. Un rinnovo fallito non e' ancora una brutta notizia:
    // qualcun altro puo' avere salvato un token valido nel frattempo (una
    // corsa che la presa non ha visto — istanze su codice diverso durante un
    // rilascio, o un rinnovo partito prima della presa). Se c'e', si usa
    // quello e non e' successo niente.
    const salvato = await tokenValidoSalvato(shopId);
    if (salvato) return salvato;

    // Nessun token buono nemmeno adesso: l'errore e' reale, e per il 404 e'
    // questa rilettura a vuoto a trasformarlo da "forse una corsa" in "il
    // permesso non c'e' piu'".
    throw confermaSeCredenzialeMorta(e);
  }

  await saveTokens(shopId, rinnovato);
  return rinnovato.access_token;
}

/** Per quanto la riga appena toccata vale come turno di qualcun altro. */
const TURNO_TTL_MS = 10_000;

/**
 * Il turno per rinnovare, preso sul database owner senza colonne nuove.
 *
 * `updatedAt` e' gia' la versione della riga, e qui fa due lavori insieme:
 *
 *   - e' la guardia della presa. Si scrive solo se la riga e' rimasta quella
 *     che abbiamo letto, quindi fra N richieste che leggono lo stesso valore
 *     esattamente una si porta a casa `count === 1`. E' lo stesso modo in cui
 *     la coda si prende un item — `updateMany` con la guardia dentro il
 *     `where` ed esito contato — applicato alla riga del token.
 *   - e' la scadenza del turno. Spostarla avanti non basterebbe: chi legge la
 *     riga un istante DOPO la presa e un istante PRIMA del salvataggio
 *     troverebbe il token ancora scaduto e una guardia che coincide con quel
 *     che ha appena letto, e vincerebbe anche lui. Per questo una riga toccata
 *     da meno di `TURNO_TTL_MS` vale come turno di qualcun altro.
 *
 * `TURNO_TTL_MS` non porta rischi di stallo: chi prende il turno ha gia'
 * cambiato la riga, quindi se muore con la sua invocazione senza salvare
 * niente, dieci secondi dopo la richiesta successiva rifa' la presa sul valore
 * nuovo e la vince. Non esistono turni bloccati, non c'e' niente da sbloccare
 * a mano, e non serve nessuna colonna in piu' sulla tabella.
 *
 * Quando la riga e' vecchia — ed e' sempre vecchia quando si arriva qui, il
 * token dura un'ora — la presa costa una UPDATE, una volta per scadenza. Un
 * lucchetto su OGNI lettura di token sarebbe stato tutt'altro prezzo.
 */
async function prendiIlTurno(shopId: string, updatedAt: Date, ora: number): Promise<boolean> {
  if (ora - updatedAt.getTime() < TURNO_TTL_MS) return false;

  const esito = await prisma.supabaseOAuthToken.updateMany({
    where: { shopId, updatedAt },
    data: { updatedAt: new Date(ora) },
  });
  return esito.count === 1;
}

/** Il token della riga, se quello che c'e' adesso e' utilizzabile. */
async function tokenValidoSalvato(shopId: string): Promise<string | null> {
  const riga = await prisma.supabaseOAuthToken.findUnique({ where: { shopId } });
  if (!riga || !tokenAncoraBuono(riga.expiresAt)) return null;
  return decrypt(riga.accessToken);
}

/** Aspetta che chi ha il turno pubblichi il token nuovo, e lo restituisce. */
async function attendiIlTokenNuovo(shopId: string): Promise<string | null> {
  const scadenza = Date.now() + ATTESA_MAX_MS;
  while (Date.now() < scadenza) {
    await attendi(ATTESA_PASSO_MS);
    const token = await tokenValidoSalvato(shopId);
    if (token) return token;
  }
  return null;
}

/**
 * Il 404 diventa "ricollega" solo qui, dopo che la rilettura e' andata a
 * vuoto. Il perche' per esteso sta su `SupabaseTokenError`.
 */
function confermaSeCredenzialeMorta(e: unknown): unknown {
  if (e instanceof SupabaseTokenError && e.status === 404) {
    return new SupabaseTokenError(404, true);
  }
  return e;
}
