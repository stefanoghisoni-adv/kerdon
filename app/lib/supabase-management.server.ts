const MGMT_BASE = 'https://api.supabase.com';

// Errore che conserva stato HTTP e corpo della risposta Supabase, così il
// chiamante può distinguere i casi (limite di piano, scope mancante, …) invece
// di ricevere solo "non riuscito".
export class SupabaseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'SupabaseApiError';
  }
}

// Riconosce il rifiuto per limite di progetti del piano. È un'euristica sul
// testo — Supabase non espone un codice dedicato — quindi in caso di dubbio
// NON classifichiamo: meglio un messaggio generico che affermare un limite
// di piano che potrebbe non essere la vera causa.
export function isPlanLimitError(status: number, body: string): boolean {
  if (status !== 402 && status !== 403) return false;
  const text = body.toLowerCase();
  return (
    text.includes('free plan') ||
    text.includes('project limit') ||
    text.includes('quota') ||
    text.includes('maximum number of projects') ||
    (text.includes('limit') && text.includes('project'))
  );
}

export interface SupabaseTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface SupabaseProject {
  id: string;
  name: string;
  organization_id: string;
  // Slug dell'organizzazione: e' quello che compare negli URL della dashboard
  // (…/dashboard/org/<slug>/billing). Nella Management API organization_id e'
  // deprecato in favore di organization_slug, ma lo teniamo per compatibilita'.
  organization_slug: string;
  region: string;
  status: string;
}

export interface SupabaseProjectKeys {
  anon: string;
  serviceRole: string;
}

export interface SupabaseOrganization {
  id: string;
  name: string;
}

export interface SupabaseCreateProjectResult {
  ref: string;
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`${MGMT_BASE}/v1/oauth/authorize`);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', params.state);
  return url.toString();
}

async function tokenRequest(
  body: URLSearchParams,
  clientId: string,
  clientSecret: string,
): Promise<SupabaseTokenResponse> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${MGMT_BASE}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Supabase token error: ${res.status}`);
  return (await res.json()) as SupabaseTokenResponse;
}

export function exchangeCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<SupabaseTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  });
  return tokenRequest(body, params.clientId, params.clientSecret);
}

export function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<SupabaseTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  });
  return tokenRequest(body, params.clientId, params.clientSecret);
}

export async function listProjects(accessToken: string): Promise<SupabaseProject[]> {
  const res = await fetch(`${MGMT_BASE}/v1/projects`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Supabase list projects error: ${res.status}`);
  const data = (await res.json()) as Array<Record<string, unknown>>;
  return data.map((p) => ({
    id: String(p.id),
    name: String(p.name),
    organization_id: String(p.organization_id),
    organization_slug: String(p.organization_slug ?? p.organization_id),
    region: String(p.region),
    status: String(p.status ?? 'UNKNOWN'),
  }));
}

/**
 * Elimina un progetto dall'account del merchant.
 *
 * Irreversibile, e non e' roba nostra: e' un progetto suo, con i suoi dati.
 * Qui non c'e' nessuna difesa — chi chiama deve aver gia' verificato che il
 * progetto sia davvero suo e che non sia quello collegato all'app.
 */
export async function deleteProject(accessToken: string, ref: string): Promise<void> {
  const res = await fetch(`${MGMT_BASE}/v1/projects/${ref}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Supabase delete project error: ${res.status}`);
}

// /v1/profile e' l'unico posto che dichiara l'email dell'account, ma nella
// specifica non porta alcuno scope OAuth: e' pensato per i token personali, e
// con un token di integrazione puo' rispondere 401/403. Per questo esiste la
// via secondaria qui sotto.
async function profileEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${MGMT_BASE}/v1/profile`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.warn(
        '[supabase] /v1/profile non disponibile:',
        res.status,
        (await res.text()).slice(0, 200),
      );
      return null;
    }
    const data = (await res.json()) as { primary_email?: unknown; email?: unknown };
    const email = data.primary_email ?? data.email;
    return typeof email === 'string' && email ? email : null;
  } catch (e) {
    console.warn('[supabase] /v1/profile', e instanceof Error ? e.message : e);
    return null;
  }
}

// Via secondaria: l'autorizzazione OAuth di Supabase e' data a una singola
// organizzazione. Se quella organizzazione ha un solo membro, quel membro e'
// per forza chi ha fatto l'accesso — ed e' l'unico caso in cui possiamo dirlo
// senza rischiare di mostrare l'indirizzo di un collega.
async function soleMemberEmail(accessToken: string): Promise<string | null> {
  try {
    const orgsRes = await fetch(`${MGMT_BASE}/v1/organizations`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!orgsRes.ok) {
      console.warn('[supabase] /v1/organizations non disponibile:', orgsRes.status);
      return null;
    }
    const orgs = (await orgsRes.json()) as Array<{ slug?: unknown }>;
    if (!Array.isArray(orgs) || orgs.length !== 1) return null;
    const slug = orgs[0]?.slug;
    if (typeof slug !== 'string' || !slug) return null;

    const membersRes = await fetch(`${MGMT_BASE}/v1/organizations/${slug}/members`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!membersRes.ok) {
      console.warn('[supabase] /v1/organizations/*/members non disponibile:', membersRes.status);
      return null;
    }
    const members = (await membersRes.json()) as Array<{ email?: unknown }>;
    if (!Array.isArray(members)) return null;
    const emails = members
      .map((m) => m.email)
      .filter((e): e is string => typeof e === 'string' && e.length > 0);
    return emails.length === 1 ? emails[0] : null;
  } catch (e) {
    console.warn('[supabase] membri organizzazione', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Email dell'account Supabase a cui si e' fatto accesso.
 *
 * Serve solo a dire al merchant con quale account e' entrato, quindi un
 * fallimento non e' un errore da propagare: si restituisce null e la frase si
 * accorcia. Non tutti i token hanno il permesso di leggere il profilo.
 */
export async function getAccountEmail(accessToken: string): Promise<string | null> {
  return (await profileEmail(accessToken)) ?? (await soleMemberEmail(accessToken));
}

export async function getProjectApiKeys(
  accessToken: string,
  ref: string,
): Promise<SupabaseProjectKeys> {
  const res = await fetch(`${MGMT_BASE}/v1/projects/${ref}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Supabase api-keys error: ${res.status}`);
  const keys = (await res.json()) as Array<{ name: string; api_key: string }>;
  const anon = keys.find((k) => k.name === 'anon')?.api_key;
  const serviceRole = keys.find((k) => k.name === 'service_role')?.api_key;
  if (!anon || !serviceRole) {
    throw new Error('Supabase api-keys: anon o service_role mancante');
  }
  return { anon, serviceRole };
}

/**
 * Il motivo vero di una query rifiutata, non il solo numero.
 *
 * `Supabase query error: 400` non dice niente: 400 e' la risposta a una tabella
 * che non esiste, a una colonna sbagliata, a una sintassi storta e a una decina
 * d'altre cose. Il corpo invece contiene il messaggio di Postgres — "relation
 * \"orders\" does not exist" — che e' esattamente cio' che serve leggere nei log
 * per capire cosa fare. Buttarlo via e' costato una diagnosi a tentoni.
 */
async function queryError(res: Response): Promise<Error> {
  const detail = await res.text().catch(() => '');
  return new Error(
    `Supabase query error: ${res.status}${detail ? ` \u2014 ${detail.slice(0, 300)}` : ''}`,
  );
}

export async function runQuery(
  accessToken: string,
  ref: string,
  query: string,
): Promise<void> {
  const res = await fetch(`${MGMT_BASE}/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw await queryError(res);
}

// Come runQuery, ma restituisce le righe. runQuery è pensata per la DDL e
// scarta il corpo della risposta: per le SELECT serve leggerlo.
export async function runQueryRows<T = Record<string, unknown>>(
  accessToken: string,
  ref: string,
  query: string,
): Promise<T[]> {
  const res = await fetch(`${MGMT_BASE}/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw await queryError(res);
  const data = await res.json();
  return Array.isArray(data) ? (data as T[]) : [];
}

export async function listOrganizations(
  accessToken: string,
): Promise<SupabaseOrganization[]> {
  const res = await fetch(`${MGMT_BASE}/v1/organizations`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Supabase organizations error: ${res.status}`);
  const data = (await res.json()) as Array<Record<string, unknown>>;
  return data.map((o) => ({ id: String(o.id), name: String(o.name) }));
}

export function projectUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}

/**
 * La pagina del progetto sulla dashboard di Supabase.
 *
 * Diversa da `projectUrl`, che e' l'indirizzo a cui il progetto risponde alle
 * chiamate: aprendo quello in un browser si arriva a una risposta dell'API, non
 * a una pagina da guardare. Chi clicca "Vai al database" vuole vedere le sue
 * tabelle, quindi va portato qui.
 */
export function projectDashboardUrl(ref: string): string {
  return `https://supabase.com/dashboard/project/${ref}`;
}

export type SupabasePlan = 'free' | 'pro' | 'team' | 'enterprise' | 'platform';

export const SUPABASE_PLAN_LABELS: Record<SupabasePlan, string> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
  platform: 'Platform',
};

// Numero massimo di progetti ATTIVI consentiti dal piano. null = nessun limite
// che abbia senso far rispettare lato app (sui piani a pagamento i progetti in
// piu' vengono fatturati, non rifiutati).
export const SUPABASE_PLAN_PROJECT_LIMITS: Record<SupabasePlan, number | null> = {
  free: 2,
  pro: null,
  team: null,
  enterprise: null,
  platform: null,
};

// Stati che NON occupano uno slot del piano. Supabase e' esplicito sul fatto che
// i progetti in pausa non contano verso il limite del piano Free; i rimossi e
// quelli in via di spegnimento men che meno. Tutti gli altri stati (attivi, in
// avvio, in ripristino…) li consideriamo occupanti: meglio sovrastimare, cosi'
// non promettiamo una creazione che Supabase poi rifiuta.
const NON_COUNTING_STATUSES = new Set([
  'INACTIVE',
  'REMOVED',
  'GOING_DOWN',
  'PAUSING',
]);

export function countsTowardsPlanLimit(status: string): boolean {
  return !NON_COUNTING_STATUSES.has(status.toUpperCase());
}

export function organizationBillingUrl(slug: string): string {
  return `https://supabase.com/dashboard/org/${slug}/billing`;
}

// Il piano vive su /v1/organizations/{slug}, che richiede lo scope OAuth
// "Organizations". Quello scope puo' non essere concesso: in quel caso non
// possiamo conoscere il piano e ritorniamo null, cosi' il chiamante degrada
// senza bloccare la creazione con un limite che non e' in grado di verificare.
export interface OrganizationPlanResult {
  plan: SupabasePlan | null;
  // Perche' il piano non e' noto: serve a distinguere "scope non concesso"
  // (403) da "organizzazione inesistente" (404) o da un piano non mappato.
  httpStatus: number | null;
  rawPlan: string | null;
}

export async function fetchOrganizationPlan(
  accessToken: string,
  slug: string,
): Promise<OrganizationPlanResult> {
  try {
    const res = await fetch(`${MGMT_BASE}/v1/organizations/${slug}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { plan: null, httpStatus: res.status, rawPlan: null };
    const data = (await res.json()) as { plan?: unknown };
    const rawPlan = typeof data.plan === 'string' ? data.plan : null;
    const plan =
      rawPlan && rawPlan in SUPABASE_PLAN_PROJECT_LIMITS ? (rawPlan as SupabasePlan) : null;
    return { plan, httpStatus: res.status, rawPlan };
  } catch (e) {
    return {
      plan: null,
      httpStatus: null,
      rawPlan: null,
    };
  }
}

export async function getOrganizationPlan(
  accessToken: string,
  slug: string,
): Promise<SupabasePlan | null> {
  const { plan } = await fetchOrganizationPlan(accessToken, slug);
  return plan;
}

export interface SupabaseRegion {
  id: string;
  name: string;
}

// Lista ufficiale corrente (fallback). Ordine con UE in cima come default sensato.
export const SUPABASE_REGIONS: SupabaseRegion[] = [
  { id: 'eu-central-1', name: 'Central EU (Frankfurt)' },
  { id: 'eu-west-1', name: 'West EU (Ireland)' },
  { id: 'eu-west-2', name: 'West EU (London)' },
  { id: 'eu-west-3', name: 'West EU (Paris)' },
  { id: 'us-east-1', name: 'East US (North Virginia)' },
  { id: 'us-west-1', name: 'West US (North California)' },
  { id: 'us-east-2', name: 'East US (Ohio)' },
  { id: 'ap-southeast-1', name: 'Southeast Asia (Singapore)' },
  { id: 'ap-northeast-1', name: 'Northeast Asia (Tokyo)' },
  { id: 'ap-south-1', name: 'South Asia (Mumbai)' },
  { id: 'sa-east-1', name: 'South America (São Paulo)' },
  { id: 'ca-central-1', name: 'Canada (Central)' },
];

// Tenta un endpoint dinamico; se non disponibile, usa la lista di fallback.
// NOTA IMPLEMENTAZIONE: verificare se la Management API espone un endpoint
// "available regions". Se sì, sostituire il path e il parsing qui; il fallback
// garantisce comunque il funzionamento.
export async function listRegions(accessToken: string): Promise<SupabaseRegion[]> {
  try {
    const res = await fetch(`${MGMT_BASE}/v1/projects/available-regions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return SUPABASE_REGIONS;
    const data = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data) || data.length === 0) return SUPABASE_REGIONS;
    return data.map((r) => ({ id: String(r.id ?? r.region), name: String(r.name ?? r.id) }));
  } catch {
    return SUPABASE_REGIONS;
  }
}

export async function createProject(
  accessToken: string,
  params: { name: string; organizationId: string; region: string; dbPass: string },
): Promise<SupabaseCreateProjectResult> {
  const res = await fetch(`${MGMT_BASE}/v1/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: params.name,
      organization_id: params.organizationId,
      region: params.region,
      db_pass: params.dbPass,
    }),
  });
  if (!res.ok) {
    // Il corpo della risposta va conservato: e' l'unico posto dove Supabase
    // spiega PERCHE' ha rifiutato (es. limite di progetti del piano Free).
    // Scartandolo, ogni fallimento diventava un generico "riprova".
    const body = await res.text().catch(() => '');
    throw new SupabaseApiError(
      `Supabase create project error: ${res.status}`,
      res.status,
      body,
    );
  }
  const data = (await res.json()) as { id?: unknown; ref?: unknown };
  const ref = String(data.id ?? data.ref);
  return { ref };
}

export async function getProject(
  accessToken: string,
  ref: string,
): Promise<{ status: string }> {
  const res = await fetch(`${MGMT_BASE}/v1/projects/${ref}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Supabase get project error: ${res.status}`);
  const data = (await res.json()) as { status?: unknown };
  return { status: String(data.status ?? 'UNKNOWN') };
}

export async function resetDbPassword(
  accessToken: string,
  ref: string,
  newPass: string,
): Promise<void> {
  const res = await fetch(`${MGMT_BASE}/v1/projects/${ref}/config/database`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: newPass }),
  });
  if (res.status === 404 || res.status === 405) {
    throw new Error('unsupported: reset db password non disponibile');
  }
  if (!res.ok) throw new Error(`Supabase reset password error: ${res.status}`);
}
