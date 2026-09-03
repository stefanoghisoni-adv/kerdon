import type { SupabaseClient } from '@supabase/supabase-js';
import { USERS_TABLE } from '~/lib/tracking/users';

/**
 * Cosa resta di un cliente quando ritira il consenso al marketing.
 *
 * I dati di una persona finiscono nel database del merchant perche' quella
 * persona ha acconsentito: e' la sola ragione per cui ce li abbiamo messi.
 * Quando il consenso viene ritirato, quella ragione non c'e' piu' — e non e'
 * abbastanza spegnere un interruttore lasciando la riga com'era.
 *
 * Prima si scriveva solo `accepts_marketing: false`. Bastava a far rispondere
 * 403 al proxy in lettura, e sembrava sufficiente: da fuori quel cliente non si
 * poteva piu' leggere. Ma il database e' del merchant, e il merchant ci entra
 * con le sue credenziali: nome, email, telefono e indirizzo di chi si era
 * cancellato restavano li' per sempre, leggibili, esportabili, sincronizzabili
 * altrove. Un consenso ritirato che lascia intatto tutto cio' che aveva
 * autorizzato non e' un consenso ritirato.
 *
 * Ora si svuotano le colonne che identificano la persona. La riga resta, e deve
 * restare, per due motivi diversi e altrettanto pratici:
 *
 *  - il proxy decide il rifiuto leggendo `accepts_marketing` su questa riga:
 *    senza riga non c'e' niente su cui leggerlo, e una lettura che non trova
 *    nulla non e' la stessa cosa di una rifiutata;
 *  - i numeri del negozio — quanti clienti, quanto hanno speso — sono fatti del
 *    negozio, non della persona, e restano veri anche senza sapere chi fosse.
 *
 * Se la persona torna a dare il consenso, la sincronizzazione successiva
 * riscrive tutto da Shopify, che e' sempre stata la fonte: qui non si perde
 * niente che non si possa ritrovare.
 */

/**
 * Le colonne che dicono CHI e', azzerate.
 *
 * Non ci sono `total_spent`, `total_profit`, `orders_count`, le date e lo
 * stato: quelli raccontano il negozio, non la persona. Non c'e' `shopify_customer_id`, che e'
 * la chiave con cui la riga si ritrova — e senza, ritirare il consenso due
 * volte creerebbe due righe orfane invece di aggiornare la stessa.
 */
export const WITHDRAWN_CUSTOMER_FIELDS = {
  accepts_marketing: false,
  email_address: null,
  phone_number: null,
  first_name: null,
  last_name: null,
  country: null,
  country_code: null,
  address: null,
  city: null,
  zipcode: null,
  region: null,
  date_of_birth: null,
  /**
   * I due identificativi dell'accesso con Meta e Google.
   *
   * Oggi sono sempre vuoti — il login non c'e' ancora — ma stanno in elenco da
   * subito: il giorno in cui cominceranno a riempirsi, chi ritira il consenso
   * non deve dipendere da qualcuno che si ricordi di aggiungerli qui. Sono
   * l'identita' pubblicitaria della persona sulle due piattaforme, che e'
   * esattamente cio' che ha smesso di autorizzare.
   */
  fb_login_id: null,
  google_login_id: null,
  /**
   * Anche il legame col browser se ne va.
   *
   * E' l'identificativo con cui si riconosce chi torna: lasciarlo vorrebbe dire
   * poter continuare a ricollegare la persona alle sue visite dopo che ha detto
   * di no. E' esattamente cio' che ha smesso di autorizzare.
   */
  external_id: null,
  /** Note scritte dal negozio sulla persona: parlano di lei, quindi vanno via. */
  note: null,
} as const;

/**
 * Il ripiego, quando la tabella non ha tutte quelle colonne.
 *
 * Le tabelle del merchant nascono al collegamento e non cambiano da sole: una
 * creata da una versione precedente puo' non avere `date_of_birth` o
 * `external_id`, e PostgREST rifiuta l'intera update per una colonna che non
 * conosce. In quel caso la marcatura del consenso deve passare comunque —
 * altrimenti si perderebbe anche il 403, cioe' la protezione che gia'
 * funzionava — e lo svuotamento arrivera' quando la tabella sara' allineata.
 */
export const WITHDRAWN_CUSTOMER_MINIMUM = { accepts_marketing: false } as const;

/**
 * Vero quando l'errore dice "questa colonna non esiste".
 *
 * PGRST204 e' il modo di PostgREST di dirlo; il 42703 di Postgres arriva quando
 * il messaggio passa dal database senza essere tradotto.
 */
export function isUnknownColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const message = error.message ?? '';
  return (
    code === 'PGRST204' ||
    code === '42703' ||
    /could not find the .* column|column .* does not exist/i.test(message)
  );
}

/**
 * Il legame fra un browser e la persona, sciolto.
 *
 * La tabella dei browser tiene la colonna con l'id del cliente: e' cio' che
 * permette di dire "queste visite sono di quella persona". Svuotare la riga del
 * cliente e lasciare intatto quel legame non avrebbe cambiato niente — la
 * persona sarebbe rimasta ricollegabile alle sue visite dal lato opposto.
 *
 * Si scioglie, non si cancella: la riga del browser resta, perche' quel browser
 * continua a esistere e a tornare, e perche' cancellarla e' la risposta a una
 * richiesta di cancellazione — che e' un'altra cosa, con un'altra procedura. Da
 * qui in poi e' una visita come tutte le altre, che non porta a nessuno.
 */
export const UNLINKED_BROWSER_FIELDS = { shopify_customer_id: null } as const;

/**
 * Vero quando l'errore dice "questa tabella non c'e'".
 *
 * La tabella dei browser esiste solo sui negozi che hanno acceso il
 * riconoscimento: sugli altri non c'e' niente da scollegare, e non e' un
 * guasto.
 */
export function isMissingTable(error: { code?: string; message?: string } | null): boolean {
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
 * Ritira il consenso su una o piu' persone, dove ha effetto.
 *
 * Due scritture, e servono entrambe: la riga del cliente perde cio' che diceva
 * chi fosse, e la riga del browser perde il legame con lui. Farne una sola
 * lascerebbe la persona ricollegabile dall'altro lato.
 *
 * Nessuna delle due crea righe: su un cliente mai sincronizzato, o su un
 * negozio che il riconoscimento non l'ha mai acceso, sono operazioni a vuoto.
 */
interface WriteResult {
  error: { message: string; code?: string } | null;
  count?: number | null;
}

export async function withdrawConsentFor(
  supabase: SupabaseClient,
  customersTable: string,
  customerIds: readonly (string | number)[],
): Promise<{ error: { message: string; code?: string } | null; unlinked: number }> {
  if (customerIds.length === 0) return { error: null, unlinked: 0 };

  const one = customerIds.length === 1;
  // Il tipo del costruttore di query di Supabase, ridotto ai due metodi che
  // servono: tenerlo intero qui dentro faceva esplodere l'inferenza, e non
  // aggiungeva niente — l'una o l'altra forma del filtro e' tutto cio' che
  // cambia fra un cliente solo e una corsa periodica.
  const target = (builder: unknown): PromiseLike<WriteResult> => {
    const filter = builder as {
      eq: (column: string, value: string | number) => PromiseLike<WriteResult>;
      in: (column: string, values: readonly (string | number)[]) => PromiseLike<WriteResult>;
    };
    return one
      ? filter.eq('shopify_customer_id', customerIds[0])
      : filter.in('shopify_customer_id', customerIds);
  };

  let result = await target(supabase.from(customersTable).update(WITHDRAWN_CUSTOMER_FIELDS));

  // Una tabella nata da una versione precedente puo' non avere tutte quelle
  // colonne, e PostgREST rifiuta l'intera update per una sola che non conosce.
  // Uno svuotamento rimandato e' meglio che perdere anche la marcatura del
  // consenso, che e' cio' su cui la lettura viene negata.
  if (isUnknownColumn(result.error)) {
    console.warn(
      `[consenso] ${customersTable} senza tutte le colonne: svuotamento parziale (${result.error?.message ?? ''})`,
    );
    result = await target(supabase.from(customersTable).update(WITHDRAWN_CUSTOMER_MINIMUM));
  }

  if (result.error) return { error: result.error, unlinked: 0 };

  return { error: null, unlinked: await unlinkBrowsersOf(supabase, customerIds) };
}

/**
 * Scioglie il legame fra i browser e le persone indicate.
 *
 * Sta a se' perche' i due punti che ritirano il consenso — la notifica in tempo
 * reale e la corsa periodica — hanno bisogni diversi sulla riga del cliente (la
 * seconda vuole sapere quali righe ha davvero toccato) ma identici su questa.
 *
 * Non fatale: se fallisce, il consenso e' comunque gia' marcato e nessuno legge
 * piu' quella persona. Il legame residuo si scioglie al giro dopo, e intanto se
 * ne sa il motivo.
 */
export async function unlinkBrowsersOf(
  supabase: SupabaseClient,
  customerIds: readonly (string | number)[],
): Promise<number> {
  if (customerIds.length === 0) return 0;

  const filter = supabase.from(USERS_TABLE).update(UNLINKED_BROWSER_FIELDS) as unknown as {
    eq: (column: string, value: string | number) => PromiseLike<WriteResult>;
    in: (column: string, values: readonly (string | number)[]) => PromiseLike<WriteResult>;
  };

  const result = await (customerIds.length === 1
    ? filter.eq('shopify_customer_id', customerIds[0])
    : filter.in('shopify_customer_id', customerIds));

  // Una tabella che non c'e' non e' un guasto: il riconoscimento dei browser e'
  // acceso solo su una parte dei negozi.
  if (result.error) {
    if (!isMissingTable(result.error)) {
      console.warn(
        `[consenso] legame browser-cliente non sciolto: ${result.error.message ?? 'errore sconosciuto'}`,
      );
    }
    return 0;
  }

  return result.count ?? 0;
}
