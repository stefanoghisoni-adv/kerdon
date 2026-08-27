import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { stepsFailed } from '~/lib/gdpr/customer-record.server';
import { eraseShopRecord } from '~/lib/gdpr/shop-record.server';
import { saveGdprOutcome } from '~/lib/gdpr/audit.server';

/**
 * shop/redact — il negozio ha disinstallato e sono passate quarantotto ore.
 *
 * Da qui in poi di quel negozio non dobbiamo tenere piu' niente. "Niente" e'
 * una parola precisa: non solo la riga del negozio, ma anche le sessioni, che
 * al negozio non sono legate da nessun vincolo e quindi non se ne vanno in
 * cascata — e dentro hanno l'access token e il nome, il cognome e l'email di
 * chi ha installato l'app. L'inventario completo, e cosa resta al merchant,
 * stanno in lib/gdpr/shop-record.server.
 *
 * La traccia di controllo, per questa richiesta sola, vive nel log applicativo
 * e non nel database: qualunque riga legata al negozio sparisce insieme al
 * negozio, e una prova che si autodistrugge insieme a cio' che deve provare non
 * prova niente. Nel database ci finisce solo il caso opposto — la cancellazione
 * fallita, dove il negozio c'e' ancora e la riga regge.
 */
export async function action({ request }: ActionFunctionArgs) {
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');

  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: { shop_domain?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    console.error('[gdpr] shop/redact: corpo non leggibile come JSON');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  const shopDomain = payload?.shop_domain;
  if (!shopDomain) {
    console.error('[gdpr] shop/redact: payload senza dominio del negozio');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  try {
    const { shopId, steps } = await eraseShopRecord(shopDomain);
    const failed = stepsFailed(steps);

    // La riga di controllo si scrive solo se il negozio e' sopravvissuto alla
    // richiesta, cioe' solo quando qualcosa e' andato storto: dopo una
    // cancellazione riuscita non c'e' piu' nessuna riga a cui agganciarla, e
    // ricrearla sarebbe rimettere nel database il negozio appena tolto.
    await saveGdprOutcome(failed ? shopId : null, {
      jobType: 'gdpr_shop_redact',
      shopDomain,
      steps,
    });

    if (failed) {
      return json({ error: 'Redaction incomplete' }, { status: 500 });
    }

    return json({ ok: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'errore sconosciuto';
    console.error(`[gdpr] shop/redact non riuscito per ${shopDomain}:`, message);

    await saveGdprOutcome(null, {
      jobType: 'gdpr_shop_redact',
      shopDomain,
      steps: [{ table: 'richiesta', outcome: 'failed', rows: 0, detail: message }],
    });

    return json({ error: 'Redaction failed' }, { status: 500 });
  }
}
