/**
 * Il riconoscimento del visitatore: le regole, senza il database.
 *
 * Qui sta cio' che si puo' decidere guardando solo dei valori — come si scrive
 * una riga di `users`, quale identificativo vince quando due browser si
 * rivelano la stessa persona, dove si legge l'identificativo dentro un ordine,
 * quando una riga anonima ha smesso di poter servire. Le chiamate al database
 * del merchant stanno accanto, in `users.server.ts`: separarle serve a poter
 * provare queste regole senza inventarsi un progetto Supabase.
 *
 * La tabella e' descritta nella DDL (lib/supabase-schema), e vale la pena
 * ripetere qui la cosa che piu' facilmente si dimentica: UNA RIGA PER BROWSER,
 * non per persona. Il telefono e il portatile della stessa cliente sono due
 * righe, e restano due righe anche dopo che si e' capito che e' la stessa
 * cliente. Toglierne una vorrebbe dire smettere di riconoscerla su quel
 * dispositivo.
 */

import { isExternalId } from './external-id';

/** Il nome che la DDL crea: e' l'unico a cui possiamo provvedere. */
export const USERS_TABLE = 'users';

/**
 * L'attributo di carrello con cui l'identificativo arriva dentro l'ordine.
 *
 * L'underscore iniziale non e' uno stile: Shopify tratta gli attributi che
 * cominciano cosi' come PRIVATI, cioe' non li mostra al cliente nel carrello,
 * non li stampa sulla conferma d'ordine e non li espone nel tema. Un
 * identificativo di tracciamento in bella vista dentro il riepilogo dell'ordine
 * sarebbe rumore per chi compra e una domanda in piu' per il merchant.
 *
 * Arriva nel corpo del webhook dentro `note_attributes`, che e' il nome REST
 * della stessa cosa.
 */
export const EXTERNAL_ID_CART_ATTRIBUTE = '_corew_external_id';

/** Un attributo di carrello com'e' scritto nel corpo del webhook. */
export interface NoteAttribute {
  name?: string | null;
  value?: string | null;
}

/**
 * L'identificativo del browser dentro gli attributi di un ordine.
 *
 * E' il legame piu' forte che abbiamo: nella stessa busta arrivano l'id del
 * cliente Shopify e l'identificativo del browser che ha riempito quel carrello,
 * senza che nessuno abbia dovuto fare login e senza che noi si debba indovinare
 * niente. Basta che comprino.
 *
 * Cio' che non e' un nostro identificativo ben formato viene scartato: il
 * carrello e' un posto dove chiunque puo' scrivere — un tema, un'altra app, il
 * cliente stesso con la console aperta — e una riga di `users` con dentro un
 * valore inventato e' peggio di nessuna riga.
 */
export function externalIdFromNoteAttributes(
  attributes: NoteAttribute[] | null | undefined,
): string | null {
  if (!Array.isArray(attributes)) return null;

  for (const attribute of attributes) {
    if (attribute?.name !== EXTERNAL_ID_CART_ATTRIBUTE) continue;
    const value = typeof attribute.value === 'string' ? attribute.value.trim() : '';
    return isExternalId(value) ? value : null;
  }

  return null;
}

/**
 * Quando l'identificativo e' stato coniato, letto dai millisecondi che porta
 * dentro.
 *
 * Serve a rompere la parita' fra due righe con la stessa `first_seen_at`: il
 * database la scrive al secondo o al millisecondo, e due browser visti nello
 * stesso istante lascerebbero indeciso quale sia il piu' vecchio. `null` per
 * cio' che non e' un identificativo nostro.
 */
export function externalIdMintedAt(externalId: string): number | null {
  if (!isExternalId(externalId)) return null;
  const millis = Number(externalId.split('_')[1]);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Quanto puo' essere lungo cio' che il container ci manda su browser e
 * dispositivo.
 *
 * Sono due etichette ("Chrome", "mobile"), non uno user agent: il tetto esiste
 * perche' un container mal configurato potrebbe passarci l'intera stringa del
 * browser, e allora nella colonna finirebbe un dato personale che nessuno ha
 * chiesto — uno user agent completo identifica da solo, molto meglio di quanto
 * serva a dire "e' un telefono".
 */
export const MAX_TRAIT_LENGTH = 40;

/**
 * Ripulisce un'etichetta prima di scriverla: via gli spazi ai bordi, via cio'
 * che eccede il tetto, e una stringa vuota vale come assenza — la colonna resta
 * NULL invece di contenere il nulla scritto in un altro modo.
 */
export function sanitizeTrait(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, MAX_TRAIT_LENGTH);
  return trimmed === '' ? null : trimmed;
}

/**
 * Gli operatori di PostgREST che possono comparire davanti a un valore in
 * querystring. `eq` e' quello che serve; gli altri sono qui perche' un merchant
 * che configura una condizione puo' scrivere anche quelli, e in tal caso il
 * valore vero e' comunque cio' che segue il punto.
 */
const POSTGREST_OPERATORS = /^(eq|neq|like|ilike|is|in|gt|gte|lt|lte|match|imatch)\./i;

/**
 * Il valore vero dentro un parametro scritto nella sintassi di PostgREST.
 *
 * Chi ci chiama non sa di non parlare con PostgREST: usa un template pronto che
 * compone `?colonna=valore` dove il valore lo scrive il merchant, e il merchant
 * lo scrive come si scrive su Supabase, cioe' `eq.Safari`. Prendere quella
 * stringa alla lettera vorrebbe dire scrivere `eq.Safari` nella colonna
 * `browser` — un dato sbagliato che nessuno andrebbe piu' a guardare, e che
 * salterebbe fuori mesi dopo dentro un segmento.
 *
 * Un valore senza operatore passa intatto: e' altrettanto legittimo.
 */
export function postgrestFilterValue(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.replace(POSTGREST_OPERATORS, '').trim();
  return value === '' ? null : value;
}

/** Cio' che si sa di un browser nel momento in cui lo si vede. */
export interface SeenVisitor {
  externalId: string;
  browser?: string | null;
  deviceType?: string | null;
  seenAt?: Date;
}

/** La riga da scrivere. Vedi sotto perche' certe colonne non ci sono. */
export interface UserSeenRow {
  external_id: string;
  last_seen_at: string;
  browser?: string;
  device_type?: string;
}

/**
 * La riga con cui si registra "questo browser c'e'".
 *
 * Vale sia per la prima comparsa sia per il ritorno, ed e' di proposito la
 * stessa: l'upsert su `external_id` inserisce la prima volta e aggiorna dopo,
 * quindi non c'e' un momento in cui bisogna sapere quale dei due casi si stia
 * vivendo — e non c'e' modo di produrre un doppione.
 *
 * COSA NON C'E' DENTRO, e conta:
 *
 *  - `first_seen_at`: non viene mai mandato. L'API REST costruisce l'UPDATE
 *    con le sole colonne presenti nel corpo, quindi una colonna assente al
 *    ritorno non viene toccata, e alla prima comparsa prende il DEFAULT NOW()
 *    della DDL. Mandarla vorrebbe dire riscrivere la prima comparsa a ogni
 *    visita, cioe' perderla.
 *
 *  - `browser` e `device_type` quando il container non li manda: stessa
 *    ragione al contrario — se li scrivessimo come NULL, un container che li
 *    manda su una pagina e non sulla successiva cancellerebbe cio' che aveva
 *    appena detto.
 *
 *  - `shopify_customer_id` e `merged_into`: qui non si sa chi sia la persona, e
 *    scrivere NULL su una riga che era gia' stata legata a un cliente
 *    slegherebbe il browser proprio al suo ritorno.
 */
export function userSeenRow(visitor: SeenVisitor): UserSeenRow {
  const browser = sanitizeTrait(visitor.browser);
  const deviceType = sanitizeTrait(visitor.deviceType);

  return {
    external_id: visitor.externalId,
    last_seen_at: (visitor.seenAt ?? new Date()).toISOString(),
    ...(browser ? { browser } : {}),
    ...(deviceType ? { device_type: deviceType } : {}),
  };
}

/** Una riga di `users` come torna dal database, ridotta a cio' che qui serve. */
export interface UserRow {
  external_id: string;
  first_seen_at?: string | null;
  /** Serve a scegliere quali browser tenere quando un cliente ne accumula troppi. */
  last_seen_at?: string | null;
  merged_into?: string | null;
}

/**
 * Fra piu' browser della stessa persona, quello che vince.
 *
 * Vince il piu' vecchio, e non e' una convenzione arbitraria: e' quello che ha
 * la storia piu' lunga alle spalle, quindi quello a cui conviene ricondurre il
 * resto. Il piu' recente ha, per definizione, meno da perdere.
 *
 * L'ordine e' per `first_seen_at`; a parita', per i millisecondi dentro
 * l'identificativo; a parita' ancora, per l'identificativo stesso — non perche'
 * quell'ultimo confronto voglia dire qualcosa, ma perche' la risposta deve
 * essere sempre la stessa: un vincitore che cambia a ogni giro farebbe puntare
 * le righe l'una all'altra a turno.
 */
export function oldestExternalId(rows: readonly UserRow[]): string | null {
  const sorted = [...rows].sort(compareByAge);
  return sorted[0]?.external_id ?? null;
}

function compareByAge(a: UserRow, b: UserRow): number {
  const seenA = Date.parse(a.first_seen_at ?? '');
  const seenB = Date.parse(b.first_seen_at ?? '');
  // Una riga senza data non e' "vecchissima": e' una riga di cui non sappiamo
  // l'eta', e va in fondo invece di vincere per un'assenza.
  const safeA = Number.isFinite(seenA) ? seenA : Number.POSITIVE_INFINITY;
  const safeB = Number.isFinite(seenB) ? seenB : Number.POSITIVE_INFINITY;
  if (safeA !== safeB) return safeA - safeB;

  const mintedA = externalIdMintedAt(a.external_id) ?? Number.POSITIVE_INFINITY;
  const mintedB = externalIdMintedAt(b.external_id) ?? Number.POSITIVE_INFINITY;
  if (mintedA !== mintedB) return mintedA - mintedB;

  return a.external_id < b.external_id ? -1 : a.external_id > b.external_id ? 1 : 0;
}

/** Chi vince e chi deve puntargli. */
export interface MergePlan {
  /** L'identificativo canonico della persona: il piu' vecchio dei suoi browser. */
  canonical: string;
  /** I browser che devono cominciare a puntare al canonico. Mai cancellati. */
  toMerge: string[];
}

/**
 * Cosa fare quando piu' righe si scoprono della stessa persona.
 *
 * Non cancella e non propone di cancellare: `toMerge` sono righe che restano
 * dove sono, con il loro `shopify_customer_id` e la loro storia, e che in piu'
 * dichiarano a chi appartengono. E' cio' che permette di dire a un domani "gli
 * eventi partiti sotto questo identificativo sono di quella persona li'" senza
 * avere il potere di andarli a correggere dentro Meta e GA4, dove ormai sono.
 *
 * Chi punta gia' al canonico non compare: riscrivergli lo stesso valore sarebbe
 * una scrittura sul database del merchant che non cambia niente.
 */
export function planMerge(rows: readonly UserRow[]): MergePlan | null {
  const canonical = oldestExternalId(rows);
  if (canonical === null || rows.length < 2) return null;

  const toMerge = rows
    .filter((row) => row.external_id !== canonical && row.merged_into !== canonical)
    .map((row) => row.external_id);

  return { canonical, toMerge };
}

/**
 * L'email nella forma in cui la tabella dei clienti la contiene.
 *
 * Minuscola e senza spazi ai bordi: Shopify le normalizza cosi', e un confronto
 * fatto su cio' che l'utente ha digitato — con la maiuscola iniziale che il
 * telefono aggiunge da solo — non troverebbe il cliente che c'e'.
 */
export function normalizeEmail(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  // Non e' una validazione seria e non vuole esserlo: serve solo a non andare a
  // interrogare il database con qualcosa che non e' un'email.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * Il telefono in sole cifre, che e' la forma in cui la colonna `phone_number`
 * lo contiene dalla versione 6 dello schema in poi.
 *
 * Il piu' e gli spazi della forma leggibile di Shopify ("+39 333 123 4567") non
 * sopravvivono li' e non devono sopravvivere qui, o il confronto fallirebbe
 * proprio sui numeri scritti per esteso.
 */
export function normalizePhone(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^0-9]/g, '');
  // Meno di sei cifre non e' un numero di telefono: e' un campo compilato male,
  // e cercarlo pescherebbe il cliente sbagliato.
  return digits.length >= 6 ? digits : null;
}

/**
 * Per quanto si tiene la riga di un browser che non si e' mai identificato.
 *
 * NOVANTA GIORNI, e il numero viene da un conto, non da un'impressione.
 *
 * IL VOLUME. Un negozio da cinquantamila sessioni al giorno scrive qui, nel
 * caso peggiore, cinquantamila righe al giorno: sono visitatori nuovi, e un
 * visitatore nuovo e' una riga. A novanta giorni fanno quattro milioni e mezzo
 * di righe; a un anno diciotto milioni. Con i due indici parziali, la prima
 * cifra sta in qualche centinaio di megabyte — dentro il mezzo giga che
 * Supabase da' sul piano gratuito, che e' il piano su cui questi database
 * stanno. La seconda no: sarebbero qualche gigabyte di database del merchant
 * occupati da righe che non hanno mai riconosciuto nessuno.
 *
 * L'UTILITA'. Novanta giorni non e' nemmeno una rinuncia. Una riga anonima
 * serve a una cosa sola: essere li' il giorno in cui quel browser si rivela. Le
 * finestre di attribuzione che le piattaforme pubblicitarie usano davvero
 * arrivano a trenta giorni, e questa soglia e' tre volte tanto. Chi non si e'
 * mai fatto riconoscere in tre mesi non sta per farlo.
 *
 * Alzarla si puo' — e' una costante sola, e questo e' il posto — ma va alzata
 * sapendo che il prezzo lo paga il database del merchant, non il nostro.
 *
 * Vale SOLO per le righe mai identificate — `shopify_customer_id IS NULL`. Una
 * riga legata a un cliente non scade mai, perche' e' proprio quella che serve a
 * riconoscerlo quando torna dopo due anni, ed e' l'unica per cui la domanda "di
 * chi e' questo browser" ha una risposta. Sono anche, per forza di cose, la
 * minoranza: la potatura tocca la parte grossa e inutile della tabella e lascia
 * intatta quella piccola e preziosa.
 */
export const ANONYMOUS_USER_RETENTION_DAYS = 90;

/**
 * Quanti browser si tengono per ogni cliente.
 *
 * Non e' il numero di dispositivi che una persona possiede: e' il numero di
 * identificativi che accumula. Ogni volta che svuota i cookie, riapre in
 * incognito o cambia telefono ne nasce uno nuovo, e in qualche anno anche chi
 * usa sempre lo stesso portatile puo' arrivare a decine. Senza un tetto quella
 * coda cresce e basta, e serve a niente: per riconoscere qualcuno bastano i
 * browser da cui passa davvero, non tutti quelli da cui e' passato una volta.
 *
 * Dieci e' largo abbastanza da coprire chi usa lavoro, casa, telefono e tablet
 * insieme, e stretto abbastanza da non lasciar crescere la coda all'infinito.
 */
export const MAX_BROWSERS_PER_CUSTOMER = 10;

/**
 * Quali righe di un cliente vanno lasciate andare, tenendo le piu' recenti.
 *
 * Due righe non si toccano mai, qualunque sia la loro eta':
 *
 * Quelle a cui punta un'altra riga. Il canonico di una fusione e' il piu'
 * VECCHIO — vince chi ha la storia piu' lunga — quindi e' esattamente il tipo di
 * riga che un tetto "tieni le piu' recenti" porterebbe via per prima, lasciando
 * i puntatori delle altre nel vuoto.
 *
 * E quelle che sono esse stesse un rimando: sono minuscole e sono l'unico modo
 * di ritrovare la strada da un identificativo vecchio, che negli eventi gia'
 * partiti continua a comparire.
 */
export function browsersToForget(
  rows: readonly UserRow[],
  max: number = MAX_BROWSERS_PER_CUSTOMER,
): string[] {
  const pointedTo = new Set(
    rows.map((row) => row.merged_into).filter((id): id is string => Boolean(id)),
  );

  const candidates = rows.filter(
    (row) => !row.merged_into && !pointedTo.has(row.external_id),
  );
  if (candidates.length <= max) return [];

  // Dalla piu' recente alla piu' vecchia: si tengono le prime, si lasciano
  // andare quelle in coda.
  const byRecency = [...candidates].sort(
    (a, b) =>
      new Date(b.last_seen_at ?? 0).getTime() - new Date(a.last_seen_at ?? 0).getTime(),
  );
  return byRecency.slice(max).map((row) => row.external_id);
}

/** Prima di questo istante, una riga mai identificata non serve piu'. */
export function anonymousUserCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - ANONYMOUS_USER_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}
