// app/routes/api.supabase.create-project.tsx
import { dictionaryForShop } from '~/lib/i18n/server';
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { encrypt } from '~/utils/crypto.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import {
  listProjects,
  listOrganizations,
  createProject,
  organizationBillingUrl,
  isPlanLimitError,
  SupabaseApiError,
} from '~/lib/supabase-management.server';
import { generateDbPassword } from '~/lib/password.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return json({ ok: false, error: 'Shop non trovato' }, { status: 404 });
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

  const body = (await request.json()) as { name?: unknown; region?: unknown };
  if (!body.name || typeof body.name !== 'string' || !body.region || typeof body.region !== 'string') {
    return json({ ok: false, error: 'Nome e region sono obbligatori' }, { status: 400 });
  }

  try {
    const token = await getValidAccessToken(shop.id);

    // Ricava l'organization_id senza dipendere dallo scope "Organizations"
    // (non concesso): i progetti esistenti — leggibili con Projects:Read, già
    // concesso — portano già l'organization_id. Solo per account a zero progetti
    // si ricade su listOrganizations, che richiede lo scope dedicato.
    let organizationId: string | undefined;
    const projects = await listProjects(token);
    if (projects.length > 0) {
      organizationId = projects[0].organization_id;
    } else {
      try {
        const orgs = await listOrganizations(token);
        organizationId = orgs[0]?.id;
      } catch {
        return json(
          {
            ok: false,
            error:
              "Non riesco a determinare l'organizzazione: crea il primo progetto dalla dashboard Supabase, poi ricollega.",
            code: 'no_org',
          },
          { status: 400 },
        );
      }
    }
    if (!organizationId) {
      return json(
        { ok: false, error: (await dictionaryForShop(session.shop)).errors.noOrganization },
        { status: 400 },
      );
    }

    const dbPass = generateDbPassword();
    const { ref } = await createProject(token, {
      name: body.name,
      organizationId,
      region: body.region,
      dbPass,
    });

    // Il progetto è ormai creato su Supabase. Il salvataggio del ref è
    // "best effort": se fallisce (es. colonne di migrazione mancanti nel DB
    // metadata) NON buttiamo via il lavoro — il polling prosegue e select-project
    // completerà comunque il collegamento (non usa questa colonna).
    //
    // La password NON viene conservata: serve solo a Supabase per creare il
    // progetto, l'app non la rilegge mai, e un segreto custodito senza motivo
    // e' solo una superficie d'attacco in piu'. Chi ne ha bisogno la rigenera
    // dal proprio pannello Supabase.
    try {
      await prisma.supabaseConfig.upsert({
        where: { shopId: shop.id },
        create: {
          shopId: shop.id,
          supabaseUrl: `https://${ref}.supabase.co`,
          supabasePublicKey: '',
          supabaseServiceRoleKey: '',
          supabaseProjectRef: ref,
        },
        update: {
          supabaseProjectRef: ref,
        },
      });
    } catch (saveErr) {
      console.warn(
        '[api.supabase.create-project] progetto creato ma salvataggio ref/password fallito (migrazione supabase_configs mancante?):',
        saveErr instanceof Error ? saveErr.message : 'errore sconosciuto',
      );
    }

    return json({ ok: true, ref });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'errore sconosciuto';
    console.error('[api.supabase.create-project]', msg, e instanceof SupabaseApiError ? e.body : '');

    // Rete di sicurezza per i merchant la cui OAuth App non concede lo scope
    // organizations:read: senza di quello non possiamo verificare il piano
    // PRIMA di creare, quindi il limite lo scopriamo dal rifiuto di Supabase e
    // mostriamo lo stesso banner + upgrade, solo a posteriori.
    if (e instanceof SupabaseApiError && isPlanLimitError(e.status, e.body)) {
      let billingUrl: string | null = null;
      try {
        const token = await getValidAccessToken(shop.id);
        const projects = await listProjects(token);
        const slug = projects[0]?.organization_slug;
        billingUrl = slug ? organizationBillingUrl(slug) : null;
      } catch {
        billingUrl = null;
      }
      return json(
        {
          ok: false,
          error:
            'Hai raggiunto il limite massimo di progetti consentito dal tuo piano Supabase. Aggiorna il piano, oppure metti in pausa un progetto esistente: i progetti in pausa non occupano uno slot.',
          code: 'plan_limit',
          billingUrl,
        },
        { status: 403 },
      );
    }

    // 403 = scope Projects:Write mancante nella OAuth App.
    if (msg.includes('403')) {
      return json(
        {
          ok: false,
          error: (await dictionaryForShop(session.shop)).errors.createProjectScope,
          code: 'scope',
        },
        { status: 403 },
      );
    }
    return json(
      { ok: false, error: (await dictionaryForShop(session.shop)).errors.createProjectFailed },
      { status: 502 },
    );
  }
}
