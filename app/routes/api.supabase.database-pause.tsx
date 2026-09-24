// app/routes/api.supabase.database-pause.tsx
//
// Lo stato del database fermo di un negozio, e la richiesta di farlo ripartire.
//
// Le due cose stanno nella stessa rotta perche' sono la stessa conversazione:
// il banner chiede "com'e' messo?", il merchant risponde premendo, e subito
// dopo il banner richiede "e adesso?". Separarle avrebbe voluto dire due rotte
// che leggono lo stesso stato e due occasioni perche' raccontino due cose
// diverse.
//
// UNA ROTTA A SE' E NON DENTRO IL LOADER DELLA DASHBOARD, per il vincolo che
// governa tutta questa funzione: la dashboard non deve pagare una chiamata di
// rete verso Supabase per una risposta che quasi sempre e' "tutto a posto". Qui
// il costo e' una lettura di cache, e a Supabase si va solo per un negozio di
// cui si sa gia' che il database e' fermo.
import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import { authenticate } from '~/shopify.server';
import {
  noteResumeBlocked,
  noteResumeRequested,
  readDatabasePause,
  type DatabasePauseView,
} from '~/lib/supabase/database-pause.server';
import {
  effectiveAvailability,
  shouldOfferResume,
  type ResumeBlock,
} from '~/lib/supabase/database-pause';
import { autoResumeIsOn } from '~/lib/supabase/auto-resume';
import { readAutoResumeSetting } from '~/lib/supabase/auto-resume-setting.server';
import {
  SupabaseApiError,
  isSupabaseCredentialDead,
  projectDashboardUrl,
  restoreProject,
} from '~/lib/supabase-management.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';

/** Il negozio che sta bussando, con il progetto che ha collegato. */
async function shopWithProject(request: Request) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true, supabaseConfig: { select: { supabaseProjectRef: true } } },
  });
  if (!shop) throw new Response('Shop non trovato', { status: 404 });
  return { shopId: shop.id, ref: shop.supabaseConfig?.supabaseProjectRef ?? null };
}

/** Lo stato "non c'e' niente da segnalare": nessun avviso, nessun pulsante. */
const NIENTE: DatabasePauseView = {
  availability: 'attivo',
  canResume: false,
  resumeBlocked: null,
  dashboardUrl: null,
  resumedByApp: false,
  autoResumeOn: false,
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { shopId, ref } = await shopWithProject(request);
  if (!ref) return json(NIENTE);

  const state = await readDatabasePause(shopId);
  if (!state) return json(NIENTE);

  // La scelta sulla riattivazione automatica si legge solo QUI, cioe' solo
  // quando c'e' gia' qualcosa da segnalare: e' l'unico momento in cui serve, e
  // leggerla prima vorrebbe dire una query in piu' su ogni apertura di pagina
  // per una risposta che non si mostrerebbe a nessuno.
  const setting = await readAutoResumeSetting(shopId);

  const now = new Date();
  return json({
    availability: effectiveAvailability(state, now),
    canResume: shouldOfferResume(state, now),
    resumeBlocked: state.resumeBlocked ?? null,
    resumedByApp: state.resumedByApp === true,
    // `null` (non c'e' ancora dove leggerla) vale NO: l'app in quel caso non
    // interviene, e l'avviso non deve promettere il contrario.
    autoResumeOn: setting !== null && autoResumeIsOn(setting),
    // Sempre presente quando c'e' qualcosa da segnalare, anche quando il
    // pulsante c'e': se la riattivazione dall'app non riesce, il merchant deve
    // avere l'altra strada davanti agli occhi e non doverla cercare.
    dashboardUrl: projectDashboardUrl(ref),
  } satisfies DatabasePauseView);
}

/**
 * Perche' la riattivazione non e' partita — un codice per caso, non un
 * messaggio unico.
 *
 * Sono situazioni opposte per chi legge: con 403 il gesto va fatto dalla
 * dashboard Supabase e premere ancora non servira' mai; con 429 basta
 * aspettare. Un solo "non riuscito" manderebbe meta' dei merchant ad aspettare
 * una cosa che non arrivera', e l'altra meta' a cercare un guasto che non c'e'.
 *
 * NOTA SUL CASO "PROGETTO NON PIU' RIATTIVABILE": Supabase non lo distingue.
 * L'API dichiara per questo endpoint 401, 403 e 429 e nient'altro, e un
 * progetto oltre la finestra di riattivazione rientra nel 403 come il permesso
 * mancante. Li' trattiamo i due casi insieme, e va bene che sia cosi': il gesto
 * che li risolve entrambi e' lo stesso — aprire la dashboard Supabase, dove il
 * merchant legge la data e vede se il pulsante c'e' ancora.
 */
function resumeBlockOf(status: number): ResumeBlock | null {
  if (status === 401) return 'reconnect';
  if (status === 403) return 'no_permission';
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  const { shopId, ref } = await shopWithProject(request);
  if (!ref) return json({ ok: false, code: 'not_connected' as const }, { status: 400 });

  const dashboardUrl = projectDashboardUrl(ref);

  try {
    const token = await getValidAccessToken(shopId);
    await restoreProject(token, ref);
  } catch (e) {
    if (isSupabaseCredentialDead(e)) {
      await noteResumeBlocked(shopId, 'reconnect');
      return json({ ok: false, code: 'reconnect' as const, dashboardUrl }, { status: 502 });
    }

    if (e instanceof SupabaseApiError) {
      console.error('[api.supabase.database-pause] riattivazione rifiutata:', e.status, e.body.slice(0, 200));

      // Troppe richieste: il pulsante NON si blocca. E' l'unico dei rifiuti che
      // passa da solo, e toglierlo per un'attesa di qualche minuto lascerebbe
      // il merchant senza il gesto proprio quando basta ripeterlo.
      if (e.status === 429) {
        return json({ ok: false, code: 'rate_limited' as const, dashboardUrl }, { status: 429 });
      }

      const blocco = resumeBlockOf(e.status);
      if (blocco) {
        await noteResumeBlocked(shopId, blocco);
        return json({ ok: false, code: blocco, dashboardUrl }, { status: 502 });
      }
    }

    console.error(
      '[api.supabase.database-pause] riattivazione non riuscita:',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return json({ ok: false, code: 'failed' as const, dashboardUrl }, { status: 502 });
  }

  // Accettata, non conclusa: Supabase risponde 200 e poi ci mette dei minuti.
  // Si segna l'ora della richiesta e si dice "in riattivazione", che e' l'unica
  // cosa vera in questo istante. Non si rilegge lo stato da Supabase: la
  // risposta sarebbe quasi certamente ancora "fermo", ed e' esattamente il
  // tratto che questa data copre.
  await noteResumeRequested(shopId, 'INACTIVE');

  return json({ ok: true, dashboardUrl, availability: 'in-riattivazione' as const });
}
