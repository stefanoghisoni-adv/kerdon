import { consentBridgeScript } from '~/lib/tracking/consent-bridge';

/**
 * Il ponte in vetrina, servito come file.
 *
 * PERCHE' UNA ROTTA PUBBLICA E SENZA AUTENTICAZIONE. Questo file lo carica il
 * browser di chi sta guardando un negozio: non c'e' nessuna sessione da
 * verificare e non c'e' niente da proteggere — dentro non ci sono credenziali,
 * non c'e' il nome di nessun negozio e non c'e' nessun dato. E' lo stesso corpo
 * per tutti, e cio' che lo rende specifico di un negozio e' l'attributo sul tag
 * `<script>` che lo include, che sta nel tema del merchant e non qui.
 *
 * PROPRIO PERCHE' E' UGUALE PER TUTTI si puo' mettere in cache a lungo: e' il
 * primo script che parte su ogni pagina di ogni negozio che ci usa, e farlo
 * scaricare ogni volta sarebbe un ritardo pagato da chi naviga per un file che
 * non e' cambiato.
 *
 * Non c'e' `action`: da qui non si scrive niente.
 */
export async function loader() {
  return new Response(consentBridgeScript(), {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Un'ora ai browser, un giorno agli intermediari con il permesso di
      // servire il vecchio mentre lo rinnovano: un aggiornamento del ponte non
      // deve poter fermare la vetrina di nessuno mentre si propaga.
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
      // Il file lo include il tema del merchant, da un dominio diverso dal
      // nostro: senza, il browser lo scarta prima di eseguirlo.
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
