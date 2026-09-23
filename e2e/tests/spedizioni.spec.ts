// e2e/tests/spedizioni.spec.ts
//
// La pagina Spedizioni: zone, tariffe, packaging e validazioni.
//
// LIMITAZIONE DELL'AMBIENTE E2E. L'ambiente E2E corrente non supporta le rotte
// UI complete di Remix perché richiederebbero App Bridge e l'embedding
// completo nell'admin di Shopify (vedi e2e/server/main.ts righe 80-83). Questo
// file documenta gli scenari che DOVREBBERO essere testati quando l'ambiente
// lo permetterà. Per ora le prove sono skippate.
//
// COSA DOVREBBE COPRIRE. La voce di menu, lo stato vuoto, l'apertura della
// modale di modifica, il passaggio da Lineare a Fasce, la validazione delle
// fasce non contigue, e il salvataggio della card packaging. Non copre
// l'importazione delle zone se richiede l'API di Shopify: in quel caso le zone
// si seminerebbero direttamente.

import { expect } from '@playwright/test';
import { test as prova } from './support/prova';
import { azzera, db, entraComeNegozio, NEGOZIO, seminaNegozio } from './support/server';
import { dizionario } from './support/banco';

const it = dizionario.it;

prova.describe.skip('la pagina Spedizioni', () => {
  prova.beforeEach(async ({ request, context }) => {
    await azzera(request);
    await entraComeNegozio(context, NEGOZIO);
  });

  prova('la voce Spedizioni compare nel menu', async ({ request, context, page }) => {
    await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

    await page.goto('/');

    // La voce di menu porta a /spedizioni.
    const voceMenu = page.getByRole('link', { name: it.shipping.title });
    await expect(voceMenu).toBeVisible();
    await expect(voceMenu).toHaveAttribute('href', '/spedizioni');
  });

  prova('senza zone configurate mostra lo stato vuoto', async ({ request, page }) => {
    await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

    await page.goto('/spedizioni');

    await expect(page.getByText(it.shipping.empty.title)).toBeVisible();
    await expect(page.getByText(it.shipping.empty.description)).toBeVisible();
    // Il pulsante di importazione è visibile nello stato vuoto.
    await expect(page.getByRole('button', { name: it.shipping.empty.action })).toBeVisible();
  });

  prova('con zone configurate mostra la tabella', async ({ request, page }) => {
    const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

    // Semina una zona con una tariffa lineare.
    await db(request, 'shippingZone', 'create', {
      data: {
        shopId: shop.id,
        zoneName: 'Europa',
        countries: ['IT', 'FR', 'DE'],
        restOfWorld: false,
        rateType: 'linear',
        rates: {
          create: {
            weightFrom: null,
            weightTo: null,
            cost: 2.5,
          },
        },
      },
    });

    await page.goto('/spedizioni');

    // La tabella è visibile con le intestazioni corrette.
    await expect(page.getByRole('columnheader', { name: it.shipping.table.zone })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: it.shipping.table.countries })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: it.shipping.table.rateType })).toBeVisible();

    // La zona seminata compare nella tabella.
    await expect(page.getByRole('cell', { name: 'Europa' })).toBeVisible();
    await expect(page.getByText('IT, FR, DE')).toBeVisible();
    await expect(page.getByText(it.shipping.rateTypes.linear)).toBeVisible();
  });

  prova('apre la modale di modifica e passa da Lineare a Fasce', async ({ request, page }) => {
    const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

    await db(request, 'shippingZone', 'create', {
      data: {
        shopId: shop.id,
        zoneName: 'Italia',
        countries: ['IT'],
        restOfWorld: false,
        rateType: 'linear',
        rates: {
          create: {
            weightFrom: null,
            weightTo: null,
            cost: 3.0,
          },
        },
      },
    });

    await page.goto('/spedizioni');

    // Apre la modale cliccando su Modifica.
    await page.getByRole('button', { name: it.shipping.table.edit }).click();

    // La modale si apre con il titolo corretto.
    await expect(page.getByText(it.shipping.modal.title('Italia'))).toBeVisible();

    // Il tipo di tariffa è inizialmente Lineare.
    const linearRadio = page.getByLabel(it.shipping.modal.linearLabel);
    await expect(linearRadio).toBeChecked();

    // Passa a Fasce peso.
    const bracketsRadio = page.getByLabel(it.shipping.modal.bracketsLabel);
    await bracketsRadio.click();

    // La sezione fasce diventa visibile.
    await expect(page.getByText(it.shipping.modal.bracketsHelp)).toBeVisible();
    await expect(page.getByRole('button', { name: it.shipping.modal.addBracket })).toBeVisible();
  });

  prova('mostra errore di validazione con fasce non contigue', async ({ request, page }) => {
    const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

    await db(request, 'shippingZone', 'create', {
      data: {
        shopId: shop.id,
        zoneName: 'Francia',
        countries: ['FR'],
        restOfWorld: false,
        rateType: 'brackets',
        rates: {
          create: [
            { weightFrom: 0, weightTo: 5, cost: 10 },
            { weightFrom: 5, weightTo: 10, cost: 15 },
          ],
        },
      },
    });

    await page.goto('/spedizioni');
    await page.getByRole('button', { name: it.shipping.table.edit }).click();

    // La modale si apre in modalità Fasce.
    await expect(page.getByLabel(it.shipping.modal.bracketsLabel)).toBeChecked();

    // Modifica la seconda fascia per creare un buco (5-10 → 7-10).
    const secondBracketFrom = page.locator('[data-testid="bracket-1-from"]');
    await secondBracketFrom.fill('7');

    // Tenta di salvare.
    await page.getByRole('button', { name: it.shipping.modal.save }).click();

    // L'errore di validazione è visibile: le fasce hanno buchi.
    await expect(page.getByText(it.shipping.errors.bracketsHaveGaps)).toBeVisible();
  });

  prova('salva la card packaging con successo', async ({ request, page }) => {
    await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

    await page.goto('/spedizioni');

    // La card packaging è visibile.
    await expect(page.getByText(it.shipping.packaging.title)).toBeVisible();

    // Compila il peso di default per articolo.
    const defaultWeightInput = page.getByLabel(it.shipping.packaging.defaultWeightLabel);
    await defaultWeightInput.fill('0.5');

    // Compila il costo di rientro.
    const returnCostInput = page.getByLabel(it.shipping.packaging.returnCostLabel);
    await returnCostInput.fill('5.00');

    // Salva la configurazione.
    await page.getByRole('button', { name: it.shipping.packaging.save }).click();

    // Il toast di successo è visibile.
    await expect(page.getByText(it.shipping.packaging.saveSuccess)).toBeVisible();
  });

  prova('aggiunge una categoria di packaging', async ({ request, page }) => {
    await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

    await page.goto('/spedizioni');

    // Aggiunge una categoria.
    await page.getByRole('button', { name: it.shipping.packaging.addCategory }).click();

    // I campi della categoria sono visibili.
    const categoryNameInput = page.locator('[data-testid="category-0-name"]');
    await categoryNameInput.fill('Busta');

    const categoryCostInput = page.locator('[data-testid="category-0-cost"]');
    await categoryCostInput.fill('1.50');

    // Salva.
    await page.getByRole('button', { name: it.shipping.packaging.save }).click();

    // Il toast di successo è visibile.
    await expect(page.getByText(it.shipping.packaging.saveSuccess)).toBeVisible();
  });
});
