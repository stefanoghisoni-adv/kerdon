import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import type { GdprStep } from '~/lib/gdpr/customer-record.server';
import {
  eraseCustomerFromAppDatabase,
  eraseCustomerFromMerchant,
  stepsFailed,
} from '~/lib/gdpr/customer-record.server';
import { customerRef, saveGdprOutcome } from '~/lib/gdpr/audit.server';

/**
 * customers/redact — una persona ha chiesto di essere cancellata.
 *
 * Shopify lo annuncia dieci giorni dopo la richiesta, e da quel momento la
 * responsabilita' e' nostra per la parte che ci compete: togliere il
 * riferimento a quella persona da ogni tabella che lo porta, non dalla prima.
 * Quali siano quelle tabelle, e perche' gli ordini si anonimizzano invece di
 * sparire, sta scritto in lib/gdpr/customer-record.server.
 *
 * Le risposte, e il perche' di ognuna:
 *
 *   401  firma non valida — non e' Shopify che parla
 *   400  payload illeggibile o senza i campi minimi. Non e' un 500: ritentare
 *        lo stesso corpo malformato darebbe lo stesso risultato per giorni
 *   500  qualcosa non e' stato cancellato. Serve proprio che Shopify ritenti,
 *        ed e' la ragione per cui una cancellazione parziale non puo'
 *        rispondere 200: sarebbe l'app che dichiara chiusa una richiesta di
 *        cancellazione lasciando indietro dei dati
 *   200  non c'e' rimasto niente di quella persona
 */
export async function action({ request }: ActionFunctionArgs) {
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');

  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: { shop_domain?: string; customer?: { id?: string | number } };
  try {
    payload = JSON.parse(body);
  } catch {
    console.error('[gdpr] customers/redact: corpo non leggibile come JSON');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  const shopDomain = payload?.shop_domain;
  const customerId =
    payload?.customer?.id === undefined || payload?.customer?.id === null
      ? null
      : String(payload.customer.id);

  if (!shopDomain || !customerId) {
    console.error('[gdpr] customers/redact: payload senza dominio o senza id cliente');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  const ref = customerRef(shopDomain, customerId);

  try {
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { supabaseConfig: true },
    });

    if (!shop) {
      // Un negozio che non abbiamo mai avuto non ha dati di nessuno: si
      // risponde riuscito, e la traccia resta nel log applicativo perche' qui
      // non c'e' nessuna riga a cui legarla.
      await saveGdprOutcome(null, {
        jobType: 'gdpr_redact',
        shopDomain,
        ref,
        steps: [
          { table: 'shops', outcome: 'skipped', rows: 0, detail: 'negozio mai registrato' },
        ],
      });
      return json({ ok: true }, { status: 200 });
    }

    const steps: GdprStep[] = [];

    // Il database del merchant si tocca solo se c'e' un collegamento. Senza,
    // non c'e' niente da cancellare li' — ma il nostro database va ripulito lo
    // stesso, ed e' il motivo per cui questo non e' piu' un ritorno anticipato.
    if (shop.supabaseConfig) {
      const supabase = createSupabaseClient(shop.supabaseConfig);
      steps.push(
        ...(await eraseCustomerFromMerchant(
          supabase,
          shop.supabaseConfig.tableNameCustomers,
          customerId,
        )),
      );
    } else {
      steps.push({
        table: 'progetto Supabase del merchant',
        outcome: 'skipped',
        rows: 0,
        detail: 'nessun progetto collegato: non abbiamo mai scritto dati per questo negozio',
      });
    }

    steps.push(...(await eraseCustomerFromAppDatabase(shop.id, customerId, ref)));

    await saveGdprOutcome(shop.id, { jobType: 'gdpr_redact', shopDomain, ref, steps });

    if (stepsFailed(steps)) {
      return json({ error: 'Redaction incomplete' }, { status: 500 });
    }

    return json({ ok: true }, { status: 200 });
  } catch (error) {
    // Qui si finisce quando cade qualcosa che i singoli passi non sanno
    // gestire: il database irraggiungibile, la chiave del progetto non
    // decifrabile. La richiesta non e' stata eseguita e non deve sembrarlo.
    const message = error instanceof Error ? error.message : 'errore sconosciuto';
    console.error(`[gdpr] customers/redact non riuscito per ${shopDomain}:`, message);

    try {
      const shop = await prisma.shop.findUnique({ where: { shopDomain }, select: { id: true } });
      await saveGdprOutcome(shop?.id ?? null, {
        jobType: 'gdpr_redact',
        shopDomain,
        ref,
        steps: [{ table: 'richiesta', outcome: 'failed', rows: 0, detail: message }],
      });
    } catch {
      // La traccia e' gia' andata nel log applicativo: qui non resta altro.
    }

    return json({ error: 'Processing failed' }, { status: 500 });
  }
}
