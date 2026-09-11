// e2e/tests/consenso-vetrina.spec.ts
//
// Il ponte del consenso, dove vive: nella vetrina di un negozio, in un browser.
//
// PERCHE' QUESTO FILE NON PUO' ESSERE UNA PROVA UNITARIA. `consentBridgeScript()`
// non e' una funzione da chiamare: e' una STRINGA di JavaScript che qualcun
// altro esegue, dentro la pagina di un negozio, dove tocca `document.cookie`,
// ascolta un evento del documento, legge `document.currentScript` e chiama
// `fetch`. Provarla senza un browser vorrebbe dire ricostruire tutte e quattro
// quelle cose — cioe' provare la ricostruzione.
//
// E LA REGOLA CHE SORVEGLIA E' LA PIU' DELICATA DELL'APP. Il ponte NON DECIDE.
// Non ha regole per paese, non ha valori di ripiego, non presume niente: se il
// permesso non e' stato espresso non chiama nessuno e non scrive niente. Un
// difetto qui non si vede — si continua a tracciare, e basta.
//
// NIENTE ESCE DAL BROWSER: l'endpoint del negozio e' un dominio inventato,
// intercettato qui dentro; `/cart/update.js` idem. Sono le due sole chiamate che
// il ponte fa, e sono tutte e due verso il dominio del negozio — mai verso di
// noi, e mai con una credenziale addosso.

import { expect, test as prova } from './support/prova';
import { CONSENT_COOKIE } from '~/lib/tracking/consent';
import { EXTERNAL_ID_COOKIE } from '~/lib/tracking/external-id';

const ENDPOINT = 'https://vetrina-inventata.test/eid';
const IDENTIFICATIVO = 'eid-di-prova-0001';

interface ChiamataEndpoint {
  url: string;
  credenziali: string;
}

/**
 * Apre la vetrina con l'endpoint e il carrello intercettati.
 *
 * Restituisce i due registri su cui le prove fanno le loro asserzioni: cosa e'
 * stato chiesto all'endpoint, e cosa e' stato scritto nel carrello.
 */
async function apriVetrina(
  page: import('@playwright/test').Page,
  opzioni: { identificativo?: string | null } = {},
) {
  const chiamate: ChiamataEndpoint[] = [];
  const carrello: Record<string, string>[] = [];

  await page.route(`${ENDPOINT}*`, async (route) => {
    chiamate.push({
      url: route.request().url(),
      credenziali: route.request().headers()['cookie'] ?? '',
    });
    const identificativo =
      opzioni.identificativo === undefined ? IDENTIFICATIVO : opzioni.identificativo;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // La forma e' quella del proxy di lettura: un elenco con una riga.
      body: JSON.stringify(identificativo ? [{ external_id: identificativo }] : []),
    });
  });

  await page.route('**/cart/update.js', async (route) => {
    const corpo = route.request().postDataJSON() as { attributes: Record<string, string> };
    carrello.push(corpo.attributes);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/e2e/harness/vetrina.html');
  return { chiamate, carrello };
}

async function cookie(page: import('@playwright/test').Page, nome: string): Promise<string | null> {
  const tutti = await page.context().cookies();
  return tutti.find((c) => c.name === nome)?.value ?? null;
}

prova.describe('il ponte del consenso in vetrina', () => {
  prova('senza una risposta del visitatore il ponte tace', async ({ page }) => {
    const { chiamate, carrello } = await apriVetrina(page);

    // E' il caso piu' importante di tutti: chi non ha ancora risposto al banner
    // non ha detto di no. Dire "no" al posto suo sarebbe dire una cosa non
    // vera; dire "si'" sarebbe molto peggio.
    await page.waitForTimeout(300);
    expect(chiamate).toHaveLength(0);
    expect(carrello).toHaveLength(0);
    expect(await cookie(page, CONSENT_COOKIE)).toBeNull();
    expect(await page.evaluate(() => window.dataLayer.length)).toBe(0);
  });

  prova('col permesso dato si annuncia, si chiede l identificativo e lo si attacca al carrello', async ({
    page,
  }) => {
    const { chiamate, carrello } = await apriVetrina(page);

    await page.evaluate(() => window.dichiara({ analytics: 'yes', marketing: 'yes' }));

    await expect.poll(() => chiamate.length).toBe(1);

    // Il permesso viaggia in forma compatta, e la versione della grammatica e'
    // la prima cosa che ci sta dentro.
    const chiesto = new URL(chiamate[0].url);
    expect(chiesto.searchParams.get('consent')).toBe('v1.a1.m1');
    // L'endpoint deve poter rileggere il cookie che ha piantato lui: senza,
    // ogni visita sarebbe una persona nuova.
    expect(chiamate[0].url.startsWith(ENDPOINT)).toBe(true);

    // L'annuncio sul dataLayer, e poi l'identificativo.
    await expect
      .poll(() => page.evaluate(() => window.eventi('kerdon_identity').length))
      .toBe(1);
    expect(await page.evaluate(() => window.eventi('kerdon_consent_granted').length)).toBe(1);
    expect(
      await page.evaluate(() => window.eventi('kerdon_identity')[0].kerdon_external_id),
    ).toBe(IDENTIFICATIVO);

    // E l'identificativo finisce sul carrello: e' cosi' che risale nell'ordine,
    // e quindi che l'acquisto di oggi si lega alla visita di tre settimane fa.
    await expect.poll(() => carrello.length).toBe(1);
    expect(carrello[0].kerdon_eid).toBe(IDENTIFICATIVO);

    // La copia leggibile del permesso resta nel cookie.
    expect(await cookie(page, CONSENT_COOKIE)).toBe('v1.a1.m1');
  });

  prova('col permesso negato non si conia niente, e lo si dice lo stesso', async ({ page }) => {
    const { chiamate, carrello } = await apriVetrina(page);

    await page.evaluate(() => window.dichiara({ analytics: 'no', marketing: 'no' }));

    // Si chiama l'endpoint anche qui — e' l'unico modo di fargli sapere che
    // c'e' da disfare — ma la risposta NON si guarda: un endpoint che
    // rispondesse comunque con un identificativo ce lo farebbe riattaccare al
    // carrello un istante dopo averlo tolto.
    await expect.poll(() => chiamate.length).toBe(1);
    expect(new URL(chiamate[0].url).searchParams.get('consent')).toBe('v1.a0.m0');

    await expect
      .poll(() => page.evaluate(() => window.eventi('kerdon_consent_withdrawn').length))
      .toBe(1);
    expect(await page.evaluate(() => window.eventi('kerdon_identity').length)).toBe(0);

    // Il carrello viene ripulito, non lasciato com'era.
    await expect.poll(() => carrello.length).toBe(1);
    expect(carrello[0].kerdon_eid).toBe('');
  });

  prova('revocando dopo aver concesso, l identificativo viene tolto da cookie e carrello', async ({
    page,
    context,
  }) => {
    const { chiamate, carrello } = await apriVetrina(page);

    await page.evaluate(() => window.dichiara({ analytics: 'yes', marketing: 'yes' }));
    await expect.poll(() => carrello.length).toBe(1);

    // L'endpoint pianta il cookie con Set-Cookie dal dominio del negozio: qui
    // lo si mette a mano, perche' l'endpoint di questa prova sta su un dominio
    // diverso e il browser non glielo lascerebbe scrivere.
    // `path: '/'` esplicito, e non ricavato dalla URL della pagina: il ponte lo
    // cancella scrivendo `Path=/`, e un cookie piantato su
    // `/e2e/harness/` non verrebbe toccato da quella cancellazione. Sarebbe una
    // prova che fallisce per come e' stata preparata, non per come si comporta
    // il codice.
    await context.addCookies([
      {
        name: EXTERNAL_ID_COOKIE,
        value: IDENTIFICATIVO,
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.evaluate(() => window.dichiara({ analytics: 'no', marketing: 'no' }));

    await expect.poll(() => chiamate.length).toBe(2);
    // Alla revoca l'identificativo da disfare viaggia insieme: sta ancora nel
    // cookie che si sta per togliere, ed e' l'ultimo momento in cui lo si sa.
    expect(new URL(chiamate[1].url).searchParams.get('existing_external_id')).toBe(IDENTIFICATIVO);

    // E poi sparisce da tutte e due i posti in cui era.
    await expect.poll(() => cookie(page, EXTERNAL_ID_COOKIE)).toBe(null);
    await expect.poll(() => carrello.length).toBe(2);
    expect(carrello[1].kerdon_eid).toBe('');
  });

  prova('lo stesso permesso non si riannuncia due volte', async ({ page }) => {
    const { chiamate } = await apriVetrina(page);

    await page.evaluate(() => window.dichiara({ analytics: 'yes', marketing: 'yes' }));
    await expect.poll(() => chiamate.length).toBe(1);

    // Il banner rimanda l'evento a ogni pagina. L'evento e' "e' cambiato": un
    // tag che parte due volte conta due volte.
    await page.evaluate(() => window.dichiara({ analytics: 'yes', marketing: 'yes' }));
    await page.waitForTimeout(300);

    expect(chiamate).toHaveLength(1);
    expect(await page.evaluate(() => window.eventi('kerdon_consent_granted').length)).toBe(1);
  });

  prova('se l endpoint non conia niente, il ponte non insiste', async ({ page }) => {
    const { chiamate, carrello } = await apriVetrina(page, { identificativo: null });

    await page.evaluate(() => window.dichiara({ analytics: 'yes', marketing: 'yes' }));
    await expect.poll(() => chiamate.length).toBe(1);
    await page.waitForTimeout(300);

    // Nessun identificativo nella risposta E' una risposta: l'endpoint ha
    // deciso di non coniare, e non si riprova.
    expect(await page.evaluate(() => window.eventi('kerdon_identity').length)).toBe(0);
    expect(carrello).toHaveLength(0);
  });

  prova('un permesso parziale non basta: analytics senza marketing non conia', async ({ page }) => {
    const { chiamate, carrello } = await apriVetrina(page);

    await page.evaluate(() => window.dichiara({ analytics: 'yes' }));
    await page.waitForTimeout(300);

    // `allowed` vuole tutti e due. Il cookie con la forma compatta si scrive —
    // il visitatore ha detto qualcosa, e quel qualcosa va registrato — ma
    // nessuno viene identificato.
    expect(await cookie(page, CONSENT_COOKIE)).toBe('v1.a1');
    expect(chiamate).toHaveLength(0);
    expect(carrello).toHaveLength(0);
    expect(await page.evaluate(() => window.eventi('kerdon_identity').length)).toBe(0);
  });
});
