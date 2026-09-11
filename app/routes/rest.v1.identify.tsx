import type { ActionFunctionArgs } from '@remix-run/node';
import { isExternalId } from '~/lib/tracking/external-id';
import { identifyVisitor, supabaseFromReadContext } from '~/lib/tracking/users.server';
import { revokeTrackingIdentity } from '~/lib/consent/revoke-tracking.server';
import { evaluateVisitorConsent } from '~/lib/tracking/consent';
import { provisionUsersTable } from '~/lib/supabase/ensure-users-table.server';
import { authorizeIngest } from '~/lib/ingest/ingest-guard.server';

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
 * QUESTA E' LA SCRITTURA PIU' PESANTE DELL'APP, ed e' il motivo per cui ha un
 * ambito tutto suo. Legare un browser a una persona con nome e cognome e'
 * l'unica cosa che, ottenuta da chi non doveva, permette di attribuirsi gli
 * acquisti di qualcun altro. Una credenziale emessa per far scrivere le
 * etichette di un browser non arriva qui, e — da quando l'ingest e' separato
 * dalla lettura — non ci arriva nemmeno chi ha soltanto il token con cui il
 * proxy serve i dati.
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

  const permesso = await authorizeIngest(request, {
    scope: 'ingest:links',
    route: '/rest/v1/identify',
  });
  if (!permesso.ok) return permesso.response;

  const { ctx, body, finish } = permesso;

  const externalId = typeof body?.external_id === 'string' ? body.external_id.trim() : '';
  if (!isExternalId(externalId)) {
    finish('bad_external_id', 400);
    return json({ error: 'bad_request' }, 400);
  }

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
  const consent = evaluateVisitorConsent(request, body);
  if (!consent.allowed) {
    // La revoca si scrive prima di dirsi applicata, come sulle altre rotte. Qui
    // il corpo puo' portare anche l'email — che nel registro NON entra: il
    // soggetto e' l'identificativo del browser, e conservare un secondo dato
    // personale "per comodita'" sarebbe un secondo dato da cancellare.
    const esito = consent.withdrawn
      ? await revokeTrackingIdentity({ shopId: ctx.shopId, externalId })
      : null;

    if (esito?.retriable) {
      finish('revoke_not_recorded', 503);
      return json({ error: 'revoke_not_recorded' }, 503, { 'Retry-After': '60' });
    }

    finish('no_consent');
    return json({ ok: true, outcome: 'no_consent' }, 200);
  }

  const outcome = await identifyVisitor(
    supabase,
    {
      externalId,
      email: asText(body.email),
      phone: asText(body.phone),
      // Se il container li manda si scrivono, se non li manda restano vuoti:
      // sono un di piu' per segmentare, mai una condizione per riconoscere.
      browser: asText(body.browser),
      deviceType: asText(body.device_type),
    },
    () => provisionUsersTable(ctx.shopId, supabase),
  );

  // SECONDA CAUTELA, ed e' quella che questa riga rispetta: nel log va l'esito,
  // mai il contenuto. Un'email finita in una riga di log e' un dato personale
  // uscito dal database del merchant e arrivato in un posto che nessuno ha
  // dichiarato, che nessuno pota, e dove chi cerca dati personali non pensera'
  // mai di guardare — a cominciare dal merchant stesso il giorno in cui deve
  // rispondere a una richiesta di cancellazione. Cosa entra in quella riga non
  // lo sceglie questa rotta: lo decide `ingest-guard`, in un posto solo per
  // tutte e tre.
  finish(outcome.outcome);

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

/** Solo stringhe: il corpo arriva da fuori e un oggetto qui non ci va. */
function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
