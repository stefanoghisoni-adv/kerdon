import type { Locale } from '~/lib/i18n/locales';
import type { CheckId } from './verify-checks';
import type { InstallPath } from './install';

/**
 * I testi della card dell'installazione, in italiano e in inglese.
 *
 * PERCHE' STANNO QUI E NON IN `lib/i18n/it.ts`, che e' il posto giusto. Quei due
 * file sono in mano a un altro lavoro in corso, e due modifiche allo stesso
 * dizionario si scontrano. Questo modulo ha la stessa forma — un oggetto per
 * lingua, scelto dalla stessa `Locale` — quindi il trasloco e' un taglia e
 * incolla: le chiavi non cambiano, cambia solo da dove le si legge.
 *
 * Finche' sta qui vale la stessa regola del dizionario grande: negli accenti
 * delle stringhe per il merchant si usano quelli veri, non l'apostrofo. Gli
 * apostrofi stanno nei commenti, che sono per noi.
 *
 * E LA STESSA REGOLA SUL CONTENUTO: qui non si nomina niente di come l'app e'
 * fatta dentro. Il merchant legge cosa deve installare e dove, dal suo punto di
 * vista. Che ci sia una tabella, una coda o un proxy non lo riguarda e non lo
 * aiuta.
 */

export interface InstallCopy {
  /** Il titolo della sezione dentro la card del tracciamento. */
  title: string;
  intro: string;
  /** L'etichetta del menu a tendina. */
  installLabel: string;
  choose: string;
  paths: Record<InstallPath, string>;
  pathHelp: Record<InstallPath, string>;
  steps: Record<InstallPath, string[]>;
  snippetLabel: string;
  endpointLabel: string;
  endpointHelp: string;
  endpointPlaceholder: Record<InstallPath, string>;
  save: string;
  saved: string;
  saveFailed: string;
  invalidEndpoint: string;
  verify: string;
  verifying: string;
  noEndpoint: string;
  statusLabel: string;
  statusVerified: string;
  statusToVerify: string;
  statusNotStarted: string;
  verifiedOn: (when: string) => string;
  passed: string;
  failed: string;
  checks: Record<CheckId, string>;
  reasons: Record<string, string>;
  /** La conservazione: un massimo tecnico, non una promessa. */
  retention: string;
}

const it: InstallCopy = {
  title: "Installazione",
  intro:
    "Il tracciamento si chiude nel tuo container server-side: è lui a ricevere la chiamata dalle pagine, a parlare con Kerdon e a scrivere il riconoscimento nel browser di chi visita. Kerdon è l’ultimo anello della catena e non sostituisce quello che hai già davanti.",
  installLabel: "Installazione",
  choose: "Scegli come installare",
  paths: {
    sgtm: "Google Tag Manager server-side",
  },
  pathHelp: {
    sgtm: "Per chi ha già un container server-side su un sottodominio del negozio.",
  },
  steps: {
    sgtm: [
      "Crea la chiave di invio in Connessione e credenziali di tracking, e tienila negli appunti: si vede una volta sola.",
      "Nel container server-side, apri Modelli → Modelli client → Nuovo, e importa il file kerdon-id-client.tpl.",
      "Crea un client con quel modello e compila i campi: il percorso su cui rispondere (/kerdon/id), l’indirizzo dell’app, la chiave di invio — quella intera, che comincia con kin_ — e il dominio del tuo negozio.",
      "Pubblica il container.",
      "Aggiungi alle pagine del negozio lo script qui sotto, nel tema prima di </head> oppure come tag personalizzato.",
      "Torna qui e premi Verifica installazione.",
    ],
  },
  snippetLabel: "Da aggiungere alle pagine del negozio",
  endpointLabel: "Indirizzo dell’endpoint sul tuo dominio",
  endpointHelp:
    "L’indirizzo a cui le pagine del negozio chiedono il riconoscimento. Deve stare sul dominio da cui si vede il negozio, ed essere in https: è questo che permette al riconoscimento di durare.",
  endpointPlaceholder: {
    sgtm: "https://sgtm.negozio.it/kerdon/id",
  },
  save: "Salva",
  saved: "Salvato",
  saveFailed: "Non è stato possibile salvare. Riprova.",
  invalidEndpoint: "Serve un indirizzo che cominci con https:// e abbia un dominio.",
  verify: "Verifica installazione",
  verifying: "Verifica in corso…",
  noEndpoint: "Scrivi prima l’indirizzo dell’endpoint.",
  statusLabel: "Stato installazione",
  statusVerified: "Verificata",
  statusToVerify: "Da verificare",
  statusNotStarted: "Non configurata",
  verifiedOn: (when: string) => `Verificata il ${when}`,
  passed: "Tutto a posto: il giro si chiude.",
  failed: "Qualcosa non torna. Sotto trovi cosa, e cosa cambiare.",
  checks: {
    endpoint_url: "L’indirizzo è sul tuo dominio",
    https: "L’indirizzo è in https",
    reachable: "L’endpoint risponde",
    no_redirect: "Risponde subito, senza rimandare altrove",
    consent_granted: "Con il consenso restituisce il riconoscimento",
    cookie_attributes: "Il riconoscimento viene scritto come si deve",
    consent_missing: "Senza consenso non scrive niente",
    consent_withdrawn: "Alla revoca cancella quello che c’era",
  },
  reasons: {
    not_run: "Non provato: c’è un problema prima di questo.",
    endpoint_malformed: "L’indirizzo non è scritto in modo valido.",
    endpoint_not_public: "L’indirizzo non è raggiungibile da internet.",
    endpoint_is_app: "L’indirizzo punta a Kerdon invece che al tuo dominio: da lì il riconoscimento non dura.",
    endpoint_is_shopify: "L’indirizzo punta a un dominio myshopify.com, dove non puoi mettere il tuo codice.",
    endpoint_not_first_party:
      "L’indirizzo è su un dominio diverso da quello del negozio: da lì il riconoscimento verrebbe cancellato dai browser.",
    not_https: "L’indirizzo non è in https.",
    unreachable: "Nessuna risposta. Controlla che sia pubblicato e che l’indirizzo sia esatto.",
    redirected: "L’indirizzo rimanda altrove. Punta direttamente a dove risponde.",
    no_identifier:
      "Con il consenso non ha restituito nessun riconoscimento. Controlla la chiave di invio nel client: va incollata intera, ed è quella che comincia con kin_.",
    endpoint_error: "L’endpoint ha risposto con un errore.",
    no_cookie: "Non scrive il riconoscimento nel browser.",
    cookie_not_secure: "Manca l’attributo Secure: senza, il riconoscimento viaggia in chiaro.",
    cookie_path: "Vale solo per una parte del sito: serve Path=/.",
    cookie_samesite: "Manca l’attributo SameSite.",
    cookie_session_only: "Dura solo finché la scheda resta aperta: manca una durata.",
    identifier_without_consent:
      "Restituisce un riconoscimento anche a chi non ha ancora risposto al banner. Non deve.",
    cookie_without_consent:
      "Scrive nel browser anche di chi non ha ancora risposto al banner. Non deve.",
    identifier_after_withdrawal: "Continua a restituire il riconoscimento dopo la revoca.",
    cookie_not_cleared: "Alla revoca non cancella quello che aveva scritto.",
  },
  retention:
    "Il riconoscimento chiede di restare nel browser fino a un anno. È un massimo tecnico, non una garanzia: dipende dal consenso, che si può ritirare in ogni momento, e dal browser, che può accorciarlo o cancellarlo.",
};

const en: InstallCopy = {
  title: "Installation",
  intro:
    "Tracking is completed by a piece that lives on your store's own domain: it receives the call from your pages, talks to Kerdon, and writes the recognition into the visitor's browser. Choose how to install it.",
  installLabel: "Installation",
  choose: "Choose how to install",
  paths: {
    sgtm: "Server-side Google Tag Manager",
  },
  pathHelp: {
    sgtm: "For stores that already run a server-side container on their own subdomain.",
  },
  steps: {
    sgtm: [
      "Create the sending key in tracking connection and credentials, and keep it at hand: it is shown only once.",
      "In your server-side container, open Templates → Client Templates → New, and import the kerdon-id-client.tpl file.",
      "Create a client from that template and fill in the fields: the path it answers on (/kerdon/id), the app address, the sending key — the whole key, the one starting with kin_ — and your store's domain.",
      "Publish the container.",
      "Add the snippet below to your store pages, in the theme before </head> or as a custom tag.",
      "Come back here and press Verify installation.",
    ],
  },
  snippetLabel: "Add this to your store pages",
  endpointLabel: "Endpoint address on your domain",
  endpointHelp:
    "The address your store pages ask for recognition. It has to sit on the domain your store is served from, and be https: that is what lets the recognition last.",
  endpointPlaceholder: {
    sgtm: "https://sgtm.yourstore.com/kerdon/id",
  },
  save: "Save",
  saved: "Saved",
  saveFailed: "Could not save. Try again.",
  invalidEndpoint: "Enter an address that starts with https:// and has a domain.",
  verify: "Verify installation",
  verifying: "Verifying…",
  noEndpoint: "Enter the endpoint address first.",
  statusLabel: "Installation status",
  statusVerified: "Verified",
  statusToVerify: "Not verified yet",
  statusNotStarted: "Not set up",
  verifiedOn: (when: string) => `Verified on ${when}`,
  passed: "All good: the loop is closed.",
  failed: "Something is off. Below is what, and what to change.",
  checks: {
    endpoint_url: "The address is on your own domain",
    https: "The address is https",
    reachable: "The endpoint answers",
    no_redirect: "It answers directly, without redirecting",
    consent_granted: "With consent it returns the recognition",
    cookie_attributes: "The recognition is written properly",
    consent_missing: "Without consent it writes nothing",
    consent_withdrawn: "On withdrawal it clears what was there",
  },
  reasons: {
    not_run: "Not tested: something earlier failed.",
    endpoint_malformed: "The address is not written in a valid way.",
    endpoint_not_public: "The address cannot be reached from the internet.",
    endpoint_is_app: "The address points at Kerdon instead of your own domain: recognition would not last from there.",
    endpoint_is_shopify: "The address points at a myshopify.com domain, where you cannot host your own code.",
    endpoint_not_first_party:
      "The address is on a different domain than your store: browsers would delete the recognition written from there.",
    not_https: "The address is not https.",
    unreachable: "No answer. Check that it is published and that the address is exact.",
    redirected: "The address redirects elsewhere. Point it straight at where it answers.",
    no_identifier:
      "With consent it returned no recognition. Check the sending key in the client: paste it whole, and make sure it is the one starting with kin_.",
    endpoint_error: "The endpoint answered with an error.",
    no_cookie: "It does not write the recognition into the browser.",
    cookie_not_secure: "The Secure attribute is missing: without it the recognition travels in the clear.",
    cookie_path: "It only applies to part of the site: it needs Path=/.",
    cookie_samesite: "The SameSite attribute is missing.",
    cookie_session_only: "It only lasts while the tab stays open: a lifetime is missing.",
    identifier_without_consent:
      "It returns a recognition even to visitors who have not answered the banner yet. It must not.",
    cookie_without_consent:
      "It writes into the browser of visitors who have not answered the banner yet. It must not.",
    identifier_after_withdrawal: "It keeps returning the recognition after withdrawal.",
    cookie_not_cleared: "On withdrawal it does not clear what it had written.",
  },
  retention:
    "The recognition asks to stay in the browser for up to a year. That is a technical maximum, not a guarantee: it depends on consent, which can be withdrawn at any time, and on the browser, which may shorten or delete it.",
};

const COPY: Record<Locale, InstallCopy> = { it, en };

export function installCopy(locale: Locale): InstallCopy {
  return COPY[locale] ?? COPY.it;
}

/**
 * Il pezzo da incollare nelle pagine del negozio.
 *
 * Costruito e non scritto a mano nei testi perche' porta dentro l'indirizzo che
 * il merchant ha appena scritto: un esempio da riadattare si sbaglia, uno gia'
 * giusto si copia. L'indirizzo dell'app arriva da fuori — non e' una costante
 * di questo file — cosi' il giorno in cui cambia non c'e' niente da riscrivere
 * qui.
 */
export function bridgeSnippet(appUrl: string, endpoint: string | null): string {
  const base = appUrl.replace(/\/+$/, '');
  const target = endpoint ?? 'https://negozio.it/kerdon/id';
  return `<script src="${base}/tracking/bridge.js"\n        data-kerdon-endpoint="${target}" async></script>`;
}
