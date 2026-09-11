import type { LoaderFunctionArgs } from '@remix-run/node';
import {
  expiredExternalIdCookie,
  externalIdCookie,
  newExternalId,
  incomingExternalId,
  EXTERNAL_ID_HEADER,
  LEGACY_EXTERNAL_ID_HEADER,
} from '~/lib/tracking/external-id';
import { extractReadProxyToken } from '~/lib/read-proxy/token.server';
import {
  resolveShopReadContext,
  type ShopReadContext,
} from '~/lib/read-proxy/context.server';
import {
  evaluateVisitorConsent,
  LEGACY_SALE_OF_DATA_HEADER,
  SALE_OF_DATA_HEADER,
} from '~/lib/tracking/consent';
import { revokeTrackingIdentity } from '~/lib/consent/revoke-tracking.server';
import {
  allowedReadTables,
  allowedEmbedTables,
  forwardRead,
  inspectReadQuery,
} from '~/lib/read-proxy/forward.server';
import {
  isCustomerIdentifierLookup,
  consentCheckSearch,
  forceConsentedOnlySearch,
  rowsHaveNonConsented,
} from '~/lib/read-proxy/customer-consent.server';
import {
  logCustomerDataAccess,
  type AccessOutcome,
} from '~/lib/read-proxy/access-log.server';

// Risposta di blocco: JSON minimale. I container server-side trattano ogni
// status non 2xx come "nessun dato", quindi il tracciamento prosegue senza
// errori all'utente finale.
function deny(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Esito di una lettura, insieme a cio' che serve per registrarla: il negozio
// (quando lo si e' potuto stabilire) e l'etichetta dell'esito.
interface ReadResult {
  response: Response;
  shopId: string | null;
  // Serve solo alla revoca: e' da qui che si arriva al database del merchant
  // per cancellare cio' che era stato raccolto. C'e' quando il negozio si e'
  // potuto stabilire, cioe' esattamente nei casi in cui ci sarebbe qualcosa da
  // cancellare.
  ctx: ShopReadContext | null;
  outcome: AccessOutcome;
}

function denied(
  status: number,
  message: string,
  outcome: AccessOutcome,
  ctx: ShopReadContext | null = null,
): ReadResult {
  return { response: deny(status, message), shopId: ctx?.shopId ?? null, ctx, outcome };
}

async function handleRead(request: Request, table: string): Promise<ReadResult> {
  const token = extractReadProxyToken(request);
  if (!token) return denied(401, 'Token di lettura mancante.', 'denied_no_token');

  const result = await resolveShopReadContext(token);
  if (result.kind === 'unknown') {
    return denied(401, 'Token di lettura non valido.', 'denied_invalid_token');
  }
  if (result.kind === 'not_configured') {
    return denied(409, 'Supabase non collegato.', 'denied_not_configured');
  }

  const { ctx } = result;
  // Gate fail-closed: solo un ENABLED esatto passa (vedi grantsDataAccess).
  if (!ctx.canReadData) {
    return denied(403, 'Accesso ai dati sospeso per questo negozio.', 'denied_suspended', ctx);
  }

  const allowed = allowedReadTables(ctx.customersEnabled);
  if (!allowed.includes(table)) {
    return denied(403, 'Tabella non disponibile.', 'denied_table', ctx);
  }

  const search = new URL(request.url).search;
  // L'allowlist sul path dice QUALE tabella si legge, ma PostgREST sa tirarsi
  // dietro tutto cio' che e' collegato da una chiave esterna — dentro `select`
  // e anche fuori, con i filtri sulle risorse embeddate. Qui si pretende che
  // ogni risorsa toccata dalla query sia in elenco, e in dubbio si nega: la
  // chiave con cui inoltriamo non vede le RLS del merchant, quindi una lettura
  // che non sappiamo leggere non e' una lettura da inoltrare.
  if (!inspectReadQuery(search, allowedEmbedTables()).ok) {
    return denied(403, 'Tabella non disponibile.', 'denied_table', ctx);
  }

  // Enforcement consenso marketing: solo la tabella customers.
  let forwardSearch = search;
  if (table === 'customers') {
    const noConsent = () =>
      denied(403, "L'utente non ha acconsentito al marketing su Shopify", 'denied_consent', ctx);

    if (isCustomerIdentifierLookup(search)) {
      // Lookup mirato: verifica il consenso del cliente puntato con la
      // service_role. Il corpo del controllo NON viene restituito al chiamante.
      const check = await forwardRead(ctx, 'customers', consentCheckSearch(search));
      if (check.status !== 200) return noConsent();

      let rows: Array<{ accepts_marketing?: unknown }>;
      try {
        rows = JSON.parse(check.body);
        if (!Array.isArray(rows)) throw new Error('non-array');
      } catch {
        // Fail-closed: risposta di controllo non interpretabile → nega.
        return noConsent();
      }
      if (rowsHaveNonConsented(rows)) return noConsent();
      // Consenzienti (o nessuna corrispondenza) → inoltra la query originale.
    } else {
      // Lettura non mirata: restituisci solo i consenzienti.
      forwardSearch = forceConsentedOnlySearch(search);
    }
  }

  const { status, body, contentType } = await forwardRead(ctx, table, forwardSearch);
  return {
    response: new Response(body, { status, headers: { 'Content-Type': contentType } }),
    shopId: ctx.shopId,
    ctx,
    outcome: status === 200 ? 'allowed' : 'upstream_error',
  };
}

// Proxy di lettura Supabase-compatibile. Definendo SOLO il loader, ogni metodo
// diverso da GET/HEAD riceve 405 da Remix.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const table = params.table ?? '';
  const result = await handleRead(request, table);

  // Si registra solo customers, perche' il requisito e' tracciare l'accesso ai
  // dati personali: un prodotto non lo e'. Registrare anche quelli
  // raddoppierebbe le scritture su un endpoint che le vetrine chiamano a ogni
  // pagina, in cambio di informazione che nessuno andra' mai a leggere.
  //
  // Awaited e non lasciato in volo: su una funzione serverless una promise non
  // attesa puo' morire con l'istanza, e un registro che perde righe a caso non
  // documenta niente.
  if (table === 'customers') {
    await logCustomerDataAccess({
      shopId: result.shopId,
      outcome: result.outcome,
      status: result.response.status,
    });
  }

  // L'identificativo del browser, emesso qui perche' questo e' l'unico punto
  // dell'app che la vetrina chiama a ogni pagina. Si crea solo se non c'e'
  // gia': un identificativo che cambia a ogni visita non lega niente a niente,
  // ed e' esattamente il contrario di cio' che serve.
  //
  // DIPENDE DAL PERMESSO DEL VISITATORE, e prima non dipendeva da niente.
  //
  // Qui c'era scritto che anche una richiesta rifiutata viene da un browser che
  // vale la pena riconoscere alla prossima, e per questo l'identificativo si
  // emetteva comunque: senza token, senza negozio, senza sapere chi stesse
  // chiamando. Quella frase descriveva il difetto, non una scelta — coniare un
  // identificativo che dura un anno e' un trattamento, e un trattamento
  // rifiutato non si fa lo stesso perche' tornera' comodo dopo. Adesso la
  // domanda viene prima: se le finalita' necessarie non sono permesse, non
  // esce niente — ne' corpo, ne' header, ne' cookie.
  const consent = evaluateVisitorConsent(request);
  const existing = incomingExternalId(request);

  // La condivisione con terzi si dichiara sempre, permesso o no: e' un'altra
  // domanda, e la risposta serve a valle anche quando qui non si conia niente.
  // Tutti e due i nomi: il container del merchant non si aggiorna nell'istante
  // in cui ci aggiorniamo noi, e uno ancora sul nome di prima smetterebbe di
  // trovare la risposta senza che nessuno se ne accorga.
  result.response.headers.set(SALE_OF_DATA_HEADER, consent.consent.saleOfData);
  result.response.headers.set(LEGACY_SALE_OF_DATA_HEADER, consent.consent.saleOfData);

  // Qui c'era un `Access-Control-Expose-Headers`, e prometteva una cosa che non
  // e' mai stata vera: diceva a JavaScript cross-origin quali header poteva
  // leggere, ma senza un `Access-Control-Allow-Origin` — che questo progetto
  // non ha e non deve avere — quella chiamata non arriva nemmeno a leggerli.
  // Un permesso dichiarato dentro una porta chiusa non e' un permesso, e' una
  // riga che fa credere a chi legge il codice che la vetrina possa chiamarci.
  // Il trasporto e' uno solo, ed e' scritto in `lib/tracking/external-id`.

  if (!consent.allowed) {
    // Revoca esplicita: si toglie anche cio' che c'era. Il cookie torna
    // indietro scaduto e la riga sparisce dal database — la politica sta in
    // `forgetVisitor`. Un segnale che semplicemente manca non fa scattare
    // niente di tutto questo: non e' un no, e non basta a cancellare.
    if (consent.withdrawn && existing) {
      result.response.headers.append('Set-Cookie', expiredExternalIdCookie());
      if (result.ctx) {
        const esito = await revokeTrackingIdentity({
          shopId: result.ctx.shopId,
          externalId: existing,
        });
        // La revoca non presa in carico e' l'unico caso in cui questa risposta
        // cambia. La lettura era andata bene, ma rispondere 200 vorrebbe dire
        // dire ok a una revoca che non e' scritta da nessuna parte — mentre il
        // cookie, gia' scaduto qui sopra, si e' portato via l'unico riferimento
        // da cui riprovare. 503 e il tag richiama; la lettura e' un GET, quindi
        // rifarla non costa altro che una chiamata.
        if (esito.retriable) return revokeUnavailable(result.response);
      }
    }
    return result.response;
  }

  const externalId = existing ?? newExternalId();

  // Il cookie si riscrive solo se mancava: se il browser ce l'ha gia', rimandarglielo
  // identico a ogni pagina e' peso sulla risposta che non cambia niente.
  if (!existing) {
    result.response.headers.append('Set-Cookie', externalIdCookie(externalId));
  }

  // L'header c'e' sempre, sia che l'identificativo fosse gia' presente sia che
  // sia stato creato ora. Un container server-side — quale che sia il fornitore,
  // non presupponiamo nessuno in particolare — puo' cosi' leggerlo e piantarlo
  // come cookie first-party sul
  // dominio del negozio, dove nessun browser lo blocca — mentre un cookie
  // `SameSite=None; Secure` dal nostro dominio e' di terze parti e Safari e
  // Firefox lo scartano.
  result.response.headers.set(EXTERNAL_ID_HEADER, externalId);
  result.response.headers.set(LEGACY_EXTERNAL_ID_HEADER, externalId);

  return result.response;
}

/**
 * La risposta quando la revoca non e' stata presa in carico.
 *
 * QUI C'ERA SCRITTO IL CONTRARIO, e vale la pena lasciarlo detto: "non puo' far
 * fallire la risposta, la lettura era gia' andata come doveva andare". Il
 * ragionamento pesava il fastidio del merchant contro un errore nostro, e
 * dimenticava il terzo interessato — la persona che aveva appena revocato. Con
 * il cookie gia' scaduto e nessuna riga scritta, un 200 chiudeva la faccenda
 * per sempre: nessuno avrebbe piu' saputo che c'era una revoca da applicare.
 *
 * Il 503 invece la fa richiamare. La lettura e' un GET, rifarla non costa altro
 * che una chiamata, e nel frattempo nessun dato di quella persona e' uscito —
 * il permesso non c'era, quindi il tracciamento a valle non riceve niente
 * comunque.
 *
 * Si tengono gli header della risposta originale, cookie scaduto compreso: il
 * ritentativo non deve rimettere in circolo l'identificativo.
 */
function revokeUnavailable(original: Response): Response {
  const headers = new Headers(original.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Retry-After', '60');
  return new Response(JSON.stringify({ error: 'revoke_not_recorded' }), {
    status: 503,
    headers,
  });
}
