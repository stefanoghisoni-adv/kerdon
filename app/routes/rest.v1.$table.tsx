import type { LoaderFunctionArgs } from '@remix-run/node';
import {
  externalIdCookie,
  newExternalId,
  readExternalId,
  EXTERNAL_ID_HEADER,
} from '~/lib/tracking/external-id';
import { extractReadProxyToken } from '~/lib/read-proxy/token.server';
import { resolveShopReadContext } from '~/lib/read-proxy/context.server';
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
  outcome: AccessOutcome;
}

function denied(status: number, message: string, outcome: AccessOutcome, shopId: string | null = null): ReadResult {
  return { response: deny(status, message), shopId, outcome };
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
    return denied(403, 'Accesso ai dati sospeso per questo negozio.', 'denied_suspended', ctx.shopId);
  }

  const allowed = allowedReadTables(ctx.customersEnabled);
  if (!allowed.includes(table)) {
    return denied(403, 'Tabella non disponibile.', 'denied_table', ctx.shopId);
  }

  const search = new URL(request.url).search;
  // L'allowlist sul path dice QUALE tabella si legge, ma PostgREST sa tirarsi
  // dietro tutto cio' che e' collegato da una chiave esterna — dentro `select`
  // e anche fuori, con i filtri sulle risorse embeddate. Qui si pretende che
  // ogni risorsa toccata dalla query sia in elenco, e in dubbio si nega: la
  // chiave con cui inoltriamo non vede le RLS del merchant, quindi una lettura
  // che non sappiamo leggere non e' una lettura da inoltrare.
  if (!inspectReadQuery(search, allowedEmbedTables()).ok) {
    return denied(403, 'Tabella non disponibile.', 'denied_table', ctx.shopId);
  }

  // Enforcement consenso marketing: solo la tabella customers.
  let forwardSearch = search;
  if (table === 'customers') {
    const noConsent = () =>
      denied(403, "L'utente non ha acconsentito al marketing su Shopify", 'denied_consent', ctx.shopId);

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
  // Non dipende dall'esito della lettura: anche una richiesta rifiutata viene
  // da un browser che vale la pena riconoscere alla prossima.
  const existing = readExternalId(request.headers.get('Cookie'));
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

  // Un header di risposta personalizzato non e' leggibile da JavaScript
  // cross-origin se non e' elencato in `Access-Control-Expose-Headers`. Questo
  // proxy puo' essere chiamato sia da container server-side (che non hanno
  // restrizioni CORS) sia da JavaScript nel browser cross-origin (che le ha):
  // esponendo l'header esplicitamente, lo rendiamo leggibile in entrambi i casi.
  result.response.headers.set('Access-Control-Expose-Headers', EXTERNAL_ID_HEADER);

  return result.response;
}
