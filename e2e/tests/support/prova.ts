// e2e/tests/support/prova.ts
//
// Il `test` che tutte le prove devono importare, invece di quello di Playwright.
//
// PERCHE' ESISTE. Una prova end-to-end guida un browser vero, e un browser vero
// chiede quello che gli si dice di chiedere. Durante la scrittura di queste
// prove e' successo: la callback dell'addebito rimanda su
// `https://admin.shopify.com/...`, il browser ci e' andato DAVVERO, e Shopify
// ha risposto con la sua pagina di accesso. Nessun danno quella volta — ma e'
// esattamente la strada da cui una prova comincia a parlare con un servizio
// vero, e non e' una cosa da lasciare al fatto che ci si ricordi di
// intercettare l'indirizzo giusto in ogni singolo file.
//
// COME SI CHIUDE LA RETE, e perche' non basta una regola sola.
//
//  1. Tutto cio' che non e' 127.0.0.1 viene interrotto e annotato negli
//     allegati della prova. E' la rete di sicurezza.
//
//  2. Ma da sola NON BASTA, ed e' il pezzo che si scopre solo provandolo:
//     quando una risposta rimanda altrove, il browser segue la catena e
//     Playwright intercetta SOLO L'ULTIMA richiesta. Il primo salto —
//     esattamente quello verso l'admin — passa sotto. Per questo il ritorno
//     dell'addebito si intercetta PRIMA che il rimando esista: si chiede la
//     rotta senza seguire i rimandi, si legge dove voleva mandare, e si
//     riscrive la destinazione su una pagina locale che quella destinazione la
//     mostra. Il rimando di primo livello avviene per davvero, il browser lo
//     segue per davvero, e non esce un pacchetto.

import { test as base, expect } from '@playwright/test';

/** La pagina che sta al posto dell'admin di Shopify. */
export const ADMIN_FINTO = '[data-testid="admin-finto"]';
/** Dove l'app voleva mandare davvero, scritto nella pagina. */
export const ADMIN_FINTO_DESTINAZIONE = '[data-testid="admin-finto-destinazione"]';

function eLocale(indirizzo: URL): boolean {
  return indirizzo.hostname === '127.0.0.1' || indirizzo.hostname === 'localhost';
}

export const test = base.extend<{ reteChiusa: void }>({
  reteChiusa: [
    async ({ context }, use, testInfo) => {
      // La rete di sicurezza, registrata per prima: le regole piu' specifiche
      // registrate dopo hanno la precedenza.
      await context.route(
        (indirizzo) => !eLocale(indirizzo),
        async (route) => {
          await testInfo.attach('richiesta-verso-l-esterno-bloccata', {
            body: route.request().url(),
          });
          await route.abort('blockedbyclient');
        },
      );

      // Il ritorno dall'approvazione dell'addebito: si guarda dove rimanda
      // senza seguirlo, e se punta all'admin lo si riscrive su una pagina
      // locale. Tutto il resto della risposta passa intatto.
      await context.route('**/billing/callback*', async (route) => {
        const risposta = await route.fetch({ maxRedirects: 0 });
        const destinazione = risposta.headers()['location'] ?? '';

        if (destinazione.startsWith('https://admin.shopify.com')) {
          const locale = `/__test/admin-finto?destinazione=${encodeURIComponent(destinazione)}`;
          // Una pagina che rimanda, e non una risposta 302.
          //
          // WebKit rifiuta `route.fulfill` con uno stato di rimando — «Cannot
          // fulfill with redirect status: 302» — e la prova falliva sul solo
          // WebKit della matrice notturna. Con il rimando scritto nella pagina
          // il browser fa comunque una navigazione di primo livello, uguale in
          // tutti e tre i motori, e cio' che conta resta intatto: l'indirizzo
          // che l'app aveva scritto arriva alla pagina di arrivo e li' si
          // verifica.
          return route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${locale.replace(/&/g, '&amp;')}">`,
          });
        }

        return route.fulfill({ response: risposta });
      });

      await use();
    },
    { auto: true },
  ],
});

export { expect };
