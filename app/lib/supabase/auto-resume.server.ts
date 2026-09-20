// app/lib/supabase/auto-resume.server.ts
//
// Il giro che riaccende i database in pausa prima che non si riaccendano piu'.
//
// PERCHE' UN GIRO E NON UN GESTO NEL BANNER. Perche' il merchant a rischio e'
// proprio quello che il banner non lo legge: un progetto Supabase gratuito
// viene messo in pausa quando nessuno lo tocca da settimane, e chi non tocca il
// progetto quasi sempre non apre nemmeno l'app. Il pulsante resta — e' il suo
// database, il gesto e' suo — ma se lui non passa, passa questo giro.
//
// QUANTO COSTA, che e' il vincolo che gli da' forma: nessuna chiamata a
// Supabase per un negozio che sta bene. Il filtro e' un fatto che abbiamo gia'
// nel nostro database — da quando questo negozio non da' piu' prova di vita — e
// solo chi lo supera si guadagna una domanda sullo stato del progetto. Su un
// parco di negozi sani il giro e' due query e basta.
import { prisma } from '~/db.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilitiesWithPlan, CAPABILITY_SHOP_SELECT } from '~/lib/authz/shop-capabilities.server';
import { samePlanName } from '~/lib/billing/plan-name';
import { getDatabasePauseState } from '~/lib/cache/database-pause-cache.server';
import { getValidAccessToken, isRinnovoPermessoInCorso } from '~/lib/supabase-oauth.server';
import {
  SupabaseApiError,
  isSupabaseCredentialDead,
  restoreProject,
} from '~/lib/supabase-management.server';
import {
  effectiveAvailability,
  stateIsStale,
  type DatabasePauseState,
} from './database-pause';
import {
  noteResumeBlocked,
  noteResumeRequested,
  refreshDatabasePauseState,
} from './database-pause.server';
import {
  decideAutoResume,
  tempoFermoMs,
  vaInterrogato,
  type AutoResumeDecision,
  type AutoResumeSetting,
} from './auto-resume';
import {
  noteAutoResumeChecked,
  noteAutoResumeFailed,
  noteAutoResumeRequested,
  readAutoResumeSettings,
  resetAutoResumeAttempts,
} from './auto-resume-setting.server';
import { notifyAutoResume } from './auto-resume-notice.server';

/**
 * Quanto puo' essere vecchia la lettura dello stato perche' valga come "l'ho
 * appena chiesto".
 *
 * Serve a distinguere una risposta di Supabase da un suo silenzio:
 * `refreshDatabasePauseState` restituisce quel che gia' sapevamo quando la
 * lettura non riesce, e agire su quello vorrebbe dire chiedere la riattivazione
 * di un progetto che magari e' tornato su da un mese. Un minuto e' larghissimo
 * rispetto al giro — la scrittura appena fatta porta l'ora esatta di adesso —
 * e stretto rispetto all'attesa fra due tentativi, che e' di ore.
 */
const LETTURA_FRESCA_MS = 60_000;

export interface AutoResumeReport {
  /** Negozi collegati che il giro ha preso in considerazione. */
  candidati: number;
  /** A quanti si e' davvero chiesto lo stato del progetto. */
  interrogati: number;
  /** Per quanti si e' chiesta la riattivazione. */
  riattivati: number;
  /** Quante richieste di riattivazione Supabase ha rifiutato. */
  rifiutati: number;
  /**
   * La tabella delle scelte non esiste ancora: la funzione e' spenta per
   * tutti. E' lo stato normale fra il rilascio del codice e l'esecuzione della
   * migrazione, e va visto nei numeri del cron invece che dedotto da un vuoto.
   */
  nonConfigurato: boolean;
  errori: string[];
}

const NIENTE_DA_FARE: AutoResumeReport = {
  candidati: 0,
  interrogati: 0,
  riattivati: 0,
  rifiutati: 0,
  nonConfigurato: false,
  errori: [],
};

/**
 * I negozi che possono anche solo essere presi in considerazione.
 *
 * Le due condizioni sulla riga del negozio — non disinstallato, non in
 * cancellazione — sono qui e non solo nella policy per una ragione pratica: chi
 * se n'e' andato non deve nemmeno comparire nell'elenco. La policy completa
 * (autorizzazione, prova scaduta) la si chiede comunque piu' sotto, negozio per
 * negozio, perche' e' li' che vive e non va riscritta qui.
 */
async function candidati() {
  return prisma.shop.findMany({
    where: {
      uninstalledAt: null,
      lifecycleStatus: { not: 'erasing' },
      supabaseConfig: {
        is: { supabaseProjectRef: { not: null }, connectionVerifiedAt: { not: null } },
      },
    },
    select: {
      ...CAPABILITY_SHOP_SELECT,
      id: true,
      shopDomain: true,
      // Sostituisce la select del blocco qui sopra, che del collegamento chiede
      // la sola data di verifica: qui serve anche il progetto da riaccendere.
      supabaseConfig: { select: { connectionVerifiedAt: true, supabaseProjectRef: true } },
    },
  });
}

/**
 * L'ultimo istante in cui il database di questo negozio ha DATO PROVA di essere
 * vivo.
 *
 * Sono due fatti, e stanno tutti e due nel nostro database — non nel progetto
 * del merchant, che quando serve saperlo e' spento:
 *
 *   1. l'ultima sincronizzazione andata a buon fine. Una corsa completata ha
 *      scritto righe nel database del merchant: in quel momento rispondeva.
 *      E' un limite inferiore vero per l'inizio della pausa, ed e' il piu'
 *      prezioso perche' si aggiorna da solo a ogni giro;
 *   2. la verifica del collegamento. Anche quella e' passata da una query
 *      riuscita, e copre il negozio appena collegato che non ha ancora
 *      sincronizzato niente.
 *
 * Si prende il PIU' RECENTE dei due, e la direzione non e' indifferente: la
 * pausa e' cominciata dopo l'ultima prova di vita, quindi contare dalla piu'
 * recente da' il tempo trascorso piu' lungo compatibile con i fatti. E' la
 * stima pessimista, ed e' l'unica che non fa arrivare tardi.
 *
 * `null` = nessuna delle due. E' il caso cieco, e lo gestisce `sogliaSuperata`.
 */
async function ultimaProvaDiVita(
  shopId: string,
  connectionVerifiedAt: Date | null,
): Promise<Date | null> {
  const corsa = await prisma.syncJob.findFirst({
    where: {
      shopId,
      status: { in: ['completed', 'completed_with_repairs'] },
      completedAt: { not: null },
    },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  });

  const date = [corsa?.completedAt ?? null, connectionVerifiedAt].filter(
    (d): d is Date => d instanceof Date,
  );
  if (date.length === 0) return null;
  return date.reduce((piuRecente, d) => (d > piuRecente ? d : piuRecente));
}

/**
 * Il giro, per tutti i negozi che lo meritano.
 *
 * Nessun negozio che fallisce ferma gli altri: ogni passaggio ha il suo
 * try/catch, perche' qui dentro si parla con un servizio terzo e con
 * l'infrastruttura di persone diverse.
 */
export async function runAutoResume(now: Date = new Date()): Promise<AutoResumeReport> {
  const shops = await candidati();
  if (shops.length === 0) return { ...NIENTE_DA_FARE };

  // Le scelte dei merchant, in una lettura sola. `null` vuol dire che non c'e'
  // ancora nessun posto dove leggerle: il giro si ferma qui, per tutti. NON si
  // riattiva niente "tanto nessuno ha detto di no": nessuno ha nemmeno potuto
  // dirlo, e un gesto che tocca l'infrastruttura di qualcun altro non si fa
  // sulla base di un consenso che non e' mai stato chiesto.
  const scelte = await readAutoResumeSettings(shops.map((s) => s.id));
  if (!scelte) return { ...NIENTE_DA_FARE, nonConfigurato: true };

  // Il listino una volta sola: la policy ne ha bisogno per ogni negozio, e
  // chiederlo dentro il ciclo sarebbe un'interrogazione per negozio per una
  // risposta uguale per tutti.
  const plans = await prisma.plan.findMany();

  const report: AutoResumeReport = { ...NIENTE_DA_FARE, candidati: shops.length };

  for (const shop of shops) {
    try {
      await unNegozio(shop, scelte.get(shop.id) ?? null, plans, now, report);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'errore sconosciuto';
      console.error(`[auto-resume] giro fallito per ${shop.shopDomain}:`, message);
      report.errori.push(`${shop.shopDomain}: ${message}`);
    }
  }

  return report;
}

type Candidato = Awaited<ReturnType<typeof candidati>>[number];
type Listino = Awaited<ReturnType<typeof prisma.plan.findMany>>;

async function unNegozio(
  shop: Candidato,
  setting: AutoResumeSetting | null,
  plans: Listino,
  now: Date,
  report: AutoResumeReport,
): Promise<void> {
  const ref = shop.supabaseConfig?.supabaseProjectRef;
  if (!ref) return;

  // CHI NON VA TOCCATO. La domanda e' `use_app`, cioe' la precondizione di
  // tutto il resto: negozio esistente, app installata, autorizzazione concessa,
  // prova non scaduta, cancellazione non cominciata. Non si ricompone qui — e'
  // esattamente l'errore da cui `capabilities.ts` e' nato — e non si inventa un
  // motivo nuovo: riaccendere l'infrastruttura di chi se n'e' andato o di chi
  // abbiamo sospeso e' il modo piu' diretto di trasformare un aiuto in
  // un'intrusione.
  const plan = plans.find((p) => samePlanName(p.planName, shop.currentPlan)) ?? null;
  const allowed = can(shopCapabilitiesWithPlan(shop, plan, now), 'use_app');

  const lastProofOfLife = await ultimaProvaDiVita(
    shop.id,
    shop.supabaseConfig?.connectionVerifiedAt ?? null,
  );

  // Il filtro che tiene basso il costo del giro, e che contiene anche il freno:
  // senza, un negozio che non sincronizza da mesi per ragioni che con la pausa
  // non c'entrano niente produrrebbe una domanda a Supabase a ogni passaggio
  // del cron, cioe' ogni mezz'ora per sempre.
  if (!vaInterrogato({ allowed, setting, lastProofOfLife, now })) return;

  report.interrogati++;

  // Da qui in poi si e' toccato Supabase: il freno scatta comunque, qualunque
  // sia l'esito. Se la memoria di questo passaggio non venisse scritta, il
  // giro successivo — mezz'ora dopo — ripartirebbe da capo.
  const precedente = await getDatabasePauseState(shop.id);
  const state = await refreshDatabasePauseState(shop.id, ref, precedente);

  if (!state) {
    // Il progetto e' attivo. `refreshDatabasePauseState` ha gia' fatto la parte
    // che conta — pulito l'avviso e, se veniva da fermo, rimesso in moto la
    // sincronizzazione. Qui resta solo da restituire al negozio il suo budget
    // di tentativi: una pausa futura deve trovarlo pieno.
    await resetAutoResumeAttempts(shop.id, now);
    return;
  }

  // Lettura vecchia = Supabase non ha risposto, e `refreshDatabasePauseState`
  // ci ha restituito quel che gia' sapevamo. Non e' una notizia: chiedere la
  // riattivazione su questa base vorrebbe dire premere al buio su un progetto
  // che potrebbe essere tornato su settimane fa.
  if (stateIsStale(state, now, LETTURA_FRESCA_MS)) {
    await noteAutoResumeChecked(shop.id, now);
    return;
  }

  const decisione = decideAutoResume({
    availability: effectiveAvailability(state, now),
    allowed,
    setting,
    lastProofOfLife,
    now,
  });

  if (decisione !== 'riattiva') {
    await noteAutoResumeChecked(shop.id, now);
    tracciaSalto(shop.shopDomain, decisione);
    return;
  }

  await chiediRiattivazione(shop, ref, state, lastProofOfLife, now, report);
}

/**
 * Le decisioni che vale la pena veder scritte da qualche parte.
 *
 * Non tutte: "troppo presto" e "database attivo" sono il funzionamento normale
 * e riempirebbero il log di righe che non dicono niente. Le due qui sotto no —
 * un negozio che ha esaurito i tentativi e' un database che sta per essere
 * perso davvero, ed e' l'unica riga che lo annuncia prima che accada.
 */
function tracciaSalto(shopDomain: string, decisione: AutoResumeDecision): void {
  if (decisione === 'tentativi-esauriti') {
    console.warn(
      `[auto-resume] ${shopDomain}: tentativi esauriti, il database resta fermo e ` +
        'solo il merchant puo’ riaccenderlo adesso.',
    );
  }
  if (decisione === 'stato-non-letto') {
    console.warn(`[auto-resume] ${shopDomain}: stato del progetto non interpretabile, non si tocca.`);
  }
}

/**
 * La riattivazione vera e propria, con tutto quel che va scritto dopo.
 *
 * `restoreProject` risponde 200 e poi ci mette dei minuti: da qui esce una
 * richiesta accettata, non un database acceso. Per questo si scrive
 * `resumeRequestedAt` — la stessa data che copre il tratto in cui Supabase
 * dichiara ancora il progetto fermo — e si marca che a premere e' stata l'app,
 * che e' cio' che fa cambiare il testo del banner.
 */
async function chiediRiattivazione(
  shop: Candidato,
  ref: string,
  state: DatabasePauseState,
  lastProofOfLife: Date | null,
  now: Date,
  report: AutoResumeReport,
): Promise<void> {
  try {
    const token = await getValidAccessToken(shop.id);
    await restoreProject(token, ref);
  } catch (e) {
    // Il permesso lo stava rinnovando un'altra richiesta e non ha fatto in
    // tempo: qui non e' stato rifiutato niente, non si e' nemmeno bussato.
    // Contarlo come rifiuto farebbe scattare il freno di sei ore per una fila
    // di qualche centinaio di millisecondi — e il margine per riaccendere il
    // database, che e' cio' che questo giro difende, si consuma intanto.
    if (isRinnovoPermessoInCorso(e)) {
      console.warn(
        `[auto-resume] ${shop.shopDomain}: permesso in rinnovo altrove, si riprova al giro dopo`,
      );
      return;
    }

    report.rifiutati++;
    // Il contatore sale anche sul rifiuto: un errore che non conta lascerebbe
    // l'app a bussare ogni sei ore per tutto il margine.
    await noteAutoResumeFailed(shop.id, now);

    if (isSupabaseCredentialDead(e)) {
      // Il collegamento all'account non vale piu': il pulsante nel banner
      // smette di essere offerto e al merchant si dice di ricollegare. E' una
      // cosa che solo lui puo' fare, e ha ancora il margine per farla.
      await noteResumeBlocked(shop.id, 'reconnect');
      return;
    }

    if (e instanceof SupabaseApiError) {
      console.error(
        `[auto-resume] ${shop.shopDomain}: riattivazione rifiutata`,
        e.status,
        e.body.slice(0, 200),
      );
      // 403 comprende sia il permesso mancante sia il progetto ormai fuori
      // finestra: Supabase non li distingue, e per il merchant la strada e' la
      // stessa — la pagina del suo database. 429 invece passa da solo, e non
      // deve spegnere il pulsante nel banner.
      if (e.status === 401) await noteResumeBlocked(shop.id, 'reconnect');
      if (e.status === 403) await noteResumeBlocked(shop.id, 'no_permission');
      return;
    }

    console.error(
      `[auto-resume] ${shop.shopDomain}: riattivazione non riuscita:`,
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return;
  }

  report.riattivati++;
  // `true`: a premere e' stata l'app. E' il campo da cui il banner capisce che
  // deve raccontare un'altra cosa — non "sta partendo quel che hai chiesto" ma
  // "lo abbiamo riacceso noi, prima che fosse tardi".
  await noteResumeRequested(shop.id, state.status, true);
  await noteAutoResumeRequested(shop.id, now);

  await notifyAutoResume({
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    at: now,
    fermoDaMs: tempoFermoMs({ lastProofOfLife, now }),
  });
}
