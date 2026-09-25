// app/lib/supabase/database-pause.server.ts
//
// Chi va a chiedere a Supabase se il database del merchant e' fermo, e quando.
//
// IL VINCOLO CHE DA' FORMA A TUTTO QUESTO FILE: a Supabase non si chiede niente
// a ogni apertura di pagina. E' una chiamata di rete verso un terzo su un
// percorso che il merchant attraversa in continuazione, e pagarla sempre per
// una risposta che quasi sempre e' "tutto a posto" vorrebbe dire rallentare
// ogni schermata per il caso raro.
//
// Quindi si chiede solo in due momenti, e sono tutti e due momenti in cui la
// domanda e' gia' stata posta da qualcos'altro:
//
//   1. quando una lettura del database del merchant e' GIA' fallita. Li' la
//      domanda "ma il database c'e'?" e' l'unica che abbia senso, e la risposta
//      e' quello che manca per dirla al merchant invece di mostrargli delle
//      card vuote.
//   2. quando gia' sappiamo che e' fermo e vogliamo sapere se e' tornato.
//      Riguarda i soli negozi in pausa, ed e' comunque frenato a una volta al
//      minuto.
//
// Sul percorso normale — database acceso, nessun fallimento — questo file non
// chiama Supabase mai: legge una riga di cache e basta.

import { prisma } from '~/db.server';
import {
  clearDatabasePauseState,
  getDatabasePauseState,
  setDatabasePauseState,
} from '~/lib/cache/database-pause-cache.server';
import { enqueueManualSync, triggerSyncDrain } from '~/lib/queue/trigger.server';
import { enqueueLogisticsRecompute } from '~/lib/shipping/recompute-enqueue.server';
import { enqueueShippingMethodBackfill } from '~/lib/shipping/shipping-method-backfill-enqueue.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { getProject, isSupabaseCredentialDead } from '~/lib/supabase-management.server';
import {
  classifyProjectStatus,
  databaseIsStopped,
  effectiveAvailability,
  stateIsStale,
  syncShouldRestart,
  type DatabaseAvailability,
  type DatabasePauseState,
  type ResumeBlock,
} from './database-pause';

/**
 * Ogni quanto, al massimo, si torna a chiedere a Supabase com'e' messo un
 * progetto che sappiamo fermo.
 *
 * Un minuto: la dashboard si ricarica da sola ogni pochi secondi mentre una
 * sincronizzazione e' in corso, e senza questo freno il banner farebbe una
 * chiamata a Supabase a ogni giro. Piu' lungo di cosi' invece si sentirebbe:
 * e' l'attesa fra "il database e' tornato" e "l'app se ne accorge".
 */
const RECHECK_MS = 60_000;

/** Il progetto Supabase collegato a un negozio, se ce n'e' uno. */
async function projectRefOf(shopId: string): Promise<string | null> {
  const config = await prisma.supabaseConfig.findUnique({
    where: { shopId },
    select: { supabaseProjectRef: true },
  });
  return config?.supabaseProjectRef ?? null;
}

/**
 * Va a chiedere lo stato a Supabase e lo scrive, con tutto quel che ne segue.
 *
 * "Quel che ne segue" e' la parte che non si vede: se il database e' tornato
 * attivo dopo essere stato fermo, la sincronizzazione riparte da sola. Il
 * merchant ha gia' fatto il suo gesto premendo il pulsante e se n'e' andato;
 * chiedergli di tornare a premerne un secondo per avere i dati aggiornati
 * sarebbe far pagare a lui il fatto che la riattivazione duri dei minuti.
 */
export async function refreshDatabasePauseState(
  shopId: string,
  ref: string,
  precedente: DatabasePauseState | null,
): Promise<DatabasePauseState | null> {
  let status: string;
  try {
    const token = await getValidAccessToken(shopId);
    ({ status } = await getProject(token, ref));
  } catch (e) {
    // Il collegamento all'account non vale piu': non e' una pausa, ed e' una
    // cosa diversa da dire al merchant. Si conserva quel che gia' si sapeva,
    // aggiungendo il motivo per cui il pulsante non puo' funzionare — cosi' il
    // banner, se e' acceso, smette di offrire un gesto che fallirebbe.
    if (isSupabaseCredentialDead(e) && precedente) {
      const bloccato: DatabasePauseState = { ...precedente, resumeBlocked: 'reconnect' };
      await setDatabasePauseState(shopId, bloccato);
      return bloccato;
    }
    // Qualunque altro intoppo: non sappiamo niente di nuovo, e inventare uno
    // stato sarebbe peggio di non averlo. Resta quel che c'era.
    console.error(
      '[database-pause] stato del progetto non leggibile:',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return precedente;
  }

  const availability = classifyProjectStatus(status);

  if (
    precedente &&
    syncShouldRestart(effectiveAvailability(precedente, new Date()), availability)
  ) {
    // Best effort, e nell'ordine giusto: prima la riga in coda, che e' durevole,
    // poi l'innesco — che se non arriva viene comunque recuperato dal giro
    // programmato.
    await enqueueManualSync(shopId).catch((e) =>
      console.error('[database-pause] ripartenza della sincronizzazione non accodata:', e),
    );
    // Anche il ricalcolo dei costi logistici: un salvataggio delle tariffe
    // fatto a database fermo ha visto il suo ricalcolo saltare, e la
    // sincronizzazione riscrive solo gli ordini cambiati — lo storico
    // resterebbe con i costi vecchi. Senza tariffe configurate il ricalcolo
    // scrive zero dove c'e' gia' zero, cioe' niente. Non solleva mai.
    await enqueueLogisticsRecompute(shopId);
    // E il recupero dell'opzione sugli ordini storici: se era partito a
    // database fermo e' uscito in silenzio, senza continuazione, e nessun
    // altro lo riaccoderebbe. Deduplicato (uno solo in coda o in corso) e
    // idempotente: se lo storico e' gia' completo costa una SELECT. Non
    // solleva mai. Accoda da se' il ricalcolo quando ha scritto qualcosa.
    await enqueueShippingMethodBackfill(shopId);
    triggerSyncDrain(shopId);
  }

  if (availability === 'attivo') {
    await clearDatabasePauseState(shopId);
    return null;
  }

  const nuovo: DatabasePauseState = {
    status,
    availability,
    checkedAt: new Date().toISOString(),
    // La richiesta di riattivazione sopravvive alla rilettura: e' il fatto che
    // copre il tratto in cui Supabase dichiara ancora il progetto fermo. Si
    // perde solo quando il progetto e' davvero tornato, cioe' nel ramo sopra.
    resumeRequestedAt: precedente?.resumeRequestedAt ?? null,
    // Il motivo del blocco no: se sapevamo che mancava il permesso e adesso
    // Supabase ci risponde, quel "no" era di prima e non deve inchiodare il
    // pulsante per sempre. Lo riscrive il prossimo tentativo, se serve.
    resumeBlocked: null,
    // Solo quando c'e' davvero: chi non e' mai stato riacceso dall'app non deve
    // portarsi dietro un campo che dice "no". Lo stato scritto sul percorso
    // normale resta identico a com'era prima che questa riga esistesse.
    ...(precedente?.resumedByApp ? { resumedByApp: true } : {}),
  };
  await setDatabasePauseState(shopId, nuovo);
  return nuovo;
}

/**
 * Una lettura del database del merchant e' fallita: vale la pena chiedersi se
 * il database c'e' ancora.
 *
 * E' IL PUNTO DI RILEVAZIONE. Si chiama dal `catch` di chi quelle letture le
 * fa, non da un loader: cosi' la chiamata a Supabase avviene solo dopo che
 * qualcosa e' gia' andato storto, e sul percorso buono non costa niente.
 *
 * Non rilancia mai: chi la chiama sta gia' gestendo un errore suo, e un
 * secondo errore dentro un `catch` trasformerebbe una card vuota in una pagina
 * rotta.
 */
export async function noteDatabaseUnreachable(shopId: string): Promise<void> {
  try {
    const gia = await getDatabasePauseState(shopId);
    // Gia' chiesto da poco: la dashboard ricarica le sue card a raffica, e
    // senza questo freno un database fermo produrrebbe una chiamata a Supabase
    // per ogni card che fallisce.
    if (gia && !stateIsStale(gia, new Date(), RECHECK_MS)) return;

    const ref = await projectRefOf(shopId);
    if (!ref) return;

    await refreshDatabasePauseState(shopId, ref, gia);
  } catch (e) {
    console.error(
      '[database-pause] rilevazione non riuscita (ignoro):',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
  }
}

/**
 * Come sopra, ma partendo dal dominio del negozio.
 *
 * Le rotte che leggono il database del merchant hanno in mano la sessione di
 * Shopify, cioe' il dominio: chiedere a ognuna di risolversi l'id prima di
 * poter segnalare un fallimento sarebbe una riga di rumore dentro un `catch`
 * che sta gia' gestendo un guasto.
 */
export async function noteDatabaseUnreachableForShop(shopDomain: string): Promise<void> {
  try {
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      select: { id: true },
    });
    if (!shop) return;
    await noteDatabaseUnreachable(shop.id);
  } catch (e) {
    console.error(
      '[database-pause] negozio non risolto (ignoro):',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
  }
}

/** Quel che il banner deve sapere per decidere che cosa dire. */
export interface DatabasePauseView {
  availability: DatabaseAvailability;
  /** Il pulsante puo' funzionare? Se no, il banner offre la dashboard. */
  canResume: boolean;
  resumeBlocked: ResumeBlock | null;
  /** Dove mandare il merchant quando il pulsante non basta. */
  dashboardUrl: string | null;
  /**
   * A chiedere la riattivazione e' stata l'app, non il merchant.
   *
   * Cambia il testo dell'avviso, non il tono: "lo abbiamo riacceso noi" e' pur
   * sempre un database che non risponde ancora e una sincronizzazione ferma.
   */
  resumedByApp: boolean;
  /**
   * L'app riaccendera' questo database da sola se il merchant non lo fa.
   *
   * Serve a dirglielo PRIMA che accada, dentro l'avviso che sta gia' guardando.
   * Falso anche quando non sappiamo se lui abbia detto di no: in quel caso
   * l'app non interviene, e promettere che interverra' sarebbe una bugia
   * tranquillizzante.
   */
  autoResumeOn: boolean;
}

/**
 * Come sta il database di questo negozio, per il banner.
 *
 * Costa una lettura di cache e nient'altro finche' il database e' acceso: non
 * si sa niente di fermo, non c'e' niente da chiedere a Supabase. Quando invece
 * risulta fermo, e la notizia e' vecchia di piu' di un minuto, si torna a
 * chiedere — perche' li' l'unica domanda che conta e' "e' tornato?", e la
 * risposta e' cio' che fa sparire il banner e ripartire la sincronizzazione.
 */
export async function readDatabasePause(shopId: string): Promise<DatabasePauseState | null> {
  let state = await getDatabasePauseState(shopId);
  if (!state) return null;

  if (databaseIsStopped(state.availability) && stateIsStale(state, new Date(), RECHECK_MS)) {
    const ref = await projectRefOf(shopId);
    if (ref) state = await refreshDatabasePauseState(shopId, ref, state);
  }

  return state;
}

/**
 * Segna che il merchant ha chiesto la riattivazione, o perche' non ha potuto.
 *
 * La data si scrive sul server e non nel browser per la ragione che
 * `pending-sync.ts` ha gia' pagato una volta: uno stato tenuto in una pagina
 * muore al cambio di scheda, e il merchant che torna indietro trova il pulsante
 * riacceso sopra una riattivazione che sta gia' avvenendo.
 */
export async function noteResumeRequested(
  shopId: string,
  status: string,
  /**
   * A premere e' stata l'app e non il merchant.
   *
   * Serve al banner, che in quel caso deve raccontare una cosa diversa: non
   * "sta partendo quel che hai chiesto" ma "lo abbiamo riacceso noi, perche'
   * stava per non essere piu' riaccendibile". Il valore di partenza e' `false`
   * perche' il gesto normale resta quello del merchant.
   */
  byApp = false,
): Promise<void> {
  const precedente = await getDatabasePauseState(shopId);
  await setDatabasePauseState(shopId, {
    status: precedente?.status ?? status,
    availability: precedente?.availability ?? 'in-pausa',
    checkedAt: precedente?.checkedAt ?? new Date().toISOString(),
    resumeRequestedAt: new Date().toISOString(),
    resumeBlocked: null,
    // Come sopra: il campo compare solo quando c'e' qualcosa da dire.
    ...(byApp ? { resumedByApp: true } : {}),
  });
}

/** Segna perche' il pulsante non ha potuto funzionare, cosi' il banner smette di offrirlo. */
export async function noteResumeBlocked(shopId: string, blocked: ResumeBlock): Promise<void> {
  const precedente = await getDatabasePauseState(shopId);
  await setDatabasePauseState(shopId, {
    status: precedente?.status ?? 'INACTIVE',
    availability: precedente?.availability ?? 'in-pausa',
    checkedAt: precedente?.checkedAt ?? new Date().toISOString(),
    resumeRequestedAt: precedente?.resumeRequestedAt ?? null,
    resumeBlocked: blocked,
  });
}
