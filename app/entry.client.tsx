import { RemixBrowser } from '@remix-run/react';
import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';

/**
 * Quando il browser chiede un file che una distribuzione fa non esiste piu'.
 *
 * Ogni distribuzione rinomina i file JavaScript con un hash nuovo. Una scheda
 * rimasta aperta continua a chiedere i nomi vecchi, che dal momento del rilascio
 * non esistono: il modulo della pagina non si carica, la pagina resta senza il
 * suo codice, e da li' in poi si comporta in modi che non somigliano a un
 * guasto — un pulsante che porta a una risposta grezza invece che a una
 * schermata, una tendina che non si apre. Chi guarda non ha modo di collegare
 * quello che vede a un rilascio avvenuto mezz'ora prima.
 *
 * Vite annuncia esattamente questo caso con `vite:preloadError`. Ricaricare e'
 * la cura giusta: il documento nuovo arriva con i nomi nuovi e tutto riparte.
 *
 * UNA VOLTA SOLA, e serve. Se il file manca per un motivo diverso — la rete del
 * visitatore, un blocco, un guasto vero — ricaricare non lo farebbe comparire, e
 * senza questo freno la pagina si ricaricherebbe all'infinito. Il segno resta
 * nella sessione della scheda: dopo un ricaricamento riuscito la scheda ha i
 * nomi nuovi e non ripassa piu' di qui.
 *
 * Perche' non l'impostazione di Vercel che fa la stessa cosa: e' a pagamento.
 * Questa copre il caso che ci riguarda — chi ha l'app aperta mentre si rilascia
 * — senza coprirne altri che quella coprirebbe.
 */
const RICARICATA = 'kerdon:ricaricata-dopo-rilascio';

window.addEventListener('vite:preloadError', (event) => {
  let gia = false;
  try {
    gia = sessionStorage.getItem(RICARICATA) === '1';
    if (!gia) sessionStorage.setItem(RICARICATA, '1');
  } catch {
    // Una scheda che non concede la memoria di sessione (navigazione privata,
    // cookie di terze parti bloccati dentro l'iframe dell'admin) non deve
    // restare senza la cura: si ricarica lo stesso, e il rischio di un secondo
    // giro e' preferibile a una pagina che non funziona.
  }

  if (gia) return;

  event.preventDefault();
  window.location.reload();
});

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <RemixBrowser />
    </StrictMode>,
  );
});
