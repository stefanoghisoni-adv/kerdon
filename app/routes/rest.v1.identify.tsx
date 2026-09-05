import type { ActionFunctionArgs } from '@remix-run/node';
import { isExternalId } from '~/lib/tracking/external-id';
import {
  identifyVisitor,
  supabaseFromReadContext,
  type IdentifyOutcome,
} from '~/lib/tracking/users.server';
import { revokeTrackingIdentity } from '~/lib/consent/revoke-tracking.server';
import { evaluateVisitorConsent } from '~/lib/tracking/consent';
import { provisionUsersTable } from '~/lib/supabase/ensure-users-table.server';
import { extractReadProxyToken } from '~/lib/read-proxy/token.server';
import { resolveShopReadContext } from '~/lib/read-proxy/context.server';

/**
 * L'identificazione prima dell'acquisto.
 *
 * VIVE SOTTO `/rest/v1/` COME LE ALTRE, e per lo stesso motivo: il merchant
 * scrive qui con il template "Supabase Writer" del suo container, che compone
 * l'indirizzo da se' — `{url}/rest/v1/{tableName}` — e il cui codice non e'
 * modificabile. `identify` e' quindi una pseudo-tabella, come `tracking_id`:
 * dall'esterno si comporta come una tabella su cui si inserisce, dentro non c'e'
 * nessuna tabella con quel nome.
 *
 * Il corpo che quel template manda e' un oggetto JSON PIATTO, costruito da
 * coppie nome/valore, e non sa mandarne altri: e' esattamente cio' che si legge
 * qui sotto. L'header `Prefer` che il template aggiunge in modalita' upsert non
 * viene guardato — cosa si scriva e come lo decide questa rotta, non chi chiama.
 *
 * Riceve l'identificativo del browser insieme a un'email e/o un telefono, e se
 * dietro quel contatto c'e' un cliente del negozio lega i due. E' il modo per
 * non dover aspettare l'ordine: chi si iscrive alla newsletter o compila un
 * form si e' gia' rivelato, e legarlo in quel momento vuol dire che la campagna
 * che lo ha portato viene attribuita anche se comprera' fra tre settimane da un
 * altro dispositivo.
 *
 * EMAIL E TELEFONO VIAGGIANO IN CHIARO, ed e' una scelta, non una dimenticanza.
 * Il database del merchant contiene gia' quei due campi in chiaro — e' cio' che
 * il proxy restituisce ai tag — quindi cifrarli qui non ridurrebbe di un grammo
 * cio' che e' esposto: aggiungerebbe solo una colonna in piu' sul database del
 * merchant per poterci cercare sopra, e una cerimonia che nasconde il dato
 * proprio a chi lo sta gia' leggendo dall'altra parte.
 *
 * Detto questo, due cautele valgono comunque e non sono negoziabili.
 */
export async function action({ request }: ActionFunctionArgs) {
  // PRIMA CAUTELA: POST, mai GET.
  //
  // Non e' formalismo REST. Un'email in querystring finisce in tre posti dove
  // nessuno la cerchera' mai piu': i log d'accesso di ogni intermediario che la
  // richiesta attraversa, l'header Referer che il browser porta al sito
  // successivo, e la cronologia del browser stesso. Nel corpo di una POST non
  // va in nessuno dei tre. Il metodo qui e' una misura di protezione del dato,
  // e per questo viene controllato prima di guardare qualunque altra cosa.
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  // Stesso pedaggio del proxy e della rotta che conia gli identificativi: il
  // token dice di quale negozio si parla. Senza, chiunque potrebbe scrivere
  // legami fra browser e clienti nel database di un merchant.
  const token = extractReadProxyToken(request);
  const result = token ? await resolveShopReadContext(token) : { kind: 'unknown' as const };
  if (result.kind !== 'ok') return json({ error: 'unauthorized' }, 401);

  const { ctx } = result;
  // Stesso cancello del proxy: un negozio con il tracciamento sospeso non
  // scrive e non legge dati dei suoi clienti.
  if (!ctx.canReadData) return json({ error: 'forbidden' }, 403);

  let body: IdentifyBody;
  try {
    body = (await request.json()) as IdentifyBody;
  } catch {
    // Il corpo illeggibile si dichiara per quello che e', SENZA riportarlo:
    // vedi la seconda cautela, qui sotto.
    return json({ error: 'bad_request' }, 400);
  }

  const externalId = typeof body?.external_id === 'string' ? body.external_id.trim() : '';
  if (!isExternalId(externalId)) return json({ error: 'bad_request' }, 400);

  const supabase = supabaseFromReadContext(ctx);

  // TERZA CAUTELA, e viene prima delle altre due nell'ordine dei fatti: il
  // permesso del visitatore.
  //
  // Qui non si conia niente — l'identificativo arriva gia' fatto — ma si scrive,
  // e si scrive la cosa piu' pesante di tutte: il legame fra un browser e una
  // persona con nome e cognome. Un identificativo che il container ha in mano da
  // prima non e' un permesso: lo si prende per buono solo se il permesso arriva
  // adesso, insieme alla richiesta.
  //
  // Se il no e' esplicito si cancella quello che c'era, invece di limitarsi a
  // non aggiungere: chi revoca mentre lascia la sua email sta chiedendo proprio
  // che i due non restino legati.
  const consent = evaluateVisitorConsent(request, body as Record<string, unknown>);
  if (!consent.allowed) {
    // La revoca si scrive prima di dirsi applicata, come sulle altre rotte. Qui
    // il corpo puo' portare anche l'email — che nel registro NON entra: il
    // soggetto e' l'identificativo del browser, e conservare un secondo dato
    // personale "per comodita'" sarebbe un secondo dato da cancellare.
    const esito = consent.withdrawn
      ? await revokeTrackingIdentity({ shopId: ctx.shopId, externalId })
      : null;

    logIdentify(ctx.shopId, 'no_consent');

    if (esito?.retriable) {
      return json({ error: 'revoke_not_recorded' }, 503, { 'Retry-After': '60' });
    }
    return json({ ok: true, outcome: 'no_consent' }, 200);
  }

  const outcome = await identifyVisitor(
    supabase,
    {
      externalId,
      email: body.email ?? null,
      phone: body.phone ?? null,
      // Se il container li manda si scrivono, se non li manda restano vuoti:
      // sono un di piu' per segmentare, mai una condizione per riconoscere.
      browser: body.browser ?? null,
      deviceType: body.device_type ?? null,
    },
    () => provisionUsersTable(ctx.shopId, supabase),
  );

  logIdentify(ctx.shopId, outcome.outcome);

  // Sempre 200 quando la richiesta era ben formata, anche se il cliente non si
  // e' trovato: non trovarlo e' un esito normale — nella tabella dei clienti
  // ci sono solo quelli che hanno acconsentito al marketing — e un container
  // che riceve un errore smette di chiamare.
  return json({ ok: true, outcome: outcome.outcome }, 200);
}

/**
 * La stessa rotta chiamata in GET si rifiuta, e lo fa in modo esplicito invece
 * di lasciarlo decidere al framework.
 *
 * Il motivo e' quello della prima cautela: chi arriva qui in GET ha con ogni
 * probabilita' l'email nella querystring, e da li' e' gia' finita nei log e nel
 * Referer prima ancora che noi rispondiamo. Non possiamo disfare quello che e'
 * gia' successo, ma possiamo non trattarlo come una chiamata valida — e un 405
 * scritto a mano e' anche il posto dove questa spiegazione resta leggibile.
 */
export async function loader() {
  return json({ error: 'method_not_allowed' }, 405);
}

interface IdentifyBody {
  external_id?: unknown;
  email?: string | null;
  phone?: string | null;
  browser?: string | null;
  device_type?: string | null;
}

function json(
  payload: unknown,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

/**
 * SECONDA CAUTELA: nel log va l'esito, mai il contenuto.
 *
 * Un'email finita in una riga di log e' un dato personale uscito dal database
 * del merchant e finito in un posto che nessuno ha dichiarato, che nessuno
 * pota, e dove chi cerca dati personali non pensera' mai di guardare — a
 * cominciare dal merchant stesso il giorno in cui deve rispondere a una
 * richiesta di cancellazione. Qui si scrive che un'identificazione e' avvenuta
 * e com'e' andata: e' tutto cio' che serve per capire se il meccanismo
 * funziona, ed e' tutto cio' che si puo' scrivere.
 */
function logIdentify(shopId: string, outcome: IdentifyOutcome): void {
  console.log(
    `[rest/v1/identify] ${JSON.stringify({
      shop: shopId,
      outcome,
      at: new Date().toISOString(),
    })}`,
  );
}
