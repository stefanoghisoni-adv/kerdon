import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Le due rotte `privacy.*` di prima, dopo l'arrivo dell'informativa.
 *
 * PERCHE' QUESTO FILE ESISTE. Perche' il nome naturale della pagina nuova era
 * `/privacy`, e in Remix quel nome non sarebbe stato una pagina: `privacy.tsx`
 * accanto a `privacy.export.$id.tsx` e `privacy.my-data.tsx` diventa il LORO
 * LAYOUT. Le due rotte smetterebbero di essere rotte-risorsa indipendenti e
 * passerebbero da un genitore, e sono le due vie d'uscita con cui un merchant
 * si porta via i propri dati: quella che consegna la copia del negozio e quella
 * che consegna l'esportazione chiesta da un suo cliente.
 *
 * La pagina sta quindi su `policies.privacy-policy`, un altro ramo che non crea
 * nessuna gerarchia. Ma una scelta del genere si dimentica: fra un anno
 * qualcuno potrebbe "accorciare l'indirizzo" e rinominare il file. Qui si
 * scrive che non si puo', e si verifica che le due rotte facciano ancora quel
 * che facevano — consegnare un file, e solo all'amministratore del negozio che
 * lo chiede.
 */

const findUniqueShop = vi.fn();
const findFirstCompliance = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'negozio.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    complianceRequest: { findFirst: (...a: unknown[]) => findFirstCompliance(...a) },
  },
}));
vi.mock('~/lib/privacy/shop-export', () => ({
  buildShopExport: () => ({ negozio: 'negozio.myshopify.com' }),
  shopExportFilename: () => 'kerdon-negozio.json',
}));

import { loader as copiaDelNegozio } from './privacy.my-data';
import { loader as esportazione } from './privacy.export.$id';

const chiedi = (
  loader: (args: never) => unknown,
  url: string,
  params: Record<string, string> = {},
) => loader({ request: new Request(url), params, context: {} } as never) as Promise<Response>;

beforeEach(() => vi.clearAllMocks());

describe('nessun layout si e messo davanti alle rotte privacy.*', () => {
  it('non esiste un file privacy.tsx, che ne diventerebbe il genitore', () => {
    const file = readdirSync(join(process.cwd(), 'app', 'routes'));

    expect(file).not.toContain('privacy.tsx');
    // Le due che devono restare dove sono, e la pagina nuova che non le tocca.
    expect(file).toContain('privacy.my-data.tsx');
    expect(file).toContain('privacy.export.$id.tsx');
    expect(file).toContain('policies.privacy-policy.tsx');
  });
});

describe('la copia dei dati del negozio, come prima', () => {
  it('si consegna come file e non resta in nessuna cache', async () => {
    findUniqueShop.mockResolvedValue({
      id: 'negozio-1',
      shopDomain: 'negozio.myshopify.com',
      supabaseConfig: null,
      trackingSetup: null,
      billingCharges: [],
      syncJobs: [],
      complianceRequests: [],
      customerDataAccessLogs: [],
    });

    const risposta = await chiedi(copiaDelNegozio, 'https://app/privacy/my-data');

    expect(risposta.status).toBe(200);
    expect(risposta.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(risposta.headers.get('Content-Disposition')).toContain('attachment');
    expect(risposta.headers.get('Cache-Control')).toContain('no-store');
  });
});

describe("l'esportazione di un cliente, come prima", () => {
  it('si consegna a chi ha diritto di riceverla', async () => {
    findFirstCompliance.mockResolvedValue({
      export: { cliente: 'inventato' },
      exportExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      customerRef: 'ab12cd34ef56',
    });

    const risposta = await chiedi(esportazione, 'https://app/privacy/export/abc', { id: 'abc' });

    expect(risposta.status).toBe(200);
    expect(risposta.headers.get('Content-Disposition')).toContain('attachment');
  });

  it('scaduta, non si consegna piu', async () => {
    findFirstCompliance.mockResolvedValue({
      export: { cliente: 'inventato' },
      exportExpiresAt: new Date(Date.now() - 1000),
      customerRef: 'ab12cd34ef56',
    });

    const rifiuto = await chiedi(esportazione, 'https://app/privacy/export/abc', {
      id: 'abc',
    }).catch((e) => e as Response);

    expect(rifiuto.status).toBe(404);
  });
});
