// app/lib/supabase/auto-resume-setting.server.ts
//
// La scelta del merchant sulla riattivazione automatica, e la memoria dei
// tentativi. Sta nel database owner e non in cache, e le due cose hanno la
// stessa ragione: sono i due fatti che devono restare veri anche la sera in cui
// Redis non risponde. Un "non riaccenderlo" che si dimentica e' un no
// ignorato; un freno che si dimentica e' un martellamento.
//
// TUTTO QUESTO MODULO E' COSTRUITO INTORNO A UN CASO SOLO: la tabella potrebbe
// non esserci ancora. La migrazione la esegue una persona, a mano, su Live e su
// Test, e fra il rilascio del codice e quel momento passa del tempo. In quella
// finestra ogni lettura qui dentro fallisce, e la risposta e' `null` — che non
// vuol dire "acceso" e non vuol dire "spento": vuol dire "non sappiamo se il
// merchant ci abbia detto di no". Su un gesto che tocca l'infrastruttura di
// qualcun altro, in dubbio non si agisce. Vedi `decideAutoResume`.
import { prisma } from '~/db.server';
import type { AutoResumeSetting } from './auto-resume';

/**
 * L'errore che dice "quella tabella non c'e'".
 *
 * P2021 e' la tabella assente, P2022 la colonna assente: la seconda copre il
 * caso in cui la migrazione sia stata eseguita a meta' o rifatta a mano in modo
 * incompleto. Il confronto sul messaggio e' la rete sotto le due: i codici
 * Prisma cambiano fra versioni, e un errore non riconosciuto qui diventerebbe
 * un'eccezione dentro il cron invece di una funzione spenta.
 */
function tabellaAssente(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  if (code === 'P2021' || code === 'P2022') return true;
  const message = e instanceof Error ? e.message : '';
  return /does not exist|relation .* does not exist|column .* does not exist/i.test(message);
}

/** Il valore di partenza di un negozio che non ha mai toccato l'interruttore. */
const MAI_SCELTO: AutoResumeSetting = { enabled: null, lastAttemptAt: null, attempts: 0 };

/**
 * La scelta e i tentativi di un negozio.
 *
 * `null` = non c'e' ancora nessun posto dove leggerli (tabella assente).
 * Riga mancante ma tabella presente = il merchant non ha mai toccato niente,
 * che e' un caso diverso e vale il comportamento dichiarato dell'app.
 */
export async function readAutoResumeSetting(
  shopId: string,
): Promise<AutoResumeSetting | null> {
  try {
    const row = await prisma.supabaseAutoResume.findUnique({
      where: { shopId },
      select: { enabled: true, lastAttemptAt: true, attempts: true },
    });
    return row ?? MAI_SCELTO;
  } catch (e) {
    if (tabellaAssente(e)) return null;
    // Qualunque altro guasto: non si inventa una risposta. Chi chiama tratta il
    // `null` come "non si tocca niente", che e' l'esito prudente anche qui.
    console.error(
      '[auto-resume] scelta non leggibile:',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return null;
  }
}

/**
 * Le scelte di piu' negozi in una lettura sola.
 *
 * Serve al giro del cron: una query per negozio sarebbe N interrogazioni per
 * una risposta che quasi sempre e' "acceso, mai tentato". `null` vale come
 * sopra — tabella assente, non si tocca niente, e il giro si ferma li' invece
 * di riprovare negozio per negozio.
 */
export async function readAutoResumeSettings(
  shopIds: string[],
): Promise<Map<string, AutoResumeSetting> | null> {
  if (shopIds.length === 0) return new Map();
  try {
    const rows = await prisma.supabaseAutoResume.findMany({
      where: { shopId: { in: shopIds } },
      select: { shopId: true, enabled: true, lastAttemptAt: true, attempts: true },
    });
    const byShop = new Map<string, AutoResumeSetting>(
      shopIds.map((id) => [id, MAI_SCELTO]),
    );
    for (const row of rows) {
      byShop.set(row.shopId, {
        enabled: row.enabled,
        lastAttemptAt: row.lastAttemptAt,
        attempts: row.attempts,
      });
    }
    return byShop;
  } catch (e) {
    if (tabellaAssente(e)) return null;
    console.error(
      '[auto-resume] scelte non leggibili:',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return null;
  }
}

/**
 * Il merchant ha acceso o spento l'interruttore.
 *
 * Restituisce `false` quando non c'e' dove scriverlo: chi chiama lo dice a
 * schermo invece di far credere che la scelta sia stata presa. Fingere di aver
 * salvato un "non toccare il mio database" sarebbe il peggiore degli esiti.
 */
export async function setAutoResumeEnabled(
  shopId: string,
  enabled: boolean,
): Promise<boolean> {
  try {
    await prisma.supabaseAutoResume.upsert({
      where: { shopId },
      create: { shopId, enabled },
      update: { enabled },
    });
    return true;
  } catch (e) {
    if (!tabellaAssente(e)) {
      console.error(
        '[auto-resume] scelta non salvata:',
        e instanceof Error ? e.message : 'errore sconosciuto',
      );
    }
    return false;
  }
}

/**
 * Ci siamo occupati di questo negozio adesso.
 *
 * Si scrive anche quando NON si e' chiesto niente a Supabase oltre allo stato:
 * e' proprio il negozio che risulta vivo, o che non torna su, quello che
 * altrimenti verrebbe interrogato a ogni giro del cron — cioe' ogni mezz'ora,
 * per sempre.
 */
export async function noteAutoResumeChecked(shopId: string, now: Date): Promise<void> {
  await scrivi(shopId, { lastAttemptAt: now }, { shopId, lastAttemptAt: now });
}

/**
 * Abbiamo chiesto noi la riattivazione.
 *
 * Il contatore sale qui e solo qui: e' il tetto ai tentativi per una stessa
 * pausa. `autoResumedAt` e' il fatto da raccontare al merchant, e il punto in
 * cui un giorno si aggancera' l'email.
 */
export async function noteAutoResumeRequested(shopId: string, now: Date): Promise<void> {
  await scrivi(
    shopId,
    { lastAttemptAt: now, attempts: { increment: 1 }, autoResumedAt: now },
    { shopId, lastAttemptAt: now, attempts: 1, autoResumedAt: now },
  );
}

/**
 * Ci abbiamo provato e Supabase ha detto di no.
 *
 * Il contatore sale lo stesso, ed e' la ragione per cui esiste: un rifiuto che
 * non conta lascerebbe l'app a bussare ogni sei ore per tutto il margine, che
 * e' un martellamento lento invece di una riprova. `autoResumedAt` no: non
 * abbiamo riacceso niente, e scriverlo vorrebbe dire dire al merchant una cosa
 * che non e' successa.
 */
export async function noteAutoResumeFailed(shopId: string, now: Date): Promise<void> {
  await scrivi(
    shopId,
    { lastAttemptAt: now, attempts: { increment: 1 } },
    { shopId, lastAttemptAt: now, attempts: 1 },
  );
}

/**
 * Il database e' tornato attivo: il budget dei tentativi si azzera.
 *
 * Una pausa successiva deve avere i suoi dieci tentativi, non gli avanzi della
 * precedente — altrimenti il secondo guaio, mesi dopo, troverebbe il contatore
 * gia' pieno e nessuno andrebbe a riaccendere niente.
 */
export async function resetAutoResumeAttempts(shopId: string, now: Date): Promise<void> {
  await scrivi(shopId, { attempts: 0, lastAttemptAt: now }, { shopId, attempts: 0, lastAttemptAt: now });
}

/**
 * La scrittura, con il solito riguardo: se la tabella non c'e' non succede
 * niente e nessuno fallisce. Queste righe servono al giro automatico, e un giro
 * che esplode su una tabella mancante porterebbe giu' anche il resto del cron.
 */
async function scrivi(
  shopId: string,
  update: Record<string, unknown>,
  create: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.supabaseAutoResume.upsert({
      where: { shopId },
      create: create as never,
      update: update as never,
    });
  } catch (e) {
    if (tabellaAssente(e)) return;
    console.error(
      '[auto-resume] memoria dei tentativi non aggiornata:',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
  }
}
