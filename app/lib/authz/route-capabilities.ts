import type { Capability } from './capabilities';

/**
 * Quale permesso chiede ogni rotta — scritto in un posto solo.
 *
 * PERCHE' UNA TABELLA E NON SOLO IL CODICE DELLE ROTTE. Perche' il difetto da
 * cui questa tabella nasce non era una rotta scritta male: era una rotta
 * dimenticata. Le rotte che servivano dati autenticavano l'amministratore e
 * poi leggevano, e nessuno se ne accorgeva perche' non c'era nessun posto in
 * cui la mancanza si vedesse — bisognava aprirle una per una e notare cosa NON
 * c'era. Una riga che manca non la si nota mai.
 *
 * Qui invece ogni rotta ha una riga, e le righe si contano: il test accanto
 * elenca i file veri su disco e pretende che ognuno compaia. Una rotta di
 * lettura aggiunta domani e lasciata fuori non passa, e chi la scrive e'
 * costretto a dichiarare — per iscritto, qui — o quale permesso chiede o
 * perche' non ne chiede nessuno. La seconda meta' conta quanto la prima: le
 * rotte aperte ci sono e devono restarci, ma devono essere aperte per una
 * ragione che qualcuno ha scritto e non per distrazione.
 *
 * Modulo puro: nessun import da un `.server`, cosi' il test lo puo' leggere
 * senza tirarsi dietro il database.
 */

/** Una rotta che chiede un permesso, e da dove lo chiede. */
interface GuardedRoute {
  readonly guard: 'capability';
  readonly capability: Capability;
  /**
   * La funzione con cui la rotta chiede il permesso.
   *
   * Quasi sempre `requireShopCapability`. Le eccezioni sono le rotte che non
   * passano dall'amministratore — i feed, il proxy di lettura, l'ingest — e
   * che un negozio se lo risolvono da se', da un token invece che da una
   * sessione: la policy interrogata e' la stessa, la strada per arrivarci no.
   * Il test cerca questo nome nel file, quindi una rotta dichiarata protetta e
   * lasciata scoperta non passa.
   */
  readonly via?: string;
  /**
   * Il loader e' deliberatamente aperto: solo l'action chiede il permesso. Il
   * testo dice perche', e vale come la ragione di una rotta aperta.
   */
  readonly actionOnly?: string;
}

/** Una rotta senza permesso, con scritto il perche'. */
interface OpenRoute {
  readonly guard: 'open';
  readonly reason: string;
}

export type RouteCapabilityRule = GuardedRoute | OpenRoute;

/** Il nome della funzione che si cerca quando la rotta non ne dichiara un'altra. */
export const DEFAULT_GUARD_CALL = 'requireShopCapability';

/**
 * Le vie d'uscita, e perche' non si chiudono mai.
 *
 * Un negozio sospeso, con la prova finita o con la cancellazione in corso non
 * e' un negozio a cui si toglie tutto: e' un negozio che ha ancora tre cose da
 * poter fare — pagare per tornare operativo, portarsi via i propri dati, e
 * andarsene. Chiudere queste sarebbe peggio del difetto che tutto il resto di
 * questa tabella ripara: un merchant che non puo' aggiornare il piano non ha
 * nessuna strada per riaccendere l'app, e uno che non puo' esportare i suoi
 * dati prima di disinstallare li perde.
 */
const USCITA_FATTURAZIONE =
  "Via d'uscita: e' con questa che un negozio fermo torna operativo. Chiuderla " +
  'lascerebbe il merchant senza nessuna strada per riaccendere l’app.';
const USCITA_CANCELLAZIONE =
  "Via d'uscita: scollegarsi e farsi eliminare i dati non puo’ dipendere " +
  "dall'avere un abbonamento attivo — sarebbe tenere il merchant chiuso dentro " +
  'con i propri dati ancora da noi. Due cancellazioni insieme le impedisce il ' +
  'lucchetto in `deleteMerchantData`, che e’ il posto dove si sa se ce n’e’ ' +
  'gia’ una in corso.';

const USCITA_PRIVACY =
  "Via d'uscita: i propri dati si scaricano anche — soprattutto — quando l'app " +
  'non si puo’ piu’ usare.';

/**
 * I webhook non sono rotte del merchant.
 *
 * Nessuna sessione da autenticare: chi bussa e' Shopify, e lo dimostra con la
 * firma HMAC che `authenticate.webhook` verifica. Il permesso lo chiedono i
 * gestori — `handle-product`, `handle-customer`, `handle-order` — un istante
 * prima di scrivere sul database del merchant, e li' non poteva stare da
 * nessun'altra parte: un webhook si rifiuta rispondendo 200 e non facendo
 * niente, perche' un 403 a Shopify vuol dire "riprova", e riprovare per un
 * negozio sospeso e' un tentativo che non finira' mai.
 */
const WEBHOOK =
  "Firmata da Shopify, non da un amministratore. Il permesso lo chiedono i " +
  'gestori prima di scrivere, dove un rifiuto si puo\u2019 esprimere senza dire ' +
  'a Shopify di riprovare all\u2019infinito.';

export const ROUTE_CAPABILITIES: Readonly<Record<string, RouteCapabilityRule>> = {
  // --- Dashboard, statistiche, dati del merchant -------------------------
  _index: {
    guard: 'capability',
    capability: 'use_app',
    via: 'capabilityDenialResponse',
    actionOnly:
      "La dashboard e' la schermata di stato: e' li' che il merchant legge il " +
      "banner che spiega perche' e' fermo e trova il modo di rimediare. " +
      'Chiuderne il loader vorrebbe dire togliergli anche la spiegazione. I ' +
      'suoi numeri non vengono da qui: ognuno ha la sua rotta, e quelle sono ' +
      'tutte protette.',
  },
  'api.stats.counts': { guard: 'capability', capability: 'use_app' },
  'api.stats.customers': { guard: 'capability', capability: 'use_app' },
  'api.stats.product-history': { guard: 'capability', capability: 'use_app' },
  'api.stats.products': { guard: 'capability', capability: 'use_app' },
  'api.stats.profit': { guard: 'capability', capability: 'use_app' },
  'api.stats.top-products': { guard: 'capability', capability: 'use_app' },
  'api.product-scope': { guard: 'capability', capability: 'use_app' },
  'api.sync-job.$id.details': { guard: 'capability', capability: 'use_app' },
  customers: { guard: 'capability', capability: 'use_app' },
  'products.issues': { guard: 'capability', capability: 'use_app' },
  logs: { guard: 'capability', capability: 'use_app' },
  'catalogs._index': { guard: 'capability', capability: 'use_app' },
  'catalogs.google': { guard: 'capability', capability: 'use_app' },
  'catalogs.meta': { guard: 'capability', capability: 'use_app' },

  // --- Tracciamento (configurazione, dall'admin) -------------------------
  'api.tracking.confirm': { guard: 'capability', capability: 'use_app' },
  'api.tracking.conflicts': { guard: 'capability', capability: 'use_app' },
  'api.tracking.dismiss': { guard: 'capability', capability: 'use_app' },
  'api.tracking.ingest-key': { guard: 'capability', capability: 'use_app' },
  'api.tracking.install': { guard: 'capability', capability: 'use_app' },
  'api.tracking.setup': { guard: 'capability', capability: 'use_app' },
  'api.tracking.verify': { guard: 'capability', capability: 'use_app' },

  // --- Collegamento Supabase: i gesti che creano o collegano -------------
  'api.supabase.create-project': { guard: 'capability', capability: 'use_app', via: 'can(' },
  'api.supabase.create-tables': { guard: 'capability', capability: 'use_app', via: 'can(' },
  'api.supabase.delete-project': { guard: 'open', reason: USCITA_CANCELLAZIONE },
  'api.supabase.disconnect': { guard: 'open', reason: USCITA_CANCELLAZIONE },
  'api.supabase.oauth-url': { guard: 'capability', capability: 'use_app', via: 'can(' },
  'api.supabase.select-project': { guard: 'capability', capability: 'use_app', via: 'can(' },

  // --- Rotte che un negozio se lo risolvono da un token, non da una sessione
  'feed.$file': { guard: 'capability', capability: 'use_feeds', via: 'shopCapabilitiesById' },
  'rest.v1.$table': {
    guard: 'capability',
    capability: 'use_read_proxy',
    via: 'resolveShopReadContext',
  },
  'rest.v1.identify': {
    guard: 'capability',
    capability: 'ingest_tracking',
    via: 'authorizeIngest',
  },
  'rest.v1.tracking_id': {
    guard: 'capability',
    capability: 'ingest_tracking',
    via: 'authorizeIngest',
  },
  'rest.v1.users': {
    guard: 'capability',
    capability: 'ingest_tracking',
    via: 'authorizeIngest',
  },

  // --- Vie d'uscita: non si chiudono mai ---------------------------------
  plan: { guard: 'open', reason: USCITA_FATTURAZIONE },
  'billing.subscribe': { guard: 'open', reason: USCITA_FATTURAZIONE },
  'billing.callback': { guard: 'open', reason: USCITA_FATTURAZIONE },
  'api.plan.limits': {
    guard: 'open',
    reason:
      USCITA_FATTURAZIONE +
      " Qui non esce nessun dato del negozio: solo il listino e il piano in uso, " +
      "che sono cio' che la schermata del cambio piano deve poter mostrare.",
  },
  'privacy.my-data': { guard: 'open', reason: USCITA_PRIVACY },
  'privacy.export.$id': { guard: 'open', reason: USCITA_PRIVACY },
  'settings.supabase': {
    guard: 'open',
    reason:
      "E' la schermata da cui si scollega il database e si chiede di eliminare i " +
      "dati: e' la porta d'uscita, e un negozio fermo deve poterci entrare. Quel " +
      'che si legge qui e’ la sua configurazione, non i suoi dati.',
  },
  'api.supabase.migrate': {
    guard: 'open',
    reason:
      'Riallineamento delle tabelle del merchant. La rotta lo dichiara gia’ nel ' +
      'suo commento: e’ manutenzione del database del merchant, non uso ' +
      "dell'app, e un negozio sospeso deve poterlo fare.",
  },
  'api.supabase.account': {
    guard: 'open',
    reason:
      'Legge il solo account Supabase del merchant, dal token che ha dato lui. ' +
      'Nessun dato del negozio, e serve a rifare un collegamento rotto — che e’ ' +
      'un gesto di riparazione, non di uso.',
  },
  'api.supabase.database-pause': {
    guard: 'open',
    reason:
      "Dice se il database del merchant e' fermo, e chiede a Supabase di " +
      'riaccenderlo. Nessun dato del negozio esce di qui: si legge uno stato e ' +
      'si preme un pulsante su un progetto che e’ suo. Aperta per la stessa ' +
      'ragione di `api.supabase.migrate`: e’ manutenzione del suo database, ' +
      "non uso dell'app — e un negozio fermo per qualunque motivo deve poter " +
      'riaccendere il proprio database, tanto piu’ perche’ oltre una certa ' +
      'data Supabase non lo riaccende piu’.',
  },
  'api.supabase.auto-resume': {
    guard: 'open',
    reason:
      "E' l'interruttore con cui il merchant dice se l'app debba riaccendere da " +
      'sola il suo database prima della scadenza. Aperta per la ragione opposta ' +
      'a quella solita: non e’ una funzione che si concede, e’ un NO che si deve ' +
      'poter dire sempre. Un negozio sospeso, con la prova finita o in ' +
      'cancellazione e’ proprio quello a cui l’app non deve toccare ' +
      'l’infrastruttura, e negargli questa rotta vorrebbe dire lasciarlo senza ' +
      'il modo di impedirlo. Non legge e non scrive nessun dato del negozio: ' +
      'solo la sua scelta.',
  },
  'api.supabase.link-status': {
    guard: 'open',
    reason: "Dice soltanto se il collegamento c'e'. Nessun dato del negozio.",
  },
  'api.supabase.project-limits': {
    guard: 'open',
    reason: 'Limiti del piano Supabase del merchant. Nessun dato del negozio.',
  },
  'api.supabase.project-status': {
    guard: 'open',
    reason: 'Stato del progetto Supabase del merchant. Nessun dato del negozio.',
  },
  'api.supabase.projects': {
    guard: 'open',
    reason: 'Elenco dei progetti del suo account Supabase. Nessun dato del negozio.',
  },
  'api.supabase.regions': {
    guard: 'open',
    reason: 'Elenco delle regioni Supabase: e’ un listino, uguale per tutti.',
  },
  'api.supabase.test-connection': {
    guard: 'open',
    reason:
      'Verifica che le credenziali rispondano. Non legge righe: e’ il gesto con ' +
      'cui si accorge che il collegamento e’ rotto, e va lasciato a chiunque.',
  },

  // --- Rotte che non parlano con un amministratore -----------------------
  'api.locale': {
    guard: 'open',
    reason:
      'Lingua e valuta dell’interfaccia. Non legge e non scrive dati del ' +
      'negozio, e serve anche a chi sta solo leggendo il banner che lo avvisa ' +
      "che l'app e' ferma.",
  },
  'api.cron.sync': {
    guard: 'open',
    reason:
      'Non e’ una rotta del merchant: la chiama il cron con il proprio segreto, ' +
      'e per ogni negozio che tocca chiede la policy da se’ prima di lavorarci.',
  },
  'api.health': {
    guard: 'open',
    reason: 'Stato del servizio, non di un negozio.',
  },
  'auth.$': {
    guard: 'open',
    reason:
      "E' l'installazione: chiedere un permesso qui vorrebbe dire chiederlo " +
      'prima che esista qualcuno a cui darlo.',
  },
  'auth.supabase.callback': {
    guard: 'open',
    reason:
      'Ritorno di OAuth da Supabase: si identifica dallo stato firmato che ha ' +
      'emesso l’app, non da una sessione.',
  },
  'tracking.bridge[.]js': {
    guard: 'open',
    reason:
      'File statico servito alla vetrina. Non contiene dati: il permesso lo ' +
      'chiedono le rotte che lo script poi interroga.',
  },
  'privacy-policy': {
    guard: 'open',
    reason:
      "E' l'informativa sulla privacy, e un'informativa che per essere letta " +
      "chiede di autenticarsi non e' un'informativa: la leggono il revisore " +
      'Shopify prima che l’app sia installata da nessuno, e chiunque riceva ' +
      'il link. Non c’e’ nessun negozio da identificare e non esce di qui ' +
      'nessun dato: e’ lo stesso documento per tutti, lo stesso che sta in ' +
      '`docs/legal/`.',
  },
  '[robots.txt]': {
    guard: 'open',
    reason:
      'File pubblico servito ai motori di ricerca: non c\u2019e\u2019 nessun negozio da ' +
      'identificare e niente dentro che appartenga a qualcuno.',
  },
  $: {
    guard: 'open',
    reason:
      'Rotta di riserva per gli indirizzi che non esistono: risponde 404 e non ' +
      'legge niente. Un permesso qui non avrebbe niente da proteggere.',
  },

  // --- Webhook: firma di Shopify, e policy dentro i gestori --------------
  'webhooks.app-subscriptions.update': { guard: 'open', reason: WEBHOOK },
  'webhooks.app.uninstalled': { guard: 'open', reason: WEBHOOK },
  'webhooks.customers.create': { guard: 'open', reason: WEBHOOK },
  'webhooks.customers.delete': { guard: 'open', reason: WEBHOOK },
  'webhooks.customers.update': { guard: 'open', reason: WEBHOOK },
  'webhooks.gdpr.customers-redact': { guard: 'open', reason: WEBHOOK },
  'webhooks.gdpr.data-request': { guard: 'open', reason: WEBHOOK },
  'webhooks.gdpr.shop-redact': { guard: 'open', reason: WEBHOOK },
  'webhooks.orders': { guard: 'open', reason: WEBHOOK },
  'webhooks.orders.delete': { guard: 'open', reason: WEBHOOK },
  'webhooks.products.create': { guard: 'open', reason: WEBHOOK },
  'webhooks.products.delete': { guard: 'open', reason: WEBHOOK },
  'webhooks.products.update': { guard: 'open', reason: WEBHOOK },
};

/**
 * Il nome del file di rotta, come la tabella lo scrive.
 *
 * Remix chiama le rotte dal nome del file: `app/routes/customers.tsx` e' la
 * rotta `customers`. Qui si toglie solo il suffisso, cosi' chi legge la tabella
 * ritrova gli stessi nomi che vede nella cartella.
 */
export function routeIdOf(fileName: string): string {
  return fileName.replace(/\.tsx$/, '');
}

/**
 * Le rotte che esistono su disco e non compaiono nella tabella.
 *
 * E' la meta' che impedisce al difetto di tornare: una rotta nuova, aggiunta
 * domani, non passa finche' qualcuno non dichiara qui che permesso chiede —
 * oppure perche' non ne chiede nessuno. Il test la chiama sui file veri, e la
 * chiama anche su un elenco finto con dentro una rotta inventata, per provare
 * che quando manca qualcosa se ne accorge davvero.
 */
export function routesWithoutRule(routeIds: readonly string[]): string[] {
  return routeIds.filter((id) => !(id in ROUTE_CAPABILITIES));
}

/**
 * Le righe della tabella che non corrispondono piu' a nessun file.
 *
 * Una rotta cancellata lascia qui una riga che continua a raccontare una
 * protezione che non c'e' piu': e' il modo in cui una tabella smette di essere
 * una descrizione e diventa un ricordo.
 */
export function rulesWithoutRoute(routeIds: readonly string[]): string[] {
  const presenti = new Set(routeIds);
  return Object.keys(ROUTE_CAPABILITIES).filter((id) => !presenti.has(id));
}

/** Il nome che deve comparire nel file, per una rotta che dichiara un permesso. */
export function guardCallOf(rule: RouteCapabilityRule): string | null {
  return rule.guard === 'capability' ? (rule.via ?? DEFAULT_GUARD_CALL) : null;
}
