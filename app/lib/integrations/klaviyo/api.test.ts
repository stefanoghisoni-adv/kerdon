import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listProfiles,
  sampleProperties,
  accountName,
  toCountryCode,
  KlaviyoAuthError,
  KlaviyoUnavailableError,
} from './api.server';
import { KLAVIYO_REVISION } from './config.server';

const fetchMock = vi.fn();
const sleep = vi.fn(async () => {});

function risposta(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/vnd.api+json', ...headers },
  });
}

function profilo(id: string, attributes: Record<string, unknown>) {
  return { type: 'profile', id, attributes };
}

function pagina(data: unknown[], next: string | null = null) {
  return { data, links: { self: 'x', next } };
}

describe('API Klaviyo', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    sleep.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('listProfiles', () => {
    it('chiede la prima pagina con token, revisione e 100 per pagina', async () => {
      fetchMock.mockResolvedValueOnce(risposta(200, pagina([])));
      await listProfiles('tok', null, { sleep });

      const [url, init] = fetchMock.mock.calls[0];
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe('https://a.klaviyo.com/api/profiles');
      expect(u.searchParams.get('page[size]')).toBe('100');
      expect(init.headers.Authorization).toBe('Bearer tok');
      expect(init.headers.revision).toBe(KLAVIYO_REVISION);
      expect(init.headers.accept).toBe('application/vnd.api+json');
    });

    it('segue il cursore come URL completo', async () => {
      const next = 'https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=abc&page%5Bsize%5D=100';
      fetchMock.mockResolvedValueOnce(risposta(200, pagina([], next)));
      const primo = await listProfiles('tok', null, { sleep });
      expect(primo.next).toBe(next);

      fetchMock.mockResolvedValueOnce(risposta(200, pagina([])));
      const secondo = await listProfiles('tok', primo.next, { sleep });
      expect(fetchMock.mock.calls[1][0]).toBe(next);
      expect(secondo.next).toBeNull();
    });

    it('non manda il token a un cursore fuori da Klaviyo', async () => {
      await expect(
        listProfiles('tok', 'https://evil.example.com/api/profiles', { sleep }),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('mappa i campi del profilo', async () => {
      fetchMock.mockResolvedValueOnce(
        risposta(
          200,
          pagina([
            profilo('p1', {
              email: 'a@b.it',
              phone_number: '+393331234567',
              external_id: '123',
              location: { country: 'Italy' },
              properties: { Compleanno: '1990-05-01' },
            }),
            profilo('p2', {
              email: null,
              phone_number: null,
              external_id: 'abc-123',
              location: null,
              properties: null,
            }),
          ]),
        ),
      );
      const { profiles } = await listProfiles('tok', null, { sleep });
      expect(profiles).toEqual([
        {
          id: 'p1',
          email: 'a@b.it',
          phone: '+393331234567',
          countryCode: 'IT',
          shopifyCustomerId: 123,
          properties: { Compleanno: '1990-05-01' },
        },
        {
          id: 'p2',
          email: null,
          phone: null,
          countryCode: null,
          shopifyCustomerId: null,
          properties: {},
        },
      ]);
    });

    it('429 con Retry-After: 2 aspetta 2000 ms una volta e poi riesce', async () => {
      fetchMock
        .mockResolvedValueOnce(risposta(429, {}, { 'Retry-After': '2' }))
        .mockResolvedValueOnce(risposta(200, pagina([])));
      await listProfiles('tok', null, { sleep });
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(2000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('senza Retry-After aspetta 1, 2, 4, 8 s', async () => {
      fetchMock
        .mockResolvedValueOnce(risposta(500, {}))
        .mockResolvedValueOnce(risposta(502, {}))
        .mockResolvedValueOnce(risposta(429, {}))
        .mockResolvedValueOnce(risposta(503, {}))
        .mockResolvedValueOnce(risposta(200, pagina([])));
      await listProfiles('tok', null, { sleep });
      expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1000, 2000, 4000, 8000]);
    });

    it('5 risposte 503 di fila: KlaviyoUnavailableError', async () => {
      fetchMock.mockImplementation(async () => risposta(503, {}));
      await expect(listProfiles('tok', null, { sleep })).rejects.toBeInstanceOf(
        KlaviyoUnavailableError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('401 e 403: KlaviyoAuthError, senza ritentare', async () => {
      fetchMock.mockResolvedValueOnce(risposta(401, {}));
      await expect(listProfiles('tok', null, { sleep })).rejects.toBeInstanceOf(
        KlaviyoAuthError,
      );
      fetchMock.mockResolvedValueOnce(risposta(403, {}));
      await expect(listProfiles('tok', null, { sleep })).rejects.toBeInstanceOf(
        KlaviyoAuthError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe('toCountryCode', () => {
    it('riconosce codici, nomi inglesi e italiani', () => {
      expect(toCountryCode('IT')).toBe('IT');
      expect(toCountryCode('it')).toBe('IT');
      expect(toCountryCode('Italy')).toBe('IT');
      expect(toCountryCode('Italia')).toBe('IT');
      expect(toCountryCode('  germany ')).toBe('DE');
      expect(toCountryCode('United States')).toBe('US');
      expect(toCountryCode('USA')).toBe('US');
      expect(toCountryCode('United Kingdom')).toBe('GB');
      expect(toCountryCode('UK')).toBe('GB');
    });

    it('null quando non si riconosce', () => {
      expect(toCountryCode(null)).toBeNull();
      expect(toCountryCode('')).toBeNull();
      expect(toCountryCode('Atlantide')).toBeNull();
      expect(toCountryCode('ZZ')).toBeNull();
    });
  });

  describe('sampleProperties', () => {
    it('raccoglie le chiavi e al massimo 5 esempi per chiave, fermandosi a max profili', async () => {
      const prima = Array.from({ length: 3 }, (_, i) =>
        profilo(`a${i}`, { properties: { Colore: `c${i}`, Vuoto: null } }),
      );
      const seconda = Array.from({ length: 5 }, (_, i) =>
        profilo(`b${i}`, { properties: { Colore: `d${i}`, Taglia: 'M' } }),
      );
      fetchMock
        .mockResolvedValueOnce(
          risposta(200, pagina(prima, 'https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=2')),
        )
        .mockResolvedValueOnce(
          risposta(200, pagina(seconda, 'https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=3')),
        );

      const r = await sampleProperties('tok', 8);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(r.keys).toEqual(['Colore', 'Taglia', 'Vuoto']);
      expect(r.samples.Colore).toEqual(['c0', 'c1', 'c2', 'd0', 'd1']);
      expect(r.samples.Taglia).toEqual(['M']);
      expect(r.samples.Vuoto).toEqual([]);
    });
  });

  describe('accountName', () => {
    it('legge il nome dell organizzazione', async () => {
      fetchMock.mockResolvedValueOnce(
        risposta(200, {
          data: [
            {
              type: 'account',
              id: 'acc',
              attributes: { contact_information: { organization_name: 'Negozio Srl' } },
            },
          ],
        }),
      );
      expect(await accountName('tok')).toBe('Negozio Srl');
      expect(fetchMock.mock.calls[0][0]).toBe('https://a.klaviyo.com/api/accounts');
    });

    it('null se manca', async () => {
      fetchMock.mockResolvedValueOnce(risposta(200, { data: [] }));
      expect(await accountName('tok')).toBeNull();
    });
  });
});
