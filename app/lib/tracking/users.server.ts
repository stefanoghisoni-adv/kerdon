import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ShopReadContext } from '~/lib/read-proxy/context.server';
import {
  USERS_TABLE,
  anonymousUserCutoff,
  browsersToForget,
  normalizeEmail,
  normalizePhone,
  planMerge,
  userSeenRow,
  type SeenVisitor,
  type UserRow,
} from './users';

/**
 * Le scritture del riconoscimento visitatori sul database del merchant.
 *
 * Le regole stanno accanto, in `users.ts`, e qui non se ne prende nessuna:
 * questo file sa solo parlare con Supabase. La divisione serve a poter provare
 * le regole senza un progetto vero, e a rendere evidente quanto poco ci sia da
 * decidere nel momento in cui si scrive.
 *
 * TUTTO QUI DENTRO E' BEST EFFORT, e va detto una volta per tutte. Queste
 * scritture stanno appese a cose che devono riuscire comunque: restituire un
 * identificativo alla vetrina, salvare un ordine appena arrivato, chiudere il
 * giro del cron. Un progetto Supabase lento o una tabella non ancora creata non
 * possono far fallire nessuna di quelle. L'esito si scrive nel log e si va
 * avanti — un browser riconosciuto un attimo dopo e' un danno che si ripara da
 * solo alla visita successiva, un ordine non salvato no.
 */

/**
 * Come si provvede alla tabella quando non c'e'.
 *
 * E' una funzione passata da fuori e non una chiamata diretta perche' questo
 * file non deve sapere niente ne' di Prisma ne' della configurazione del
 * negozio: chi lo usa sa gia' come arrivarci. Restituisce `true` se dopo il
 * tentativo la tabella c'e'.
 */
export type ProvisionUsersTable = () => Promise<boolean>;

/** Il minimo che serve per capire com'e' andata una chiamata a PostgREST. */
interface WithError {
  error: { code?: string | null; message?: string | null } | null;
}

/**
 * La tabella non c'e'.
 *
 * `42P01` e' l'`undefined_table` di Postgres; `PGRST205` e' il modo in cui
 * l'API REST dice che la tabella non e' nella sua copia in cache dello schema.
 * Stessi codici che riconosce `ensure-table.server`: sono le due facce dello
 * stesso problema.
 */
function isMissingTable(error: WithError['error']): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const message = error.message ?? '';
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /does not exist|could not find the table/i.test(message)
  );
}

/**
 * Esegue la scrittura e, se la tabella non c'era, la crea e riprova UNA volta.
 *
 * E' lo stesso problema che `report-tables` risolve per le letture della tab
 * Clienti, e per la stessa ragione: la DDL gira al collegamento, quindi ogni
 * negozio collegato prima di oggi non ha `users` e nessuno gliela creerebbe
 * mai. La differenza e' nel momento in cui si guarda: li' si controlla prima,
 * qui si scopre dall'errore. Sondare prima di ogni scrittura vorrebbe dire
 * un'interrogazione in piu' su un percorso che la vetrina chiama a ogni pagina,
 * pagata per sempre da tutti per un caso che capita una volta per negozio.
 */
// `PromiseLike` e non `Promise`: il costruttore di query di supabase-js e' un
// oggetto che si puo' attendere, non una promessa vera, e pretenderne una
// impedirebbe di passargli la query direttamente.
async function withUsersTable<T extends WithError>(
  run: () => PromiseLike<T>,
  provision?: ProvisionUsersTable,
): Promise<T> {
  const first = await run();
  if (!isMissingTable(first.error) || !provision) return first;

  const created = await provision();
  if (!created) return first;

  return run();
}

/**
 * Un client per il progetto del merchant a partire dal contesto di lettura.
 *
 * Il contesto porta il ref del progetto e la chiave di servizio gia' decifrata,
 * ma non l'indirizzo: si ricompone da qui, com'e' composto in `forward.server`.
 * L'host viene SOLO dal ref memorizzato — mai da qualcosa che il chiamante
 * abbia fornito — ed e' controllato prima di essere usato: e' la stessa
 * precauzione contro le richieste dirottate che il proxy prende sulle letture,
 * e non c'e' motivo di essere piu' disinvolti sulle scritture.
 */
export function supabaseFromReadContext(ctx: ShopReadContext): SupabaseClient {
  if (!/^[a-z0-9]+$/.test(ctx.projectRef)) {
    throw new Error(`Project ref non valido: ${ctx.projectRef}`);
  }

  return createClient(`https://${ctx.projectRef}.supabase.co`, ctx.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * "Questo browser c'e'".
 *
 * Un upsert solo, che vale sia per la prima comparsa sia per il ritorno: la
 * chiave primaria e' l'identificativo, quindi non esiste il caso in cui due
 * visite dello stesso browser diventino due righe. `first_seen_at` non e' nel
 * corpo apposta, e resta quella della prima volta (vedi `userSeenRow`).
 */
export async function recordUserSeen(
  supabase: SupabaseClient,
  visitor: SeenVisitor,
  provision?: ProvisionUsersTable,
): Promise<'written' | 'failed'> {
  const { error } = await withUsersTable(
    () =>
      supabase
        .from(USERS_TABLE)
        .upsert([userSeenRow(visitor)], {
          onConflict: 'external_id',
          ignoreDuplicates: false,
        }),
    provision,
  );

  if (error) {
    console.warn(`[users] browser non registrato: ${error.message ?? 'errore sconosciuto'}`);
    return 'failed';
  }
  return 'written';
}

/**
 * LA POLITICA DI CANCELLAZIONE ALLA REVOCA, scritta qui una volta per tutte.
 *
 * Quando un visitatore toglie il permesso, smettere di scrivere non basta:
 * quello che era stato raccolto finche' il permesso c'era resta li', e resta
 * legato a lui. Questa funzione e' cosa succede in quel momento, e sono tre
 * gesti in quest'ordine:
 *
 *  1. SI SLEGA IL CLIENTE. `customers.external_id` e' la comodita' che permette
 *     ai tag di risalire dal cliente al browser da cui sta navigando: e'
 *     esattamente il collegamento che la revoca vieta, ed e' il primo a
 *     sparire. La riga del cliente NON si tocca — quella vive di consenso al
 *     marketing e di obblighi sugli ordini, che sono altre due cose con altre
 *     due basi.
 *
 *  2. SI TOLGONO I RIMANDI. Gli altri browser della stessa persona possono
 *     puntare a questo con `merged_into`. Cancellare la riga lasciandoli
 *     puntare al vuoto significherebbe tenerne in giro il nome: si azzerano, e
 *     restano righe valide per conto loro.
 *
 *  3. SI CANCELLA LA RIGA. Non si anonimizza e non si marca: l'identificativo
 *     E' il dato: una riga "anonimizzata" che conserva la chiave non e'
 *     anonima, e' la stessa riga con un'etichetta sopra.
 *
 * COSA NON SI CANCELLA, e non e' una scappatoia: gli ordini e le anagrafiche.
 * Sono dati che il merchant tiene per obblighi contabili e che non nascono da
 * questo permesso — non li abbiamo raccolti noi in vetrina. La revoca toglie il
 * riconoscimento del browser, non riscrive la contabilita' del negozio.
 *
 * Best effort come tutto il resto del file, ma con una differenza: qui un
 * fallimento si vede nel log come `failed`, perche' una cancellazione che non
 * riesce e' l'unica cosa in questo file che non si ripara da sola alla visita
 * successiva.
 *
 * E' anche la funzione da riusare se serve la stessa cancellazione altrove —
 * una richiesta di cancellazione GDPR fa esattamente questo, per lo stesso
 * identificativo.
 */
export async function forgetVisitor(
  supabase: SupabaseClient,
  externalId: string,
): Promise<'forgotten' | 'failed'> {
  let ok = true;

  const unlink = await supabase
    .from('customers')
    .update({ external_id: null })
    .eq('external_id', externalId);
  if (unlink.error && !isMissingTable(unlink.error)) {
    console.warn(`[users] cliente non slegato: ${unlink.error.message ?? 'errore sconosciuto'}`);
    ok = false;
  }

  const pointers = await supabase
    .from(USERS_TABLE)
    .update({ merged_into: null })
    .eq('merged_into', externalId);
  if (pointers.error && !isMissingTable(pointers.error)) {
    console.warn(`[users] rimandi non azzerati: ${pointers.error.message ?? 'errore sconosciuto'}`);
    ok = false;
  }

  const removed = await supabase.from(USERS_TABLE).delete().eq('external_id', externalId);
  if (removed.error && !isMissingTable(removed.error)) {
    console.warn(
      `[users] browser non dimenticato: ${removed.error.message ?? 'errore sconosciuto'}`,
    );
    ok = false;
  }

  return ok ? 'forgotten' : 'failed';
}

export interface LinkResult {
  outcome: 'linked' | 'failed';
  /** L'identificativo canonico della persona dopo il legame. */
  canonical: string | null;
  /** I browser che da adesso puntano al canonico. */
  merged: string[];
}

/**
 * Lega un browser a un cliente Shopify.
 *
 * E' l'unica cosa che succede quando un visitatore si rivela: si scrive
 * `shopify_customer_id` sulla sua riga. Non si sposta niente in `customers` —
 * li' `shopify_customer_id` e' UNIQUE NOT NULL e c'e' una riga per persona,
 * mentre qui ce n'e' una per browser — e non si cancella niente.
 *
 * Poi si guarda se quel cliente avesse gia' altri browser. Se si', il piu'
 * vecchio diventa il canonico e gli altri glielo dichiarano con `merged_into`,
 * RESTANDO righe a tutti gli effetti: continuano a portare il loro
 * `shopify_customer_id`, e il cliente continua a essere riconosciuto su ognuno
 * dei suoi dispositivi. `merged_into` non e' una cancellazione differita, e'
 * l'indirizzo di casa scritto sulla riga.
 *
 * Infine `customers.external_id`: e' l'unica concessione a quella tabella, e
 * contiene l'identificativo PIU' RECENTE, non il canonico. Sembra una
 * contraddizione e non lo e' — servono a due cose diverse. Il canonico dice a
 * chi appartiene la storia; `customers.external_id` e' una comodita' per i tag
 * che leggono i clienti dal proxy, e a quelli serve l'identificativo del
 * browser da cui la persona sta navigando ADESSO, che e' proprio l'ultimo
 * visto. La fonte di verita' resta `users`.
 */
export async function linkUserToCustomer(
  supabase: SupabaseClient,
  params: SeenVisitor & { shopifyCustomerId: number },
  provision?: ProvisionUsersTable,
): Promise<LinkResult> {
  const { shopifyCustomerId, ...visitor } = params;

  const upsert = await withUsersTable(
    () =>
      supabase
        .from(USERS_TABLE)
        .upsert([{ ...userSeenRow(visitor), shopify_customer_id: shopifyCustomerId }], {
          onConflict: 'external_id',
          ignoreDuplicates: false,
        }),
    provision,
  );

  if (upsert.error) {
    console.warn(
      `[users] legame browser-cliente non scritto: ${upsert.error.message ?? 'errore sconosciuto'}`,
    );
    return { outcome: 'failed', canonical: null, merged: [] };
  }

  const merged = await mergeBrowsersOfCustomer(supabase, shopifyCustomerId);
  await rememberLatestExternalId(supabase, shopifyCustomerId, visitor.externalId);

  return {
    outcome: 'linked',
    canonical: merged.canonical ?? visitor.externalId,
    merged: merged.merged,
  };
}

/**
 * Fa puntare al piu' vecchio i browser che si sono rivelati della stessa
 * persona.
 *
 * Un fallimento qui non annulla il legame appena scritto, che e' la parte che
 * conta: senza `merged_into` il cliente resta riconosciuto su tutti i suoi
 * dispositivi, si perde solo la possibilita' di ricondurre a un identificativo
 * solo gli eventi gia' partiti. Si riproverera' al prossimo legame.
 */
async function mergeBrowsersOfCustomer(
  supabase: SupabaseClient,
  shopifyCustomerId: number,
): Promise<{ canonical: string | null; merged: string[] }> {
  const { data, error } = await supabase
    .from(USERS_TABLE)
    .select('external_id, first_seen_at, merged_into')
    .eq('shopify_customer_id', shopifyCustomerId);

  if (error || !Array.isArray(data)) {
    console.warn(
      `[users] browser del cliente non riletti: ${error?.message ?? 'risposta inattesa'}`,
    );
    return { canonical: null, merged: [] };
  }

  const plan = planMerge(data as UserRow[]);
  if (!plan || plan.toMerge.length === 0) {
    return { canonical: plan?.canonical ?? null, merged: [] };
  }

  const { error: updateError } = await supabase
    .from(USERS_TABLE)
    .update({ merged_into: plan.canonical })
    .in('external_id', plan.toMerge);

  if (updateError) {
    console.warn(
      `[users] unione dei browser non scritta: ${updateError.message ?? 'errore sconosciuto'}`,
    );
    return { canonical: plan.canonical, merged: [] };
  }

  await forgetOldestBrowsers(supabase, data as UserRow[]);

  return { canonical: plan.canonical, merged: plan.toMerge };
}

/**
 * Toglie i browser piu' vecchi quando un cliente ne ha accumulati troppi.
 *
 * Si fa QUI e non nel giro periodico perche' questo e' l'unico istante in cui
 * quel conto puo' crescere: un browser entra nell'elenco di un cliente solo
 * legandosi a lui. Guardare un cliente solo, nel momento giusto, costa una
 * query; spazzare l'intera tabella ogni notte per trovare i pochi che hanno
 * sforato ne costerebbe molte, e la maggior parte a vuoto.
 *
 * Non solleva mai: un elenco un po' piu' lungo del previsto non e' un guasto, e
 * non deve far fallire il riconoscimento che l'ha appena prodotto.
 */
async function forgetOldestBrowsers(
  supabase: SupabaseClient,
  rows: readonly UserRow[],
): Promise<void> {
  const toForget = browsersToForget(rows);
  if (toForget.length === 0) return;

  const { error } = await supabase.from(USERS_TABLE).delete().in('external_id', toForget);
  if (error) {
    console.warn(
      `[users] browser in eccesso non rimossi: ${error.message ?? 'errore sconosciuto'}`,
    );
  }
}

/**
 * Scrive sull'anagrafica cliente l'ultimo identificativo visto.
 *
 * Best effort al quadrato: la tabella `customers` puo' non esistere affatto (un
 * piano che non sincronizza i clienti non la crea) e il cliente puo' non
 * esserci dentro (ci entrano solo quelli che hanno acconsentito al marketing).
 * Nessuno dei due casi e' un problema — il riconoscimento vive in `users` — e
 * nessuno dei due deve lasciare un errore a schermo.
 */
async function rememberLatestExternalId(
  supabase: SupabaseClient,
  shopifyCustomerId: number,
  externalId: string,
): Promise<void> {
  const { error } = await supabase
    .from('customers')
    .update({ external_id: externalId })
    .eq('shopify_customer_id', shopifyCustomerId);

  if (error && !isMissingTable(error)) {
    console.warn(
      `[users] external_id non riportato sul cliente: ${error.message ?? 'errore sconosciuto'}`,
    );
  }
}

export type IdentifyOutcome =
  /** Trovato il cliente e legato il browser. */
  | 'linked'
  /** Nessun cliente con quell'email o quel telefono: il browser resta noto ma anonimo. */
  | 'no_match'
  /** Non e' arrivato niente di cercabile. */
  | 'no_identifier'
  /** Il visitatore non ha permesso il trattamento: non si e' scritto niente. */
  | 'no_consent'
  /** La ricerca non e' andata a buon fine. */
  | 'failed';

export interface IdentifyResult {
  outcome: IdentifyOutcome;
  canonical: string | null;
  merged: string[];
}

/**
 * L'identificazione prima dell'acquisto: da un'email o un telefono al cliente,
 * e da li' al browser.
 *
 * Serve a non dover aspettare l'ordine. Chi si iscrive alla newsletter, chi
 * compila un form, chi apre un ticket si e' gia' rivelato: legare quel momento
 * vuol dire che la campagna che lo ha portato viene attribuita anche se
 * comprera' fra tre settimane da un altro dispositivo.
 *
 * Il browser si registra COMUNQUE, anche quando il cliente non si trova: e' un
 * visitatore vero, e la volta che comprera' vorremo avere la sua prima
 * comparsa. Un cliente non trovato non e' un errore — nella tabella dei clienti
 * ci sono solo quelli che hanno acconsentito al marketing, quindi "non trovato"
 * e' spesso la risposta giusta.
 */
export async function identifyVisitor(
  supabase: SupabaseClient,
  params: SeenVisitor & { email?: string | null; phone?: string | null },
  provision?: ProvisionUsersTable,
): Promise<IdentifyResult> {
  const { email, phone, ...visitor } = params;

  await recordUserSeen(supabase, visitor, provision);

  const cleanEmail = normalizeEmail(email);
  const cleanPhone = normalizePhone(phone);
  if (!cleanEmail && !cleanPhone) {
    return { outcome: 'no_identifier', canonical: null, merged: [] };
  }

  const found = await findCustomerId(supabase, cleanEmail, cleanPhone);
  if (found === 'failed') return { outcome: 'failed', canonical: null, merged: [] };
  if (found === null) return { outcome: 'no_match', canonical: null, merged: [] };

  const link = await linkUserToCustomer(
    supabase,
    { ...visitor, shopifyCustomerId: found },
    provision,
  );

  return {
    outcome: link.outcome === 'linked' ? 'linked' : 'failed',
    canonical: link.canonical,
    merged: link.merged,
  };
}

/**
 * Il cliente dietro un'email o un telefono.
 *
 * Prima l'email, poi il telefono: l'email e' l'identificativo che i clienti
 * scrivono sempre uguale, mentre lo stesso numero puo' stare su piu' anagrafiche
 * di una famiglia. Cercare prima quella piu' precisa evita di legare il browser
 * alla persona sbagliata quando arrivano tutti e due.
 */
async function findCustomerId(
  supabase: SupabaseClient,
  email: string | null,
  phone: string | null,
): Promise<number | null | 'failed'> {
  for (const [column, value] of [
    ['email_address', email],
    ['phone_number', phone],
  ] as const) {
    if (!value) continue;

    const { data, error } = await supabase
      .from('customers')
      .select('shopify_customer_id')
      .eq(column, value)
      .limit(1);

    // Una tabella clienti che non esiste non e' un guasto: e' un piano che non
    // la prevede. Non si trova nessuno, e va bene cosi'.
    if (error) {
      if (isMissingTable(error)) return null;
      console.warn(`[users] ricerca del cliente fallita: ${error.message ?? 'errore sconosciuto'}`);
      return 'failed';
    }

    const id = Array.isArray(data) ? Number(data[0]?.shopify_customer_id) : NaN;
    if (Number.isFinite(id)) return id;
  }

  return null;
}

/**
 * La potatura: via le righe mai identificate e ferme da troppo tempo.
 *
 * Il filtro e' esattamente `shopify_customer_id IS NULL AND last_seen_at <
 * soglia`, e le due condizioni devono valere ENTRAMBE. Una riga legata a un
 * cliente non si tocca nemmeno se sono anni che non si vede: e' proprio quella
 * che serve a riconoscerlo al ritorno, ed e' l'unica per cui il tempo lavora a
 * favore. Una riga mai identificata invece non lo diventera' mai — non e' che
 * non si sia ancora capito chi fosse, e' che quella persona non e' mai passata
 * dalla cassa — e oltre la soglia il browser ha comunque buttato via il cookie
 * che la portava.
 *
 * Restituisce quante ne ha tolte, per poterlo dire nel riepilogo del cron.
 */
export async function pruneAnonymousUsers(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<number> {
  const { data, error } = await supabase
    .from(USERS_TABLE)
    .delete()
    .is('shopify_customer_id', null)
    .lt('last_seen_at', anonymousUserCutoff(now).toISOString())
    .select('external_id');

  if (error) {
    // Una tabella che non c'e' non ha niente da potare: e' il caso normale di
    // un negozio che non ha ancora ricevuto l'aggiornamento dello schema.
    if (!isMissingTable(error)) {
      console.warn(`[users] potatura fallita: ${error.message ?? 'errore sconosciuto'}`);
    }
    return 0;
  }

  return Array.isArray(data) ? data.length : 0;
}
