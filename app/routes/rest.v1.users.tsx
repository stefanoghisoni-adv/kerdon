import type { ActionFunctionArgs } from '@remix-run/node';
import { isExternalId } from '~/lib/tracking/external-id';
import { recordUserSeen, supabaseFromReadContext } from '~/lib/tracking/users.server';
import { revokeTrackingIdentity } from '~/lib/consent/revoke-tracking.server';
import { evaluateVisitorConsent } from '~/lib/tracking/consent';
import { provisionUsersTable } from '~/lib/supabase/ensure-users-table.server';
import { extractReadProxyToken } from '~/lib/read-proxy/token.server';
import { resolveShopReadContext } from '~/lib/read-proxy/context.server';

/**
 * La scrittura della riga del visitatore, nella forma che il container sa
 * mandare.
 *
 * Il merchant scrive qui con il template "Supabase Writer", che fa una POST su
 * `{url}/rest/v1/{tableName}` con un oggetto JSON piatto e gli header
 * `apikey` + `Authorization: Bearer`. Quel codice non e' modificabile: la rotta
 * deve stare esattamente li' e accettare esattamente quella forma, o per chi usa
 * quel template non esiste.
 *
 * QUI DENTRO NON PASSA NIENTE DI QUEL CORPO. E' il punto piu' importante di
 * questo file. Il proxy inoltra al progetto del merchant con la chiave di
 * servizio, che salta le RLS: prendere l'oggetto che arriva e girarlo al
 * database vorrebbe dire lasciare che chiunque abbia il token scriva le colonne
 * che vuole con i privilegi massimi — a cominciare da `shopify_customer_id`,
 * cioe' la possibilita' di dichiarare che un browser qualsiasi appartiene a un
 * cliente qualsiasi.
 *
 * Quindi: si guardano le tre chiavi che conosciamo, il resto si scarta in
 * silenzio (in silenzio e non con un errore: un container che manda una chiave
 * in piu' non sta sbagliando niente di suo, e un errore lo fermerebbe), i
 * timestamp li mette il codice, e la query la compone `recordUserSeen`. Anche
 * l'header `Prefer` non si guarda: se questa scrittura sia un inserimento o un
 * aggiornamento lo decide la nostra logica — e' sempre un upsert
 * sull'identificativo — non chi chiama.
 *
 * Rispetto alla riga che nasce da `/rest/v1/tracking_id`, questa strada porta in
 * piu' le due etichette facoltative: li' il template puo' attaccare una sola
 * coppia in querystring, qui l'oggetto e' intero.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Stesso pedaggio del proxy e della rotta che conia gli identificativi. Il
  // template manda il token sia in `apikey` sia in `Authorization: Bearer`, e
  // `extractReadProxyToken` legge gia' entrambi.
  const token = extractReadProxyToken(request);
  const result = token ? await resolveShopReadContext(token) : { kind: 'unknown' as const };
  if (result.kind !== 'ok') return json({ error: 'unauthorized' }, 401);

  const { ctx } = result;
  if (!ctx.canReadData) return json({ error: 'forbidden' }, 403);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const externalId = typeof body?.external_id === 'string' ? body.external_id.trim() : '';
  // L'unico campo senza il quale non c'e' niente da scrivere, ed e' anche
  // l'unico controllato: dev'essere un identificativo coniato da noi. Uno
  // inventato creerebbe una riga che nessuna visita successiva ritrovera' mai.
  if (!isExternalId(externalId)) return json({ error: 'bad_request' }, 400);

  const supabase = supabaseFromReadContext(ctx);

  // Il permesso del visitatore, prima di scrivere la sua riga.
  //
  // Questa e' la strada per cui la riga nasce piu' ricca — l'oggetto intero
  // invece della coppia in querystring — ma resta la stessa riga, con lo stesso
  // identificativo dentro: se il permesso non c'e', non c'e' nemmeno qui. Un
  // container che manda l'identificativo non sta dichiarando niente per conto
  // del visitatore, e non e' su di lui che ci si basa.
  const consent = evaluateVisitorConsent(request, body);
  if (!consent.allowed) {
    // Nessun cookie esce da questa rotta, ne' qui ne' altrove: e' il Writer del
    // container a chiamarla, e l'identificativo lo porta gia' lui. Quello che
    // cambia rispetto a prima e' che la revoca viene SCRITTA, e che il suo
    // esito si guarda.
    const esito = consent.withdrawn
      ? await revokeTrackingIdentity({ shopId: ctx.shopId, externalId })
      : null;

    console.log(
      `[rest/v1/users] ${JSON.stringify({
        shop: ctx.shopId,
        outcome: esito ? `no_consent:${esito.outcome}` : 'no_consent',
        at: new Date().toISOString(),
      })}`,
    );

    // 503 solo quando la revoca non e' stata presa in carico: e' l'unico caso
    // in cui il ritentativo del container cambia qualcosa, perche' la riga
    // durevole non c'e' e nessuno applichera' mai quella revoca.
    if (esito?.retriable) {
      return json({ error: 'revoke_not_recorded' }, 503, { 'Retry-After': '60' });
    }
    return json({ ok: true }, 200);
  }

  const outcome = await recordUserSeen(
    supabase,
    {
      externalId,
      // Le due sole altre colonne che accettiamo da fuori. Sono etichette per
      // segmentare, non condizioni per riconoscere qualcuno: nel peggiore dei
      // casi un valore sbagliato qui sporca un segmento, non l'identita'.
      browser: asText(body.browser),
      deviceType: asText(body.device_type),
    },
    () => provisionUsersTable(ctx.shopId, supabase),
  );

  // Sempre 2xx quando la richiesta era ben formata: il tag di un container che
  // riceve un errore lo segnala al merchant, e una scrittura non riuscita sul
  // suo database non e' qualcosa che lui possa risolvere. L'esito vero sta nel
  // log.
  console.log(
    `[rest/v1/users] ${JSON.stringify({ shop: ctx.shopId, outcome, at: new Date().toISOString() })}`,
  );

  return json({ ok: true }, 200);
}

/**
 * La stessa rotta in lettura non esiste: `users` non e' fra le tabelle che il
 * proxy serve, e non deve diventarlo di straforo. Restituirla vorrebbe dire far
 * uscire l'elenco dei browser di ogni cliente da un endpoint pubblico.
 */
export async function loader() {
  return json({ error: 'method_not_allowed' }, 405);
}

/** Solo stringhe: un numero o un oggetto in quelle colonne non ci va. */
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
