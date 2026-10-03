import { createHash, randomBytes } from 'crypto';
import { encrypt, decrypt } from '~/utils/crypto.server';
import { KLAVIYO_SCOPES, klaviyoCredentials, klaviyoRedirectUri } from './config.server';
import { KlaviyoAuthError, KlaviyoUnavailableError } from './api.server';

const AUTHORIZE_URL = 'https://www.klaviyo.com/oauth/authorize';
const TOKEN_URL = 'https://a.klaviyo.com/oauth/token';
const REVOKE_URL = 'https://a.klaviyo.com/oauth/revoke';

/** Il tempo di un'autorizzazione, non di una sessione. */
const STATE_TTL_MS = 10 * 60 * 1000;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * Il `state` porta con se' il negozio e il verifier PKCE, cifrati.
 *
 * Il verifier non deve uscire in chiaro (e' il segreto del giro PKCE) e non
 * c'e' nessuna tabella dove parcheggiarlo: la pagina di ritorno vive fuori
 * dall'admin di Shopify. Con AES-GCM lo state e' insieme segreto e firmato:
 * chi lo tocca rompe il tag di autenticazione e `readState` restituisce null.
 */
export function buildAuthorizeUrl(shopId: string, now: Date = new Date()): string {
  const { clientId } = klaviyoCredentials();
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = Buffer.from(
    encrypt(JSON.stringify({ shopId, verifier, exp: now.getTime() + STATE_TTL_MS })),
  ).toString('base64url');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: klaviyoRedirectUri(),
    scope: KLAVIYO_SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function readState(
  state: string,
  now: Date = new Date(),
): { shopId: string; verifier: string } | null {
  try {
    const parsed = JSON.parse(decrypt(Buffer.from(state, 'base64url').toString())) as {
      shopId?: unknown;
      verifier?: unknown;
      exp?: unknown;
    };
    if (
      typeof parsed.shopId !== 'string' ||
      typeof parsed.verifier !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    if (now.getTime() > parsed.exp) return null;
    return { shopId: parsed.shopId, verifier: parsed.verifier };
  } catch {
    return null;
  }
}

function basicAuth(): string {
  const { clientId, clientSecret } = klaviyoCredentials();
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
}

/**
 * Una chiamata all'endpoint dei token, con l'esito gia' classificato.
 *
 * 400 e 401 sono un no di Klaviyo sulla credenziale (`invalid_grant`, che la
 * documentazione dice di trattare come app disinstallata): `KlaviyoAuthError`.
 * Tutto il resto — 5xx, 429, rete giu' — e' un guasto passeggero e non deve
 * diventare "ricollega Klaviyo": `KlaviyoUnavailableError`.
 */
async function tokenRequest(
  body: Record<string, string>,
  previousRefreshToken?: string,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await postForm(TOKEN_URL, body);
  } catch (e) {
    throw new KlaviyoUnavailableError(`Endpoint dei token Klaviyo irraggiungibile: ${String(e)}`);
  }

  if (res.status === 400 || res.status === 401) {
    const detail = await res.text().catch(() => '');
    throw new KlaviyoAuthError(`Klaviyo ha rifiutato la credenziale (${res.status}): ${detail}`);
  }
  if (!res.ok) {
    throw new KlaviyoUnavailableError(`Endpoint dei token Klaviyo: ${res.status}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const refreshToken = json.refresh_token ?? previousRefreshToken;
  if (!json.access_token || !refreshToken || typeof json.expires_in !== 'number') {
    throw new KlaviyoUnavailableError('Risposta dei token Klaviyo incompleta');
  }
  return {
    accessToken: json.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
  };
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: klaviyoRedirectUri(),
  });
}

/**
 * Se la risposta non porta un refresh token nuovo si tiene quello vecchio:
 * Klaviyo lo emette all'autorizzazione e lo tiene valido finche' l'app resta
 * installata.
 */
export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken);
}

/** Best effort: chi scollega non deve restare bloccato da un errore di Klaviyo. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await postForm(REVOKE_URL, { token_type_hint: 'refresh_token', token });
  } catch {
    // Niente da fare: il token si azzera comunque dalla nostra parte.
  }
}
