import { PassThrough } from 'stream';
import { renderToPipeableStream } from 'react-dom/server';
import { RemixServer } from '@remix-run/react';
import {
  createReadableStreamFromReadable,
  type EntryContext,
} from '@remix-run/node';
import { isbot } from 'isbot';
import { addDocumentResponseHeaders } from '~/shopify.server';

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  // Inject Shopify's required document headers (CSP frame-ancestors) so the app
  // can be embedded inside the Shopify admin iframe.
  addDocumentResponseHeaders(request, responseHeaders);

  const userAgent = request.headers.get('user-agent');
  const callbackName = isbot(userAgent ?? '')
    ? 'onAllReady'
    : 'onShellReady';

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      // `abortDelay`: i dati che la pagina riceve dopo (`defer`, la tab Clienti)
      // si chiudono come FALLITI allo scadere di `streamTimeout`, prima che
      // il render qui sotto venga troncato. Senza, lo stream si tagliava con
      // la promessa ancora aperta nel browser, e lo scheletro restava a
      // girare per sempre invece di dire che la lettura non e' riuscita.
      <RemixServer context={remixContext} url={request.url} abortDelay={streamTimeout} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set('Content-Type', 'text/html');
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );

          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
