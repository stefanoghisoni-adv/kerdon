import { describe, it, expect, vi } from 'vitest';

/**
 * La rotta dell'informativa risponde a chi non ha niente addosso.
 *
 * QUESTO E' IL PUNTO, e non e' un dettaglio di implementazione: la pagina la
 * apre il revisore Shopify, prima che l'app sia installata da qualcuno, e
 * chiunque riceva il link. Se un giorno qualcuno la trasformasse in una pagina
 * normale dell'app — con un componente, quindi sotto il `loader` di `root.tsx`
 * che autentica l'amministratore — l'informativa smetterebbe di essere leggibile
 * senza accorgersene nessuno: in locale, dentro l'admin, continuerebbe a
 * funzionare.
 *
 * I FINTI CHE NON SERVONO. `~/shopify.server` e `~/db.server` sono qui apposta
 * per NON essere usati: se la rotta cominciasse a toccarli, il test non
 * fallirebbe per un errore di importazione — fallirebbe dicendo che li ha
 * chiamati, che e' la cosa che si vuole sapere.
 */

const autenticaAdmin = vi.fn();
vi.mock('~/shopify.server', () => ({
  authenticate: { admin: (...a: unknown[]) => autenticaAdmin(...a) },
}));
vi.mock('~/db.server', () => ({ prisma: {} }));

import { loader } from './privacy-policy';
import { versioneEData, SORGENTI } from '~/lib/legal/privacy-policy';
import * as rotta from './privacy-policy';

const chiedi = (url: string, intestazioni: Record<string, string> = {}) =>
  loader({
    request: new Request(url, { headers: intestazioni }),
    params: {},
    context: {},
  } as never) as Promise<Response>;

describe('senza nessuna sessione', () => {
  it('risponde 200 con il documento, e non autentica nessuno', async () => {
    const risposta = await chiedi('https://api.kerdon.io/privacy-policy');

    expect(risposta.status).toBe(200);
    expect(risposta.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(autenticaAdmin).not.toHaveBeenCalled();
    expect(await risposta.text()).toContain('Privacy Policy');
  });

  it('non e una pagina dell app: non ha un componente da rendere', () => {
    // Un `default` qui dentro la rimetterebbe sotto il guscio di `root.tsx`,
    // che autentica l'amministratore: la pagina tornerebbe privata.
    expect((rotta as Record<string, unknown>).default).toBeUndefined();
  });

  it('da qui non si scrive niente', () => {
    expect((rotta as Record<string, unknown>).action).toBeUndefined();
  });
});

describe('le due lingue', () => {
  it('il link che nomina la lingua vince su quella del browser', async () => {
    const italiana = await chiedi('https://api.kerdon.io/privacy-policy?lang=it', {
      'accept-language': 'en-US,en;q=0.9',
    });

    const corpo = await italiana.text();
    expect(corpo).toContain('<html lang="it">');
    expect(corpo).toContain('Informativa sulla privacy');
  });

  it('senza parametro si segue il browser', async () => {
    const italiana = await chiedi('https://api.kerdon.io/privacy-policy', {
      'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
    });

    expect(await italiana.text()).toContain('<html lang="it">');
  });

  it('il revisore, che arriva senza dichiarare niente, legge in inglese', async () => {
    const corpo = await (await chiedi('https://api.kerdon.io/privacy-policy')).text();

    expect(corpo).toContain('<html lang="en">');
    expect(corpo).toContain('Who we are');
  });

  it('dichiara di variare con la lingua del browser', async () => {
    // Senza, la prima copia finita in una cache condivisa verrebbe servita a
    // tutti: l'italiano al revisore, o l'inglese al merchant italiano.
    const risposta = await chiedi('https://api.kerdon.io/privacy-policy');

    expect(risposta.headers.get('Vary')).toBe('Accept-Language');
  });
});

describe('quel che la pagina pubblica dichiara', () => {
  it('porta la versione e la data del documento', async () => {
    const { versione, data } = versioneEData(SORGENTI.en);
    const corpo = await (await chiedi('https://api.kerdon.io/privacy-policy?lang=en')).text();

    expect(corpo).toContain(versione);
    expect(corpo).toContain(data);
  });
});
