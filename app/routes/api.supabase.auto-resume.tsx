// app/routes/api.supabase.auto-resume.tsx
//
// L'interruttore con cui il merchant dice se l'app debba riaccendere da sola il
// suo database prima che non sia piu' riaccendibile.
//
// UNA ROTTA SUA E NON L'ACTION DELLE IMPOSTAZIONI. La pagina delle Impostazioni
// non ha un'action: e' una schermata di sola lettura con dentro dei comandi che
// vanno ognuno al proprio indirizzo, ed e' quello che le permette di non
// ricaricarsi per intero ogni volta che si tocca qualcosa. Aggiungerle
// un'action per una spunta vorrebbe dire far transitare da li' anche tutto il
// resto, prima o poi.
//
// UNA ROTTA DIVERSA DA `api.supabase.database-pause`, che pure parla della
// stessa vicenda: quella e' uno stato che si legge e un gesto che si preme
// adesso, questa e' una preferenza che resta. Metterle insieme vorrebbe dire
// una action che a seconda del corpo fa due cose molto diverse su due tempi
// diversi.
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import { authenticate } from '~/shopify.server';
import { setAutoResumeEnabled } from '~/lib/supabase/auto-resume-setting.server';

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) throw new Response('Shop non trovato', { status: 404 });

  const form = await request.formData();
  // Solo l'esatto 'true' accende. Un valore che non sappiamo leggere non deve
  // mai risolversi in "si': tocca pure il mio database" — in dubbio si spegne,
  // che e' l'esito che non fa niente a nessuno.
  const enabled = form.get('enabled') === 'true';

  const salvato = await setAutoResumeEnabled(shop.id, enabled);
  if (!salvato) {
    // Non c'e' dove scriverlo. Si dice, invece di far credere che la scelta sia
    // stata presa: fingere di aver salvato un "non toccare il mio database"
    // sarebbe il peggiore degli esiti possibili.
    return json({ ok: false as const, code: 'unavailable' as const }, { status: 503 });
  }

  return json({ ok: true as const, enabled });
}
