import type { Dictionary } from '~/lib/i18n/context';

const TABLE_CREATION_TYPES = new Set([
  'table_create_products',
  'table_create_customers',
  'table_create_both',
]);

/**
 * null se il job non e' un evento di creazione tabelle.
 *
 * Una frase sola per tutti e tre i tipi: quali tabelle siano nate lo dice il
 * dettaglio, e tre varianti di titolo per la stessa notizia facevano sembrare
 * diverse tre corse che diverse non sono.
 */
export function tableCreationMessage(jobType: string, t: Dictionary): string | null {
  return TABLE_CREATION_TYPES.has(jobType) ? t.logs.tableCreated : null;
}

// Il modo in cui il database dice che una tabella non c'e': o non esiste
// davvero, o non e' ancora nella copia dello schema che l'API REST tiene in
// memoria. Per chi legge il log e' la stessa notizia.
const TABLE_MISSING = /could not find the table|does not exist|relation .* does not exist|42P01/i;

/**
 * L'errore di un job come va letto dal merchant.
 *
 * Gli errori arrivano dalle librerie, quindi in inglese e con dentro nomi di
 * tabelle e codici: nel log del negozio non dicono nulla a chi li legge. I casi
 * che sappiamo riconoscere li traduciamo in una frase sola; gli altri passano
 * come sono — meglio un errore tecnico che nessun errore.
 */
export function syncErrorMessage(raw: string | null | undefined, t: Dictionary): string {
  const text = (raw ?? '').trim();
  if (!text) return t.logs.unknownError;

  if (TABLE_MISSING.test(text)) {
    if (/customer|client/i.test(text)) return t.logs.missingCustomersTable;
    if (/product|prodott/i.test(text)) return t.logs.missingProductsTable;
  }

  return text;
}

/** I contatori di un job, gli unici campi che servono per sapere se c'e' dettaglio. */
export interface SyncJobCounters {
  productsAdded: number;
  productsRemoved: number;
  customersAdded: number;
  customersUpdated: number;
  customersSuspended: number;
}

/**
 * Se questa sincronizzazione ha davvero cambiato qualcosa.
 *
 * Serve a decidere se offrire "Vedi dettagli": una corsa che non ha aggiunto,
 * rimosso, aggiornato o sospeso niente non ha nulla da mostrare, e aprire un
 * modal vuoto fa credere al merchant che l'app abbia perso i dati. Vale anche
 * per tutte le sincronizzazioni precedenti all'introduzione del dettaglio: i
 * loro contatori sono a zero perche' nessuno li ha mai scritti.
 */
export function hasSyncDetail(job: SyncJobCounters): boolean {
  return (
    job.productsAdded > 0 ||
    job.productsRemoved > 0 ||
    job.customersAdded > 0 ||
    job.customersUpdated > 0 ||
    job.customersSuspended > 0
  );
}

export interface StatusBadge {
  tone: 'success' | 'critical' | 'info' | 'attention';
  label: string;
}

/**
 * Lo stato della corsa, come si legge.
 *
 * Tre stati diventano quattro, e il quarto e' quello che mancava: una
 * sincronizzazione che ha scritto quasi tutto non e' "completata". Prima lo
 * diventava — la corsa ignorava una manciata di errori e si dichiarava
 * conclusa — e il merchant leggeva un successo mentre qualche suo prodotto
 * restava indietro. "Parziale" resta finche' quello che manca non e' stato
 * rimesso a posto, e allora diventa "Completata" da sola.
 */
export function syncStatusBadge(status: string, t: Dictionary): StatusBadge {
  if (status === 'completed') return { tone: 'success', label: t.logs.status.completed };
  if (status === 'completed_with_repairs') {
    return { tone: 'attention', label: t.logs.status.partial };
  }
  if (status === 'failed') return { tone: 'critical', label: t.logs.status.failed };
  return { tone: 'info', label: t.logs.status.running };
}

// Formatta SEMPRE nel fuso indicato, mai in quello della macchina: cosi' il
// render sul server e l'idratazione sul client producono la stessa stringa
// (niente disallineamento) e il merchant legge l'orario del proprio negozio.
// Fallback UTC se il fuso manca o non e' valido: deterministico comunque.
function formatIn(iso: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date(iso))
    .replace(',', '');
}

export function formatDateTime(
  iso: string,
  timeZone: string | null | undefined,
  locale: string,
): string {
  try {
    return formatIn(iso, timeZone || 'UTC', locale);
  } catch {
    // Fuso non riconosciuto dall'ambiente: non deve rompere la pagina.
    return formatIn(iso, 'UTC', locale);
  }
}
