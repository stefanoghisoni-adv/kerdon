// Il giro dell'addebito esce dall'iframe: il merchant conferma sulla pagina di
// Shopify e torna sulla FINESTRA DI PRIMO LIVELLO. Una rotta dell'app raggiunta
// cosi' non ha nessun token di sessione addosso, e senza i parametri giusti in
// coda all'URL non riesce piu' a rientrare dentro l'admin: finisce sulla pagina
// che chiede il dominio del negozio, dopo che il merchant ha appena pagato.
//
// Qui si costruisce quella coda una volta sola, cosi' l'URL di ritorno passato a
// Shopify e il rimando finale alla tab Piano non possono divergere.

import { storeHandle } from '~/utils/admin-page';

/**
 * Ricostruisce il parametro `host` a partire dal solo dominio del negozio.
 *
 * L'azione che avvia l'acquisto e' una POST del riquadro embedded: il `host`
 * originale c'e' quasi sempre, ma non e' garantito. Perderlo significherebbe
 * mandare il merchant al modulo di login al ritorno dal pagamento, quindi lo
 * ricalcoliamo nella stessa forma che usa l'admin (base64 di
 * `admin.shopify.com/store/<negozio>`).
 */
export function fallbackHost(shopDomain: string): string {
  return Buffer.from(
    `admin.shopify.com/store/${storeHandle(shopDomain)}`,
    'utf8',
  ).toString('base64');
}

export interface EmbeddedContextOptions {
  /** URL della richiesta in corso: prima fonte di `host`. */
  requestUrl?: URL | null;
  /** Dominio myshopify del negozio. */
  shopDomain: string;
  /** `host` fornito dal client (campo del form), usato se manca nell'URL. */
  host?: string | null;
}

/**
 * Parametri che permettono a una rotta dell'app di rientrare nell'admin.
 *
 * `embedded=1` non e' decorativo: senza, una richiesta di primo livello viene
 * dirottata sulla home dell'app dentro l'admin e il percorso richiesto — con
 * l'esito dell'addebito — si perde per strada.
 */
export function embeddedContextParams(opts: EmbeddedContextOptions): URLSearchParams {
  const fromUrl = opts.requestUrl?.searchParams.get('host')?.trim();
  const fromForm = opts.host?.trim();
  const host = fromUrl || fromForm || fallbackHost(opts.shopDomain);

  const params = new URLSearchParams();
  params.set('shop', opts.shopDomain);
  params.set('host', host);
  params.set('embedded', '1');
  return params;
}

export interface AdminAppUrlOptions {
  shopDomain: string;
  /** Percorso dentro l'app, con lo slash iniziale. Vuoto = la home dell'app. */
  path?: string;
  /** Parametri da consegnare alla pagina dell'app. */
  params?: URLSearchParams;
}

/**
 * L'indirizzo dell'app DENTRO l'admin di Shopify.
 *
 * Al ritorno dal pagamento il browser e' di primo livello, fuori dal riquadro.
 * Rimandarlo a un indirizzo dell'app significa chiedergli di rientrare da solo:
 * la libreria risponde con una paginetta che chiede il token di sessione e poi
 * ricarica, e quando quel giro si inceppa il merchant resta davanti a una
 * pagina bianca — con il piano appena pagato e nessun modo di proseguire.
 *
 * Questo indirizzo salta il giro: e' l'admin ad aprirsi, ed e' lui a caricare
 * l'app nel riquadro con la sessione gia' buona. E' la strada che Shopify
 * indica per rientrare da una pagina esterna.
 *
 * `null` se manca la chiave dell'app: senza non si puo' comporre, e chi chiama
 * ha una via di ripiego.
 */
export function adminAppUrl(opts: AdminAppUrlOptions): string | null {
  const apiKey = process.env.SHOPIFY_API_KEY?.trim();
  if (!apiKey) return null;

  const path = opts.path?.trim() ?? '';
  const query = opts.params?.toString();
  return (
    `https://admin.shopify.com/store/${storeHandle(opts.shopDomain)}/apps/${apiKey}` +
    `${path}${query ? `?${query}` : ''}`
  );
}
