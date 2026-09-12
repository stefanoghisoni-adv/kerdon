import { json, redirect } from '@remix-run/node';
import type { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import type { Dictionary } from '~/lib/i18n/context';
import { dictionaryForShop } from '~/lib/i18n/server';
import { authenticate } from '~/shopify.server';
import {
  denialOf,
  type Capability,
  type DenialReason,
  type ShopCapabilities,
} from './capabilities';
import { shopCapabilities } from './shop-capabilities.server';

/**
 * Il punto unico in cui una rotta chiede il permesso di servire dati.
 *
 * PERCHE' ESISTE. La policy c'era gia' ed era completa; quello che mancava era
 * che meta' delle rotte la interrogasse. Autenticavano l'amministratore — cioe'
 * stabilivano CHI stava chiedendo — e da li' passavano dritte alla lettura,
 * senza mai chiedere se quel negozio, oggi, possa ancora leggere. La dashboard
 * calcolava `blocked` e nascondeva i comandi, ma nascondere un comando non e'
 * negarlo: le rotte sotto rispondevano identiche a chi le chiamava a mano. Un
 * negozio con la prova finita, sospeso, o con la cancellazione GDPR gia'
 * cominciata continuava a leggersi i propri clienti — nomi, email e valore
 * economico — semplicemente digitando l'indirizzo.
 *
 * PERCHE' UN HELPER E NON UNA RIGA COPIATA. Perche' la riga copiata in venti
 * rotte e' la ventunesima che se la dimentica, ed e' esattamente cosi' che il
 * difetto e' nato. Qui la sequenza — autentica, risolvi il negozio, valuta la
 * policy, rifiuta — sta in un posto solo, e chi chiama non la ricompone: nomina
 * una capacita' e riceve il negozio gia' autorizzato, oppure non riceve niente
 * perche' la risposta di rifiuto e' gia' partita.
 *
 * PERCHE' SOLLEVA INVECE DI RESTITUIRE. Un rifiuto restituito e' un valore che
 * chi chiama puo' dimenticarsi di guardare, e il codice continuerebbe fino alla
 * lettura. Sollevandolo non c'e' niente da ricordarsi: la funzione non torna
 * mai al chiamante quando il permesso non c'e'.
 */

/**
 * Il negozio, con dentro tutto quello che la policy legge.
 *
 * Riga intera e non una `select` ristretta perche' chi chiama il permesso e'
 * quasi sempre chi poi vuole il negozio: restituirglielo qui gli risparmia la
 * seconda interrogazione che farebbe subito dopo. `supabaseConfig` viaggia
 * insieme perche' senza `connectionVerifiedAt` la policy non saprebbe dire se
 * c'e' un database collegato.
 */
export type GuardedShop = Prisma.ShopGetPayload<{ include: { supabaseConfig: true } }>;

export type AdminSession = Awaited<ReturnType<typeof authenticate.admin>>['session'];

export interface CapabilityGrant {
  readonly session: AdminSession;
  readonly shop: GuardedShop;
  /**
   * Tutte le capacita' del negozio, non solo quella chiesta.
   *
   * Chi ne deve valutare una seconda — la pagina che chiede `use_app` per
   * entrare e poi guarda `sync_customers` per decidere cosa mostrare — la legge
   * da qui invece di rivalutare la policy, che vorrebbe dire rileggere il
   * negozio e il listino una seconda volta nella stessa richiesta.
   */
  readonly capabilities: ShopCapabilities;
}

/**
 * Come si presenta il rifiuto al merchant.
 *
 *  - `json`: 403 con dentro la frase da mostrare. E' la forma delle rotte che
 *    rispondono a un fetcher — il riquadro scrive quella frase e il resto della
 *    pagina resta in piedi.
 *  - `redirect`: si torna alla dashboard. E' la forma delle PAGINE, ed e' la
 *    stessa scelta gia' fatta da `requireSetupComplete`: una pagina intera
 *    sostituita da un 403 diventa la schermata d'errore di Remix, con un codice
 *    di stato in cima e nessun gesto possibile sotto. La dashboard invece il
 *    banner ce l'ha gia' — dice che cosa e' successo e dove si rimedia — ed e'
 *    l'unica schermata che a un negozio fermo serva ancora.
 */
export type DenialStyle = 'json' | 'redirect';

export interface RequireCapabilityOptions {
  readonly onDenied?: DenialStyle;
  /** Dove mandare il merchant con `redirect`. La dashboard, salvo motivi. */
  readonly redirectTo?: string;
}

/**
 * La frase che il merchant legge, per ogni motivo di rifiuto.
 *
 * Sono frasi che dicono che cosa puo' fare — aggiornare il piano, collegare il
 * database, riaprire l'app — non che cosa ha deciso l'app: il nome del motivo
 * viaggia a parte, nel campo `code`, per chi scrive il codice.
 *
 * Mappa TOTALE e non parziale con un ripiego: un motivo nuovo aggiunto alla
 * policy deve far fermare il compilatore qui, invece di uscire al merchant
 * come "sei sospeso" — che per meta' dei motivi e' semplicemente falso.
 */
export function denialMessage(denial: DenialReason, t: Dictionary): string {
  const frasi: Record<DenialReason, string> = {
    unknown_shop: t.errors.suspended,
    erasing: t.errors.erasureInProgress,
    uninstalled: t.errors.appDisabled,
    not_authorized: t.errors.suspended,
    tracking_suspended: t.errors.suspended,
    not_connected: t.errors.connectFirst,
    plan_required: t.errors.planRequiredSection,
    trial_expired: t.errors.trialEnded,
    scope_required: t.errors.permissionMissing,
  };
  return frasi[denial];
}

/**
 * La risposta di rifiuto, gia' pronta da sollevare.
 *
 * Esportata perche' le rotte che il rifiuto devono RESTITUIRLO — un'action il
 * cui esito il fetcher legge in `fetcher.data`, dove una Response sollevata
 * finirebbe invece nell'ErrorBoundary e porterebbe via la pagina — usino la
 * stessa frase e lo stesso corpo di quelle che lo sollevano.
 */
export async function capabilityDenialResponse(
  shopDomain: string,
  denial: DenialReason,
  options: RequireCapabilityOptions = {},
): Promise<Response> {
  if (options.onDenied === 'redirect') return redirect(options.redirectTo ?? '/');
  return denialJson(denialMessage(denial, await dictionaryForShop(shopDomain)), denial);
}

/**
 * Il corpo del rifiuto: la frase per il merchant e il motivo per chi scrive il
 * codice. Due campi, e non uno: la frase dice che cosa si puo' fare, il motivo
 * serve a chi deve distinguere i casi — ed e' il nome della policy, non un
 * codice inventato qui, cosi' non ci sono due vocabolari da tenere allineati.
 */
function denialJson(message: string, denial: DenialReason): Response {
  return json({ error: message, code: denial }, { status: 403 });
}

/**
 * L'esito del cancello, per chi il rifiuto lo deve restituire e non sollevare.
 *
 * Sono le action che rispondono a un fetcher: la pagina resta dov'e' e l'esito
 * lo legge `fetcher.data`, dove una Response sollevata non arriverebbe mai —
 * finirebbe nell'ErrorBoundary, portandosi via la schermata che il merchant
 * stava guardando. Il rifiuto e' lo stesso, cambia solo come viaggia.
 */
export type CapabilityOutcome =
  | { readonly ok: true; readonly grant: CapabilityGrant }
  | {
      readonly ok: false;
      readonly denial: DenialReason;
      /**
       * La frase gia' nella lingua del merchant.
       *
       * Viaggia accanto alla risposta perche' le action non rispondono tutte
       * con lo stesso corpo: chi ha gia' un `{ ok, error }` che la pagina sa
       * leggere ci mette dentro questa, invece di cambiare forma alla risposta
       * — e senza doversi ricalcolare il dizionario per conto suo.
       */
      readonly message: string;
      readonly response: Response;
    };

/**
 * Autentica, risolve il negozio, valuta la policy. Una volta sola, qui.
 *
 * Va chiamata PRIMA di qualunque lettura del database del merchant e di
 * qualunque chiamata a Shopify. Non e' una preferenza di stile: un controllo
 * fatto dopo la lettura ha gia' tirato fuori i dati dal database del merchant e
 * li ha fatti passare per questo processo — a quel punto il rifiuto nasconde
 * una cosa che e' gia' successa. L'unica lettura che viene prima e' quella del
 * negozio qui sotto, che e' il fatto su cui la decisione si prende.
 */
export async function shopCapabilityOutcome(
  request: Request,
  capability: Capability,
  options: RequireCapabilityOptions = {},
): Promise<CapabilityOutcome> {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { supabaseConfig: true },
  });

  const capabilities = await shopCapabilities(shop);
  const denial = denialOf(capabilities, capability);

  // Il negozio mancante non e' un 404: la policy lo tratta gia' come "non so di
  // chi si tratta" e nega tutto. Rispondere "negozio non trovato" a chi chiama
  // una rotta a mano gli direbbe, per differenza, quali domini esistono.
  if (denial !== null || shop === null) {
    const motivo = denial ?? 'unknown_shop';
    // Il dizionario si legge una volta sola e serve a tutt'e due: la frase che
    // esce nel corpo e quella che chi chiama puo' voler mettere in una risposta
    // di forma sua.
    const message = denialMessage(motivo, await dictionaryForShop(session.shop));
    return {
      ok: false,
      denial: motivo,
      message,
      response:
        options.onDenied === 'redirect'
          ? redirect(options.redirectTo ?? '/')
          : denialJson(message, motivo),
    };
  }

  return { ok: true, grant: { session, shop, capabilities } };
}

/**
 * Lo stesso cancello, e se non passa NON TORNA.
 *
 * E' la forma normale, quella dei loader: un rifiuto restituito e' un valore
 * che chi chiama puo' dimenticarsi di guardare, e il codice proseguirebbe fino
 * alla lettura — che e' precisamente il modo in cui questo difetto e' nato.
 * Sollevandolo non c'e' niente da ricordarsi.
 */
export async function requireShopCapability(
  request: Request,
  capability: Capability,
  options: RequireCapabilityOptions = {},
): Promise<CapabilityGrant> {
  const esito = await shopCapabilityOutcome(request, capability, options);
  if (!esito.ok) throw esito.response;
  return esito.grant;
}
