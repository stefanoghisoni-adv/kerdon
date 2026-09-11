// app/lib/privacy/shop-export.ts
//
// La copia dei dati del negozio, nella forma in cui si consegna.
//
// PERCHE' ESISTE, visto che Shopify non la chiede. Shopify prescrive i tre
// webhook di conformita' e il modo di rispondere a un cliente che chiede i
// suoi dati; su cosa un'app debba dare al MERCHANT che chiede i propri non
// dice niente, ne' qui ne' altrove. Il diritto di accesso pero' vale lo
// stesso, e chi ha installato l'app e' una persona come le altre: il file lo
// prepariamo perche' e' dovuto a lei, non perche' ce lo chieda Shopify.
//
// COSA CONTIENE, e perche' proprio questo. Prodotti, clienti e ordini non ci
// sono: quelli stanno nel database del merchant, sono suoi, e ce li ha gia'
// davanti. Qui c'e' cio' che conserviamo NOI e che altrimenti non potrebbe
// vedere — chi e' il negozio, cosa ha pagato, come e' configurato, cosa
// abbiamo sincronizzato e chi ha letto i dati dei suoi clienti attraverso di
// noi.
//
// COSA NON CONTIENE, e questa e' la parte che va tenuta ferma. Nessun segreto:
// non il token di Shopify, non le chiavi del progetto Supabase, non il token
// del proxy di lettura, nemmeno nella forma cifrata in cui li teniamo. Sono
// credenziali, non dati personali, e un file scaricato resta su un disco per
// sempre. `SEGRETI_ESCLUSI` li elenca per nome e un test lo rilegge: aggiungere
// una colonna segreta al modello senza aggiungerla qui deve rompere qualcosa.

import { readInstallState } from '~/lib/tracking/install';

/**
 * I nomi che non possono comparire nel file, a nessun livello.
 *
 * Elencati e non dedotti: dedurli da un prefisso ("token", "key") sembra piu'
 * furbo finche' non arriva la colonna che si chiama in un altro modo.
 */
export const SEGRETI_ESCLUSI = [
  'accessToken',
  'access_token',
  'readProxyTokenHash',
  'readProxyTokenEnc',
  'read_proxy_token_hash',
  'read_proxy_token_enc',
  'supabasePublicKey',
  'supabaseServiceRoleKey',
  'supabase_public_key',
  'supabase_service_role_key',
  'callbackNonce',
  'callback_nonce',
  'accessTokenEnc',
  'refreshTokenEnc',
  // La credenziale di invio: il segreto sigillato e l'impronta del valore. Non
  // e' nell'esportazione e non deve diventarci — e' una credenziale, non un
  // dato personale, e un file scaricato resta su un disco per sempre.
  'secretCipher',
  'secret_cipher',
  'valueHash',
  'value_hash',
  'export',
] as const;

export interface ShopExportRows {
  shop: {
    shopDomain: string;
    primaryDomain: string | null;
    installedAt: Date;
    uninstalledAt: Date | null;
    ianaTimezone: string | null;
    shopCurrency: string | null;
    locale: string | null;
    preferredCurrency: string | null;
    currentPlan: string;
    billingCycle: string | null;
    billingCurrency: string | null;
    planStartedAt: Date | null;
    trialEndsAt: Date | null;
    isInTrial: boolean;
    partnerName: string | null;
    discountIntervals: number | null;
    scopes: string;
    authorization: string;
    trackingAuthorization: string;
    setupCompletedAt: Date | null;
    birthdateMetafieldNamespace: string | null;
    birthdateMetafieldKey: string | null;
  };
  supabaseConfig: {
    supabaseUrl: string;
    supabaseProjectRef: string | null;
    supabaseProjectName: string | null;
    tableNameProducts: string;
    tableNameCustomers: string;
    syncIntervalHours: number;
    connectionVerifiedAt: Date | null;
    schemaVersion: number;
    createdAt: Date;
  } | null;
  trackingSetup: {
    answer: string;
    platforms: string[];
    answeredAt: Date;
    installPath: string | null;
    endpoint: string | null;
    verifiedAt: Date | null;
  } | null;
  billingCharges: Array<{
    planType: string;
    price: unknown;
    currency: string | null;
    billingCycle: string | null;
    status: string;
    trialDays: number;
    activatedAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
  }>;
  syncJobs: Array<{
    jobType: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    productsSynced: number;
    variantsSynced: number;
    customersSynced: number;
  }>;
  complianceRequests: Array<{ topic: string; status: string; receivedAt: Date }>;
  accessLogs: Array<{ outcome: string; status: number; createdAt: Date }>;
}

/** Una data come la scrive un file, o niente se non c'e'. */
function quando(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Il prezzo come stringa.
 *
 * Prisma restituisce un Decimal, che in JSON diventerebbe un oggetto con dentro
 * la sua rappresentazione interna. Un importo si legge come lo si scrive.
 */
function importo(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * Il file, come lo riceve il merchant.
 *
 * Le chiavi sono in italiano perche' lo legge una persona, non una macchina:
 * non c'e' nessuno che lo consumi via API, e "sincronizzazioni" dice di piu' di
 * "syncJobs" a chi apre il file per capire cosa teniamo di lui.
 */
export function buildShopExport(rows: ShopExportRows, generatoIl: Date) {
  const s = rows.shop;
  const installazione = readInstallState(rows.trackingSetup);
  return {
    generato_il: generatoIl.toISOString(),
    cosa_e_questo:
      "Una copia di tutto cio' che Kerdon conserva sul tuo negozio. I dati dei tuoi " +
      'clienti, dei prodotti e degli ordini non sono qui: quelli stanno nel database ' +
      'che hai collegato, sono tuoi, e li leggi da li. Le credenziali di accesso sono ' +
      'escluse di proposito.',

    negozio: {
      dominio: s.shopDomain,
      dominio_principale: s.primaryDomain,
      installato_il: quando(s.installedAt),
      disinstallato_il: quando(s.uninstalledAt),
      fuso_orario: s.ianaTimezone,
      valuta_del_negozio: s.shopCurrency,
      lingua_scelta: s.locale,
      valuta_scelta: s.preferredCurrency,
      permessi_concessi: s.scopes.split(',').filter(Boolean),
      configurazione_completata_il: quando(s.setupCompletedAt),
      stato_app: s.authorization,
      stato_tracciamento: s.trackingAuthorization,
      campo_data_di_nascita:
        s.birthdateMetafieldNamespace && s.birthdateMetafieldKey
          ? `${s.birthdateMetafieldNamespace}.${s.birthdateMetafieldKey}`
          : null,
    },

    piano: {
      attuale: s.currentPlan,
      periodicita: s.billingCycle,
      valuta_di_fatturazione: s.billingCurrency,
      iniziato_il: quando(s.planStartedAt),
      prova_in_corso: s.isInTrial,
      prova_termina_il: quando(s.trialEndsAt),
      partner: s.partnerName,
      cicli_agevolati: s.discountIntervals,
    },

    abbonamenti: rows.billingCharges.map((c) => ({
      piano: c.planType,
      prezzo: importo(c.price),
      valuta: c.currency,
      periodicita: c.billingCycle,
      stato: c.status,
      giorni_di_prova: c.trialDays,
      attivato_il: quando(c.activatedAt),
      annullato_il: quando(c.cancelledAt),
      creato_il: quando(c.createdAt),
    })),

    database_collegato: rows.supabaseConfig
      ? {
          indirizzo: rows.supabaseConfig.supabaseUrl,
          progetto: rows.supabaseConfig.supabaseProjectRef,
          nome_progetto: rows.supabaseConfig.supabaseProjectName,
          tabella_prodotti: rows.supabaseConfig.tableNameProducts,
          tabella_clienti: rows.supabaseConfig.tableNameCustomers,
          ore_fra_una_sincronizzazione_e_l_altra: rows.supabaseConfig.syncIntervalHours,
          collegato_il: quando(rows.supabaseConfig.connectionVerifiedAt),
          versione_struttura: rows.supabaseConfig.schemaVersion,
          creato_il: quando(rows.supabaseConfig.createdAt),
        }
      : null,

    // La colonna `platforms` porta due cose: i nomi che il merchant ha spuntato
    // e le voci con cui registriamo la strada di installazione. In una copia dei
    // dati vanno separate — un elenco di piattaforme con dentro `kerdon:install=…`
    // non e' l'elenco di niente — e la strada scelta va detta lo stesso, perche'
    // e' un dato del negozio come gli altri.
    tracciamento: rows.trackingSetup
      ? {
          risposta: rows.trackingSetup.answer,
          piattaforme: rows.trackingSetup.platforms,
          installazione: installazione.path,
          endpoint: installazione.endpoint,
          verificato_il: quando(installazione.verifiedAt),
          risposto_il: quando(rows.trackingSetup.answeredAt),
        }
      : null,

    sincronizzazioni: rows.syncJobs.map((j) => ({
      tipo: j.jobType,
      esito: j.status,
      iniziata_il: quando(j.startedAt),
      conclusa_il: quando(j.completedAt),
      prodotti: j.productsSynced,
      varianti: j.variantsSynced,
      clienti: j.customersSynced,
    })),

    richieste_privacy: rows.complianceRequests.map((r) => ({
      tipo: r.topic,
      esito: r.status,
      ricevuta_il: quando(r.receivedAt),
    })),

    // Chi ha letto i dati dei tuoi clienti passando da noi, e com'e' andata.
    // Senza indirizzi e senza identificativi: il merchant deve poter contare
    // gli accessi, non risalire alle persone.
    accessi_ai_dati_dei_clienti: rows.accessLogs.map((l) => ({
      esito: l.outcome,
      codice: l.status,
      quando: quando(l.createdAt),
    })),
  };
}

/**
 * Il nome del file.
 *
 * Il dominio dentro al nome perche' un merchant con piu' negozi si ritrova due
 * file nella cartella dei download e deve poterli distinguere senza aprirli.
 */
export function shopExportFilename(shopDomain: string, generatoIl: Date): string {
  const giorno = generatoIl.toISOString().slice(0, 10);
  const negozio = shopDomain.replace(/\.myshopify\.com$/, '').replace(/[^a-z0-9-]/gi, '-');
  return `coreward-${negozio}-${giorno}.json`;
}
