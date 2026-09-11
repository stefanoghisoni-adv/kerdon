// e2e/tests/gdpr-export.spec.ts
//
// La copia dei dati di una persona, consegnata a chi ha diritto di riceverla.
//
// PERCHE' IN UN BROWSER. Perche' questa rotta non restituisce dei dati: fa
// SCARICARE un file. Il nome del file, il tipo dichiarato e il divieto di
// metterlo in cache stanno tutti in tre intestazioni, e sono tre intestazioni
// che nessuna prova unitaria puo' vedere rispettate — le rispetta il browser,
// oppure non le rispetta nessuno. Un `Content-Disposition` scritto male non
// rompe niente: apre il JSON in una scheda invece di salvarlo, e la copia dei
// dati di una persona resta li' a schermo.
//
// E poi le tre condizioni di consegna, che sono il punto vero. L'esportazione
// non ha nessun indirizzo pubblico — nemmeno lungo e casuale — perche' un
// indirizzo indovinabile o inoltrato per sbaglio diventa una copia dei dati di
// una persona che gira senza controllo.

import { expect, test } from './support/prova';
import {
  ALTRO_NEGOZIO,
  azzera,
  db,
  entraComeNegozio,
  NEGOZIO,
  seminaNegozio,
  spostaOrologio,
} from './support/server';

const ORA = 60 * 60 * 1000;

/** Una richiesta di accesso gia' lavorata, con la sua copia pronta da scaricare. */
async function seminaEsportazione(
  request: import('@playwright/test').APIRequestContext,
  opzioni: { shopDomain?: string; scadeFraMs?: number } = {},
): Promise<string> {
  const riga = await db<{ id: string }>(request, 'complianceRequest', 'create', {
    data: {
      webhookId: `consegna-${Math.random().toString(16).slice(2)}`,
      topic: 'customers/data_request',
      shopDomain: opzioni.shopDomain ?? NEGOZIO,
      status: 'completed',
      customerRef: 'ab12cd34ef56',
      // Dati inventati: qui non entra niente che venga da un negozio vero.
      export: { cliente: { nome: 'Prova Inventata', email: 'prova@esempio.test' }, ordini: [] },
      exportExpiresAt: new Date(Date.now() + (opzioni.scadeFraMs ?? 24 * ORA)).toISOString(),
    },
    select: { id: true },
  });
  return riga.id;
}

test.describe('la consegna di un esportazione GDPR', () => {
  test.beforeEach(async ({ request, context }) => {
    await azzera(request);
    await seminaNegozio(request);
    await seminaNegozio(request, {}, ALTRO_NEGOZIO);
    await entraComeNegozio(context, NEGOZIO);
  });

  test('chi e amministratore di quel negozio la scarica, con le intestazioni giuste', async ({
    context,
    request,
  }) => {
    const id = await seminaEsportazione(request);

    // Si chiede dal contesto del browser e non con `page.goto`: la rotta
    // risponde con `Content-Disposition: attachment`, e una navigazione verso
    // un allegato il browser non la porta a termine — comincia uno scaricamento
    // e la pagina resta dov'era. Che e' esattamente cio' che deve succedere, e
    // lo verifica la prova qui sotto.
    const risposta = await context.request.get(`/privacy/export/${id}`);

    expect(risposta.status()).toBe(200);
    const intestazioni = risposta.headers();
    expect(intestazioni['content-type']).toContain('application/json');
    expect(intestazioni['content-disposition']).toContain('attachment');
    expect(intestazioni['content-disposition']).toContain('kerdon-data-request-ab12cd34.json');
    // E non resta in nessuna cache fra qui e il browser di chi la scarica.
    expect(intestazioni['cache-control']).toContain('no-store');

    const contenuto = JSON.parse(await risposta.text()) as { cliente: { email: string } };
    expect(contenuto.cliente.email).toBe('prova@esempio.test');
  });

  test('nel browser il file si scarica davvero, e con il nome giusto', async ({ page, request }) => {
    const id = await seminaEsportazione(request);

    // Si parte da una pagina dell'app e si preme un collegamento, come farebbe
    // il merchant: e' l'unico modo di sapere che il browser tratta quella
    // risposta come un file da salvare invece che come una pagina da mostrare.
    // Un `Content-Disposition` scritto male non rompe niente — apre il JSON in
    // una scheda, e la copia dei dati di una persona resta li' a schermo.
    await page.goto('/');
    await page.evaluate((indirizzo) => {
      const a = document.createElement('a');
      a.href = indirizzo;
      a.textContent = 'scarica';
      a.setAttribute('data-testid', 'scarica');
      document.body.appendChild(a);
    }, `/privacy/export/${id}`);

    const [scaricato] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-testid="scarica"]').click(),
    ]);

    expect(scaricato.suggestedFilename()).toBe('kerdon-data-request-ab12cd34.json');
    // E la pagina non si e' mossa: uno scaricamento non e' una navigazione.
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('un altro negozio non la vede, nemmeno conoscendone l id', async ({ page, request }) => {
    // L'id e' quello di una richiesta dell'ALTRO negozio: senza il controllo sul
    // negozio, conoscerlo basterebbe a leggersi l'esportazione di qualcun altro.
    const id = await seminaEsportazione(request, { shopDomain: ALTRO_NEGOZIO });

    const risposta = await page.goto(`/privacy/export/${id}`);

    expect(risposta?.status()).toBe(404);
  });

  test('senza una sessione non si consegna niente', async ({ page, context, request }) => {
    const id = await seminaEsportazione(request);
    await context.clearCookies();

    const risposta = await page.goto(`/privacy/export/${id}`);

    // Non c'e' nessun indirizzo pubblico: senza sessione la rotta non risponde
    // nemmeno 404, si ferma prima.
    expect(risposta?.status()).toBe(401);
  });

  test('scaduta la finestra non si consegna piu, anche se la riga e ancora li', async ({
    context,
    request,
  }) => {
    const id = await seminaEsportazione(request, { scadeFraMs: 2 * ORA });

    // Prima della scadenza si scarica.
    expect((await context.request.get(`/privacy/export/${id}`)).status()).toBe(200);

    // Si attraversa la scadenza spostando l'orologio, invece di scrivere nel
    // database una data gia' vecchia: nel sistema vero a "scaduto" ci si arriva
    // restandoci dentro, non nascendoci.
    await spostaOrologio(request, 3 * ORA);

    const dopo = await context.request.get(`/privacy/export/${id}`);
    // La riga c'e' ancora — il cron la svuota al giro successivo — ma la
    // scadenza vale gia'.
    expect(dopo.status()).toBe(404);
    const riga = await db<{ export: unknown } | null>(request, 'complianceRequest', 'findUnique', {
      where: { id },
      select: { export: true },
    });
    expect(riga?.export).not.toBeNull();
  });

  test('una richiesta non ancora conclusa non si scarica', async ({ page, request }) => {
    const riga = await db<{ id: string }>(request, 'complianceRequest', 'create', {
      data: {
        webhookId: 'consegna-in-lavorazione',
        topic: 'customers/data_request',
        shopDomain: NEGOZIO,
        status: 'processing',
        customerRef: 'ab12cd34ef56',
        export: { cliente: { nome: 'Ancora Da Finire' } },
        exportExpiresAt: new Date(Date.now() + 24 * ORA).toISOString(),
      },
      select: { id: true },
    });

    expect((await page.goto(`/privacy/export/${riga.id}`))?.status()).toBe(404);
  });

  test('un id inventato non dice se esiste o no: risponde 404 e basta', async ({ page }) => {
    const risposta = await page.goto('/privacy/export/00000000-0000-4000-8000-000000000000');
    expect(risposta?.status()).toBe(404);
  });
});
