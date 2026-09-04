import { dictionaryForShop } from '~/lib/i18n/server';
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { encrypt } from '~/utils/crypto.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import {
  getProjectApiKeys,
  listProjects,
  runQuery,
  runQueryRows,
  projectUrl,
} from '~/lib/supabase-management.server';
import { buildMerchantSchemaSQL } from '~/lib/supabase-schema';
import { hasOrdersAccess } from '~/lib/sync/orders-access';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import { issueReadProxyToken } from '~/lib/read-proxy/token.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import {
  detectCreatedTables,
  tableCreationJobType,
} from '~/lib/supabase/detect-created-tables';
import { RELOAD_SCHEMA_SQL } from '~/lib/supabase/ensure-table.server';
import { quoteLiteral } from '~/lib/supabase/identifiers';
import {
  recordProvisionedResources,
  tablesToProbe,
} from '~/lib/supabase/managed-resources.server';
import { LATEST_SCHEMA_VERSION } from '~/lib/supabase/merchant-migrations';
import { enqueueManualSync, triggerSyncDrain } from '~/lib/queue/trigger.server';

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return json({ ok: false, error: 'Shop non trovato' }, { status: 404 });
  }

  // Tabelle da garantire in base al piano: products sempre, customers solo se
  // la sincronizzazione clienti è inclusa.
  const plan = await findPlanByName(shop.currentPlan);
  const includeCustomers = plan?.customersSyncEnabled ?? false;
  if (!can(await shopCapabilities(shop), 'use_app')) {
    return json(
      {
        ok: false,
        error: (await dictionaryForShop(session.shop)).errors.suspended,
        code: 'not_authorized',
      },
      { status: 403 },
    );
  }

  const body = (await request.json()) as { ref?: unknown };
  if (!body.ref || typeof body.ref !== 'string') {
    return json({ ok: false, error: 'ref del progetto mancante' }, { status: 400 });
  }
  const ref = body.ref;

  try {
    const token = await getValidAccessToken(shop.id);
    const keys = await getProjectApiKeys(token, ref);
    const url = projectUrl(ref);

    // Il nome che il merchant ha dato al progetto: il ref e' una sigla, e in
    // Impostazioni e' il nome a dirgli quale database sia. Best effort — se
    // l'elenco non arriva si collega lo stesso, con la sola sigla.
    const projectName =
      (await listProjects(token).catch(() => []))
        .find((p) => p.id === ref)?.name ?? null;

    await prisma.supabaseConfig.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        supabaseUrl: url,
        supabasePublicKey: encrypt(keys.anon),
        supabaseServiceRoleKey: encrypt(keys.serviceRole),
        // Il ref è la sola fonte dell'host di inoltro del proxy di lettura:
        // senza, ogni lettura di tracciamento risponderebbe "non collegato".
        supabaseProjectRef: ref,
        supabaseProjectName: projectName,
      },
      update: {
        supabaseUrl: url,
        supabasePublicKey: encrypt(keys.anon),
        supabaseServiceRoleKey: encrypt(keys.serviceRole),
        supabaseProjectRef: ref,
        supabaseProjectName: projectName,
      },
    });

    // Quali tabelle esistono gia'. Serve a due cose diverse, e la seconda pesa
    // molto di piu' della prima:
    //
    //  - distinguere nel log "create entrambe" da "mancava solo clienti";
    //  - sapere quali tabelle sono del merchant. E' l'unico istante in cui la
    //    domanda ha risposta: la DDL e' CREATE TABLE IF NOT EXISTS e dopo di
    //    lei una tabella presente non racconta piu' chi l'ha creata. Da questa
    //    risposta dipende cosa lo scollegamento con eliminazione potra'
    //    cancellare — e soprattutto cosa non dovra' toccare mai.
    //
    // Si chiede di tutte e cinque le tabelle che l'app sa creare, non solo di
    // quelle che la DDL creera' stavolta: un piano che oggi non prevede i
    // clienti potrebbe prevederli domani, e a quel punto sapere se la sua
    // `customers` c'era gia' non sarebbe piu' possibile.
    const probed = tablesToProbe();
    let existingTables: string[] = [];
    let probeOk = false;
    try {
      const rows = await runQueryRows<{ table_name: string }>(
        token,
        ref,
        // I nomi sono costanti nostre, non arrivano da nessun form: passano
        // comunque da `quoteLiteral`, perche' la regola e' che nel SQL non
        // entri niente che non sia passato di li'. Un'eccezione "tanto qui e'
        // sicuro" e' come le eccezioni finiscono per diventare la regola.
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (${probed
          .map((t) => quoteLiteral(t))
          .join(', ')});`,
      );
      existingTables = rows.map((r) => r.table_name).filter(Boolean);
      probeOk = true;
    } catch (err) {
      console.warn(
        '[api.supabase.select-project] controllo tabelle preesistenti fallito:',
        err instanceof Error ? err.message : 'errore sconosciuto',
      );
    }

    // DDL idempotente e non distruttivo: crea le tabelle mancanti e allinea le
    // colonne di quelle già esistenti (progetto pre-esistente) senza cancellare
    // i dati. Applica solo le tabelle abilitate dal piano.
    //
    // La ricarica dello schema in coda non è un di più: l'API REST del progetto
    // lavora su una copia in cache, e una sincronizzazione avviata subito dopo
    // il collegamento scriverebbe su tabelle che quella copia non conosce
    // ancora.
    const includeOrders = hasOrdersAccess(shop.scopes);
    await runQuery(
      token,
      ref,
      buildMerchantSchemaSQL(includeCustomers, includeOrders) + RELOAD_SCHEMA_SQL,
    );

    // Il registro di proprieta': quali di queste tabelle le abbiamo create noi.
    //
    // Si scrive solo se il controllo qui sopra e' riuscito. Senza la fotografia
    // del prima non si sa chi ha creato cosa, e registrarle tutte come nostre
    // sarebbe proprio la supposizione che ha portato a cancellare la `products`
    // di un merchant che ce l'aveva gia' — un'assenza dal registro costa dello
    // spazio inutilizzato, una riga sbagliata costa i suoi dati.
    //
    // Best effort: il collegamento e' gia' riuscito, e un errore qui non deve
    // farlo fallire.
    if (probeOk) {
      const provisioned = ['products', 'users']
        .concat(includeCustomers ? ['customers'] : [])
        .concat(includeOrders ? ['orders', 'order_lines'] : []);
      try {
        await recordProvisionedResources({
          shopId: shop.id,
          projectRef: ref,
          provisioned,
          preExisting: existingTables,
          schemaVersion: LATEST_SCHEMA_VERSION,
        });
      } catch (err) {
        console.warn(
          '[api.supabase.select-project] registro di proprieta non scritto:',
          err instanceof Error ? err.message : 'errore sconosciuto',
        );
      }
    }

    // Log dell'evento di creazione tabelle. Best effort come l'emissione del
    // token-proxy: a questo punto la DDL e' riuscita e un errore qui non deve
    // far fallire il collegamento.
    try {
      const created = detectCreatedTables(existingTables, includeCustomers);
      const jobType = tableCreationJobType(created);
      if (jobType) {
        await prisma.syncJob.create({
          data: {
            shopId: shop.id,
            jobType,
            status: 'completed',
            completedAt: new Date(),
          },
        });
      }
    } catch (err) {
      console.warn(
        '[api.supabase.select-project] log creazione tabelle fallito:',
        err instanceof Error ? err.message : 'errore sconosciuto',
      );
    }

    // connectionVerifiedAt e' quello che accende la sincronizzazione: da qui in
    // poi il negozio entra nelle sync automatiche e i webhook non lo scartano
    // piu'. Non c'e' nessun interruttore da alzare oltre a questo.
    // Lo schema appena creato e' quello corrente: il progetto nasce allineato e
    // non deve ricevere l'aggiornamento che serve ai collegamenti piu' vecchi.
    await prisma.supabaseConfig.update({
      where: { shopId: shop.id },
      data: {
        connectionVerifiedAt: new Date(),
        schemaVersion: LATEST_SCHEMA_VERSION,
      },
    });

    // Emette il token-proxy per le letture di tracciamento se lo shop non ne ha
    // già uno: una riconnessione mantiene il token esistente, così il merchant
    // non deve riconfigurare Stape/GTM.
    //
    // Best effort, come il salvataggio di ref/password in create-project: a
    // questo punto il collegamento è già completo e funzionante, e un errore
    // qui (timeout del pooler, colonne di migrazione mancanti) NON deve farlo
    // finire nel catch, che azzererebbe connectionVerifiedAt e costringerebbe a
    // rieseguire la DDL. Se il token non viene emesso, il merchant lo genera
    // dalle Impostazioni.
    try {
      const existing = await prisma.shop.findUnique({
        where: { id: shop.id },
        select: { readProxyTokenHash: true },
      });
      if (!existing?.readProxyTokenHash) {
        await issueReadProxyToken(shop.id);
      }
    } catch (tokenErr) {
      console.warn(
        '[api.supabase.select-project] collegamento riuscito ma emissione del token-proxy fallita:',
        tokenErr instanceof Error ? tokenErr.message : 'errore sconosciuto',
      );
    }

    // La prima sincronizzazione parte da sola. Il merchant ha appena scelto il
    // database: chiedergli un secondo gesto per far succedere l'unica cosa che
    // quel gesto prometteva sarebbe una domanda senza alternative.
    //
    // Best effort come le due operazioni qui sopra: il collegamento e' gia'
    // completo, e se la coda non risponde ci pensa il giro programmato. Il
    // terzo passo resta comunque a disposizione per rilanciarla insieme alla
    // conferma del piano.
    try {
      await enqueueManualSync(shop.id);
      triggerSyncDrain(shop.id);
    } catch (syncErr) {
      console.warn(
        '[api.supabase.select-project] collegamento riuscito ma avvio della sincronizzazione fallito:',
        syncErr instanceof Error ? syncErr.message : 'errore sconosciuto',
      );
    }

    return json({ ok: true });
  } catch (e) {
    console.error('[api.supabase.select-project]', e instanceof Error ? e.message : 'errore sconosciuto');
    await prisma.supabaseConfig
      .update({ where: { shopId: shop.id }, data: { connectionVerifiedAt: null } })
      .catch(() => {});
    return json(
      { ok: false, error: (await dictionaryForShop(session.shop)).errors.linkFailed },
      { status: 500 },
    );
  }
}
