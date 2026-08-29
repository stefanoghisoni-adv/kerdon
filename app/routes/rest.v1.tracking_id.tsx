import type { LoaderFunctionArgs } from '@remix-run/node';
import {
  EXTERNAL_ID_HEADER,
  externalIdCookie,
  newExternalId,
  readExternalId,
} from '~/lib/tracking/external-id';
import { extractReadProxyToken } from '~/lib/read-proxy/token.server';
import {
  resolveShopReadContext,
  type ShopReadContext,
} from '~/lib/read-proxy/context.server';
import { recordUserSeen, supabaseFromReadContext } from '~/lib/tracking/users.server';
import { postgrestFilterValue } from '~/lib/tracking/users';
import { provisionUsersTable } from '~/lib/supabase/ensure-users-table.server';

/**
 * L'identificativo del browser, come se fosse una tabella.
 *
 * VIVE SOTTO `/rest/v1/` E NON ALTROVE, e non e' una scelta di stile. Il
 * merchant legge questo valore con il template "Supabase Lookup" del suo
 * container server-side, e quel template compone l'indirizzo da se':
 * `{projectUrl}/rest/v1/{tableName}?{chiave}={valore}`. Non c'e' un campo dove
 * scrivere un percorso diverso, e il codice del template non e' modificabile.
 * Una rotta fuori da quel percorso, per chi usa quel template, semplicemente
 * non esiste.
 *
 * Quindi `tracking_id` e' una pseudo-tabella: non e' una tabella e non ce n'e'
 * una con quel nome nel database di nessuno, ma dall'esterno si comporta come
 * tale.
 *
 * LA RISPOSTA E' UN ARRAY, per la stessa ragione. Il Lookup fa `JSON.parse` del
 * corpo e poi scende dentro con un percorso a punti, esattamente come si fa su
 * una risposta di PostgREST: con `0.external_id` il merchant arriva al valore
 * solo se il primo livello e' un array di oggetti. Un oggetto solo lo
 * costringerebbe a un percorso diverso — cioe' a sapere che questa non e' una
 * tabella vera, che e' proprio cio' che gli stiamo risparmiando.
 *
 * L'header `X-CoreW-External-Id` resta su ogni risposta, qui e sul proxy: chi
 * ha un container che sa leggere gli header continua a poterlo fare, e non
 * costa niente tenerlo.
 *
 * NON e' una ricerca. Non interroga nessuna tabella e non guarda i clienti:
 * risponde alla sola domanda "come si chiama questo browser", che e' l'unica a
 * cui si possa rispondere prima di sapere chi sia la persona. La querystring
 * che il template attacca comunque non seleziona niente — non c'e' niente da
 * selezionare — e viene guardata solo per le due etichette facoltative.
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

  // Il negozio puo' ancora leggere?
  //
  // Qui questo controllo non c'era, ed era l'unica rotta di /rest/v1/ a non
  // averlo: le altre tre lo fanno tutte. Un token valido bastava, e un negozio
  // con il tracciamento sospeso — o che aveva disinstallato l'app — continuava
  // a farsi coniare identificativi. Peggio: questa rotta e' anche l'unica che
  // SCRIVE nel database del merchant, una riga per ogni browser che passa,
  // quindi la sospensione lasciava crescere la tabella dei visitatori proprio
  // mentre tutto il resto era fermo.
  //
  // 403 come sulle altre: per un container server-side e' "nessun dato", e la
  // vetrina prosegue senza che nessuno veda un errore.
  if (!result.ctx.canReadData) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Si riusa quello che il browser ha gia', se ce l'ha. Coniarne uno nuovo a
  // ogni pagina vorrebbe dire non riconoscere piu' nessuno, che e' l'opposto di
  // cio' per cui esiste.
  const existing = readExternalId(request.headers.get('Cookie'));
  const externalId = existing ?? newExternalId();

  // Qui il browser diventa una riga.
  //
  // E' l'unico posto dove puo' succedere: gli altri momenti — l'ordine,
  // l'identificazione — legano un browser a una persona, ma per legarlo bisogna
  // che qualcuno lo abbia visto passare almeno una volta, e chi passa senza mai
  // rivelarsi non lo lega nessuno. Se la riga nascesse solo al legame, la
  // tabella conterrebbe solo clienti: la prima comparsa di ognuno andrebbe
  // persa, e la potatura non avrebbe niente da potare perche' non esisterebbero
  // righe anonime.
  //
  // Una scrittura per chiamata e' il prezzo, e si paga qui e non sul proxy di
  // lettura: questa e' la rotta dell'identita', chiamata una volta per sessione
  // dal container, mentre il proxy lo chiamano i tag a ogni ricerca. Scrivere
  // in tutti e due i posti vorrebbe dire pagare piu' volte la stessa
  // informazione.
  //
  // Attesa e non lasciata in volo: su una funzione serverless una promise non
  // attesa muore con l'istanza. Best effort dentro: qualunque cosa vada storta,
  // l'identificativo si restituisce lo stesso — la vetrina sta aspettando.
  await recordVisitor(result.ctx, externalId, request);

  const headers = new Headers({
    'Content-Type': 'application/json',
    [EXTERNAL_ID_HEADER]: externalId,
    'Access-Control-Expose-Headers': EXTERNAL_ID_HEADER,
    // Un identificativo si conia una volta e vale per sempre: farlo mettere in
    // cache vorrebbe dire darne lo stesso a due browser diversi.
    'Cache-Control': 'no-store',
  });
  if (!existing) headers.append('Set-Cookie', externalIdCookie(externalId));

  // L'array, non l'oggetto: vedi sopra. Una riga sola, che e' la risposta alla
  // domanda posta.
  return new Response(JSON.stringify([{ external_id: externalId }]), { status: 200, headers });
}

/**
 * Scrive la comparsa del browser nel database del merchant.
 *
 * `browser` e `device_type` arrivano dalla querystring, cioe' da quello che il
 * merchant ha scritto nella condizione del Lookup: se non li manda restano
 * vuoti, e va benissimo — la strada buona per quelle due etichette e' il tag
 * Writer su `/rest/v1/users`, che manda un oggetto intero e non una coppia
 * sola.
 * Non si ricavano dallo user agent apposta — il dispositivo li' e' una
 * supposizione (iPadOS si dichiara Macintosh) e una supposizione scritta da noi
 * sembrerebbe un dato accertato. Meglio una colonna vuota di una piena e
 * sbagliata.
 */
async function recordVisitor(
  ctx: ShopReadContext,
  externalId: string,
  request: Request,
): Promise<void> {
  try {
    const params = new URL(request.url).searchParams;
    const supabase = supabaseFromReadContext(ctx);
    await recordUserSeen(
      supabase,
      {
        externalId,
        // `postgrestFilterValue` perche' il valore lo scrive il merchant dentro
        // un template che crede di parlare con PostgREST: quello che arriva e'
        // `eq.Safari`, non `Safari`.
        browser: postgrestFilterValue(params.get('browser')),
        deviceType: postgrestFilterValue(params.get('device_type')),
      },
      () => provisionUsersTable(ctx.shopId, supabase),
    );
  } catch (error) {
    console.warn(
      '[rest/v1/tracking_id] browser non registrato:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
  }
}
