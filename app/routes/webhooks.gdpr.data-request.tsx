import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import type { CustomerDataPackage } from '~/lib/gdpr/customer-record.server';
import { collectCustomerData, stepsFailed } from '~/lib/gdpr/customer-record.server';
import { customerRef, saveGdprOutcome } from '~/lib/gdpr/audit.server';

/**
 * customers/data_request — una persona vuole sapere cosa sappiamo di lei.
 *
 * L'errore da non fare e' rispondere con la sola riga della tabella clienti.
 * Il diritto di accesso non riguarda la tabella che porta il nome "clienti":
 * riguarda tutto quello che e' riconducibile a quella persona, e per questa app
 * vuol dire anche i suoi ordini e le righe di quegli ordini — cosa ha comprato,
 * quando, a che prezzo. Sono le stesse tabelle che la cancellazione deve
 * svuotare, e non e' una coincidenza: se una tabella conta per l'una deve
 * contare per l'altra, altrimenti una delle due sta mentendo.
 *
 * L'esportazione torna nel corpo della risposta. Va a Shopify, sul canale
 * firmato da cui la richiesta e' arrivata, e contiene esclusivamente dati che
 * a Shopify sono arrivati per primi — sono i suoi, ce li ha dati lei. Non c'e'
 * niente che esca da dove gia' era, e il vantaggio e' che la consegna diventa
 * una cosa sola con la richiesta invece di un'operazione a mano che qualcuno
 * deve ricordarsi di fare entro trenta giorni.
 *
 * Nella traccia di controllo finiscono i conteggi e nient'altro: un registro
 * delle richieste di accesso che conserva i dati acceduti sarebbe una seconda
 * copia degli stessi dati personali, creata dallo strumento che dovrebbe
 * proteggerli.
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
    console.error('[gdpr] data_request: corpo non leggibile come JSON');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  const shopDomain = payload?.shop_domain;
  const customerId =
    payload?.customer?.id === undefined || payload?.customer?.id === null
      ? null
      : String(payload.customer.id);

  if (!shopDomain || !customerId) {
    console.error('[gdpr] data_request: payload senza dominio o senza id cliente');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  const ref = customerRef(shopDomain, customerId);
  const empty: CustomerDataPackage = { customer: null, orders: [], order_lines: [] };

  try {
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { supabaseConfig: true },
    });

    // Nessun negozio, o nessun progetto collegato: non abbiamo mai avuto dove
    // scrivere, quindi non c'e' niente da consegnare. Non e' un errore, ed e'
    // una risposta piena — "di questa persona non teniamo nulla" e' esattamente
    // cio' che il diritto di accesso chiede quando e' vero.
    if (!shop?.supabaseConfig) {
      await saveGdprOutcome(shop?.id ?? null, {
        jobType: 'gdpr_data_request',
        shopDomain,
        ref,
        steps: [
          {
            table: 'progetto Supabase del merchant',
            outcome: 'skipped',
            rows: 0,
            detail: 'nessun progetto collegato: nessun dato conservato per questo negozio',
          },
        ],
      });
      return json({ ok: true, data: empty }, { status: 200 });
    }

    const supabase = createSupabaseClient(shop.supabaseConfig);
    const { data, steps } = await collectCustomerData(
      supabase,
      shop.supabaseConfig.tableNameCustomers,
      customerId,
    );

    await saveGdprOutcome(shop.id, { jobType: 'gdpr_data_request', shopDomain, ref, steps });

    // Una tabella che non ha risposto vuol dire un'esportazione incompleta, e
    // un'esportazione incompleta consegnata come completa e' peggio di una
    // ritentata: chi legge crederebbe che il resto non esiste.
    if (stepsFailed(steps)) {
      return json({ error: 'Data collection incomplete' }, { status: 500 });
    }

    return json({ ok: true, data }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'errore sconosciuto';
    console.error(`[gdpr] data_request non riuscita per ${shopDomain}:`, message);

    try {
      const shop = await prisma.shop.findUnique({ where: { shopDomain }, select: { id: true } });
      await saveGdprOutcome(shop?.id ?? null, {
        jobType: 'gdpr_data_request',
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
