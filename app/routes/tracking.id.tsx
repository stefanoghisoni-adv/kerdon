import type { LoaderFunctionArgs } from '@remix-run/node';
import {
  EXTERNAL_ID_HEADER,
  externalIdCookie,
  newExternalId,
  readExternalId,
} from '~/lib/tracking/external-id';
import { extractReadProxyToken } from '~/lib/read-proxy/token.server';
import { resolveShopReadContext } from '~/lib/read-proxy/context.server';

/**
 * L'identificativo del browser, restituito NEL CORPO.
 *
 * Esiste perche' l'header non basta, e non per un limite nostro: i template
 * pronti dei container server-side — quelli che si installano dalla galleria e
 * si configurano senza scrivere codice — restituiscono il CORPO della risposta
 * come valore della variabile, e i suoi header non li espongono. Un container
 * che sappia leggere gli header c'e', ma serve un template scritto a mano, ed e'
 * un prezzo che non ha senso far pagare per un dato che possiamo semplicemente
 * scrivere dove tutti sanno leggerlo.
 *
 * Il proxy di lettura continua a mandare `X-CoreW-External-Id` su ogni risposta:
 * quella strada resta valida per chi puo' percorrerla, e non costa niente
 * tenerla. Questa e' quella che funziona con gli strumenti che i merchant hanno
 * davvero in mano.
 *
 * NON e' una ricerca. Non interroga nessuna tabella e non guarda i clienti:
 * risponde alla sola domanda "come si chiama questo browser", che e' l'unica a
 * cui si possa rispondere prima di sapere chi sia la persona.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  // Stesso pedaggio del proxy: il token dice di quale negozio si parla. Senza,
  // chiunque potrebbe farsi coniare identificativi sulla nostra infrastruttura.
  const token = extractReadProxyToken(request);
  const result = token ? await resolveShopReadContext(token) : { kind: 'unknown' as const };

  if (result.kind !== 'ok') {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Si riusa quello che il browser ha gia', se ce l'ha. Coniarne uno nuovo a
  // ogni pagina vorrebbe dire non riconoscere piu' nessuno, che e' l'opposto di
  // cio' per cui esiste.
  const existing = readExternalId(request.headers.get('Cookie'));
  const externalId = existing ?? newExternalId();

  const headers = new Headers({
    'Content-Type': 'application/json',
    [EXTERNAL_ID_HEADER]: externalId,
    'Access-Control-Expose-Headers': EXTERNAL_ID_HEADER,
    // Un identificativo si conia una volta e vale per sempre: farlo mettere in
    // cache vorrebbe dire darne lo stesso a due browser diversi.
    'Cache-Control': 'no-store',
  });
  if (!existing) headers.append('Set-Cookie', externalIdCookie(externalId));

  return new Response(JSON.stringify({ external_id: externalId }), { status: 200, headers });
}
