import type { LoaderFunctionArgs } from '@remix-run/node';
import { linguaDellaPagina, paginaInformativa } from '~/lib/legal/privacy-policy';

/**
 * L'informativa sulla privacy, a un indirizzo pubblico e stabile.
 *
 * PERCHE' `/privacy-policy` E NON `/privacy`. Perche' in Remix il punto nel
 * nome del file crea una gerarchia: accanto a `privacy.export.$id.tsx` e
 * `privacy.my-data.tsx`, un file `privacy.tsx` non sarebbe una pagina — sarebbe
 * il LAYOUT di quelle due. Diventerebbero rotte figlie di un modulo con un
 * proprio loader, che verrebbe eseguito a ogni loro richiesta, e le due cose
 * che quelle rotte fanno — consegnare un file JSON con un `Content-Disposition`
 * addosso, e farlo solo a chi ha la sessione giusta — passerebbero attraverso
 * un genitore che non le conosce. Sono le due vie d'uscita con cui un merchant
 * si porta via i propri dati: non si mettono a rischio per un indirizzo piu'
 * corto. `privacy-policy` non ha punti, quindi non tocca niente, e per giunta
 * si chiama come il file da cui nasce.
 *
 * PERCHE' NON C'E' NESSUN COMPONENTE, SOLO UN `loader`. Perche' una pagina
 * normale di questa app passa dal `loader` di `root.tsx`, che autentica
 * l'amministratore e, se non c'e' una sessione, rimanda a Shopify. Un'informativa
 * sulla privacy che per essere letta chiede di installare un'app e accedere a un
 * negozio non e' un'informativa: e' un documento riservato ai clienti, che e'
 * l'opposto del suo scopo. Servendo una `Response` da una rotta-risorsa —
 * come fanno gia' `tracking.bridge[.]js` e `[robots.txt]` — il guscio dell'app
 * non entra in gioco e la pagina risponde a chiunque, revisore Shopify
 * compreso.
 *
 * Non c'e' `action`: da qui non si scrive niente.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const { locale } = linguaDellaPagina(
    url.searchParams.get('lang'),
    request.headers.get('accept-language'),
  );

  return new Response(paginaInformativa(locale), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Dieci minuti ai browser, un giorno agli intermediari: il documento
      // cambia raramente, ma quando cambia e' perche' e' cambiato un
      // trattamento — e una versione vecchia servita per un giorno intero
      // racconterebbe una cosa non piu' vera.
      'Cache-Control': 'public, max-age=600, s-maxage=86400, stale-while-revalidate=86400',
      // OBBLIGATORIO, e non per completezza: senza la lingua scelta
      // dall'intestazione, la prima copia finita in una cache condivisa
      // verrebbe servita a tutti — l'italiano al revisore Shopify, o
      // l'inglese al merchant italiano.
      Vary: 'Accept-Language',
      'X-Content-Type-Options': 'nosniff',
      // La pagina non ha script, non ha immagini e non chiama nessuno: lo si
      // dichiara, cosi' se un giorno qualcuno ce ne mettesse uno se ne
      // accorgerebbe il browser prima di un revisore.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      'Referrer-Policy': 'no-referrer',
    },
  });
}
