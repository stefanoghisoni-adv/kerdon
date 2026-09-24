// app/lib/supabase-oauth-rinnovo.test.ts
//
// La corsa al rinnovo del permesso Supabase, quella dei log del 20 settembre.
//
// Alle 15:56 la dashboard di coreward-demo apre sei chiamate `/api/stats/*`
// dentro lo stesso secondo. Il token d'accesso era appena scaduto, e ognuna
// delle sei e' partita a rinnovarlo con lo stesso refresh token. Supabase lo
// ruota a ogni uso: la prima e' passata, le altre hanno trovato un refresh
// token gia' consumato e si sono prese un 404 — che l'app traduceva in "serve
// ricollegare Supabase". Alle 15:58, dopo un semplice ricaricamento, le stesse
// rotte rispondevano pulite con lo stesso collegamento.
//
// Qui si prova che quella corsa non produce piu' ne' rinnovi in piu' ne'
// messaggi sbagliati, ai due livelli in cui la corsa esiste davvero: dentro la
// stessa invocazione e fra istanze diverse. Le istanze diverse si simulano
// importando il modulo due volte (`vi.resetModules`): due copie della memoria,
// un solo database — che e' esattamente com'e' fatto Vercel.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface Riga {
  shopId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  updatedAt: Date;
}

let riga: Riga | null = null;
const refreshAccessToken = vi.fn();

function valore(v: unknown): unknown {
  // Prisma accetta anche `{ set: ... }`: qui i test scrivono valori secchi.
  return v && typeof v === 'object' && 'set' in (v as Record<string, unknown>)
    ? (v as { set: unknown }).set
    : v;
}

vi.mock('~/db.server', () => ({
  prisma: {
    supabaseOAuthToken: {
      findUnique: async ({ where }: { where: { shopId: string } }) =>
        riga && riga.shopId === where.shopId ? { ...riga } : null,

      // La presa del turno vive o muore su questa semantica: si scrive solo se
      // `updatedAt` e' rimasto quello letto. E' la stessa guardia che Postgres
      // applica dentro la UPDATE.
      updateMany: async ({
        where,
        data,
      }: {
        where: { shopId: string; updatedAt?: Date };
        data: Record<string, unknown>;
      }) => {
        if (!riga || riga.shopId !== where.shopId) return { count: 0 };
        if (where.updatedAt && riga.updatedAt.getTime() !== where.updatedAt.getTime()) {
          return { count: 0 };
        }
        riga = { ...riga, updatedAt: valore(data.updatedAt) as Date };
        return { count: 1 };
      },

      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { shopId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const dati = (riga ? update : create) as {
          accessToken: string;
          refreshToken: string;
          expiresAt: Date;
        };
        riga = {
          shopId: where.shopId,
          accessToken: dati.accessToken,
          refreshToken: dati.refreshToken,
          expiresAt: dati.expiresAt,
          // Come `@updatedAt`: ogni scrittura la sposta ad adesso.
          updatedAt: new Date(),
        };
      },
    },
  },
}));

vi.mock('~/utils/crypto.server', () => ({
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
}));

vi.mock('./supabase-management.server', async () => {
  // `SupabaseTokenError` resta quello vero: la classificazione del 404 e'
  // meta' di quel che c'e' da provare.
  const vero = await vi.importActual<typeof import('./supabase-management.server')>(
    './supabase-management.server',
  );
  return { ...vero, refreshAccessToken: (...a: unknown[]) => refreshAccessToken(...a) };
});

import { SupabaseTokenError, isSupabaseCredentialDead } from './supabase-management.server';

type Modulo = typeof import('./supabase-oauth.server');

/** Una copia del modulo con la sua memoria: un'altra istanza su Vercel. */
async function istanza(): Promise<Modulo> {
  vi.resetModules();
  return import('./supabase-oauth.server');
}

const ORA = Date.now();

function rigaScaduta(): Riga {
  return {
    shopId: 'shop-1',
    accessToken: 'vecchio',
    refreshToken: 'refresh-vecchio',
    // Scaduto da un minuto, e toccato l'ultima volta un'ora fa: e' la
    // situazione in cui si sveglia la dashboard.
    expiresAt: new Date(ORA - 60_000),
    updatedAt: new Date(ORA - 60 * 60 * 1000),
  };
}

function tokenNuovo() {
  return {
    access_token: 'nuovo',
    refresh_token: 'refresh-nuovo',
    expires_in: 3600,
    token_type: 'bearer',
  };
}

describe('rinnovo del permesso Supabase sotto concorrenza', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    riga = rigaScaduta();
    process.env.SUPABASE_OAUTH_CLIENT_ID = 'cid';
    process.env.SUPABASE_OAUTH_CLIENT_SECRET = 'sec';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sei richieste nella stessa invocazione rinnovano una volta sola', async () => {
    refreshAccessToken.mockImplementation(async () => {
      // Un giro di rete: senza questo il primo chiamante finirebbe prima che
      // gli altri comincino, e la corsa non ci sarebbe.
      await new Promise((r) => setTimeout(r, 20));
      return tokenNuovo();
    });

    const modulo = await istanza();
    const esiti = await Promise.all(
      Array.from({ length: 6 }, () => modulo.getValidAccessToken('shop-1')),
    );

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(esiti).toEqual(Array(6).fill('nuovo'));
  });

  it('due istanze diverse rinnovano una volta sola: la seconda aspetta e usa il token della prima', async () => {
    refreshAccessToken.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return tokenNuovo();
    });

    const prima = await istanza();
    const seconda = await istanza();

    // Partono insieme, e la memoria dell'una non vede l'altra: se non ci fosse
    // il turno sul database sarebbero due rinnovi e un 404.
    const [a, b] = await Promise.all([
      prima.getValidAccessToken('shop-1'),
      seconda.getValidAccessToken('shop-1'),
    ]);

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(a).toBe('nuovo');
    expect(b).toBe('nuovo');
    expect(riga?.accessToken).toBe('nuovo');
  });

  it('chi perde il turno e non vede arrivare niente non chiede un secondo rinnovo', async () => {
    vi.useFakeTimers();
    // Il turno appena preso da un'altra istanza che poi non salva nulla —
    // l'invocazione e' morta a meta'.
    riga = { ...rigaScaduta(), updatedAt: new Date() };

    const modulo = await istanza();
    const promessa = modulo.getValidAccessToken('shop-1');
    const atteso = expect(promessa).rejects.toBeInstanceOf(modulo.RinnovoPermessoInCorsoError);
    await vi.advanceTimersByTimeAsync(4_000);
    await atteso;

    // Il punto: nessuna seconda chiamata a Supabase, e nessun messaggio che
    // mandi il merchant a ricollegare per un'attesa.
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('un 404 sul rinnovo non diventa "ricollega" se sulla riga c e gia un token buono', async () => {
    // La corsa che la presa non ha visto: l'altro ha gia' salvato, e a noi
    // torna il rifiuto del refresh token consumato.
    refreshAccessToken.mockImplementation(async () => {
      riga = {
        shopId: 'shop-1',
        accessToken: 'salvato-dall-altro',
        refreshToken: 'refresh-altro',
        expiresAt: new Date(Date.now() + 3600_000),
        updatedAt: new Date(),
      };
      throw new SupabaseTokenError(404);
    });

    const modulo = await istanza();
    await expect(modulo.getValidAccessToken('shop-1')).resolves.toBe('salvato-dall-altro');
  });

  it('un 404 con la riga ancora senza token valido resta un permesso da ricollegare', async () => {
    refreshAccessToken.mockRejectedValue(new SupabaseTokenError(404));

    const modulo = await istanza();
    const errore = await modulo.getValidAccessToken('shop-1').catch((e) => e);

    expect(isSupabaseCredentialDead(errore)).toBe(true);
    expect((errore as SupabaseTokenError).status).toBe(404);
  });

  it('un permesso davvero revocato continua a dire ricollega', async () => {
    refreshAccessToken.mockRejectedValue(new SupabaseTokenError(401));

    const modulo = await istanza();
    const errore = await modulo.getValidAccessToken('shop-1').catch((e) => e);

    expect(isSupabaseCredentialDead(errore)).toBe(true);
  });

  it('un guasto passeggero di Supabase non si traduce in ricollega', async () => {
    refreshAccessToken.mockRejectedValue(new SupabaseTokenError(503));

    const modulo = await istanza();
    const errore = await modulo.getValidAccessToken('shop-1').catch((e) => e);

    expect(isSupabaseCredentialDead(errore)).toBe(false);
  });

  it('un token ancora buono non fa ne prese ne chiamate', async () => {
    riga = {
      shopId: 'shop-1',
      accessToken: 'ancora-valido',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3600_000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    };
    const primaDi = riga.updatedAt;

    const modulo = await istanza();
    await expect(modulo.getValidAccessToken('shop-1')).resolves.toBe('ancora-valido');

    expect(refreshAccessToken).not.toHaveBeenCalled();
    // Nessuna scrittura sul percorso normale: il turno si paga solo a scadenza.
    expect(riga.updatedAt).toBe(primaDi);
  });

  it('un rinnovo fallito non lascia il negozio bloccato in memoria', async () => {
    refreshAccessToken.mockRejectedValueOnce(new SupabaseTokenError(503));
    const modulo = await istanza();
    await expect(modulo.getValidAccessToken('shop-1')).rejects.toBeInstanceOf(SupabaseTokenError);

    // Il turno sulla riga e' ormai fresco, quindi il secondo tentativo dalla
    // stessa istanza si mette in fila invece di ripartire: quel che conta e'
    // che NON resti attaccato alla promessa fallita di prima.
    refreshAccessToken.mockResolvedValue(tokenNuovo());
    riga = { ...rigaScaduta() };
    await expect(modulo.getValidAccessToken('shop-1')).resolves.toBe('nuovo');
    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
  });
});
