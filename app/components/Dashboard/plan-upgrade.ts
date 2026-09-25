import { planLabel } from './account-format';
import { samePlanName } from '~/lib/billing/plan-name';
import type { Dictionary } from '~/lib/i18n/context';

/** I soli pezzi di dizionario che servono qui. */
type Strings = Pick<Dictionary, 'syncCta' | 'planChange'>;

// `lastSyncedPlan` null significa "nessuna sync completata": e' il flusso normale
// di primo utilizzo, non un cambio di piano da segnalare.
export function hasPlanChanged(
  currentPlan: string,
  lastSyncedPlan: string | null,
): boolean {
  if (!lastSyncedPlan) return false;
  // Confronto insensibile a maiuscole e spazi: i due nomi vengono scritti in
  // momenti diversi, e una semplice differenza di scrittura ("growth" contro
  // "Growth") farebbe credere a un cambio di piano che non c'e' — con il banner
  // "Piano modificato" e il recupero che ripartono a ogni giro.
  return !samePlanName(currentPlan, lastSyncedPlan);
}


export interface SyncCta {
  label: string;
  disabled: boolean;
  loading: boolean;
}

/**
 * Stato del pulsante di sincronizzazione.
 *
 * Il caso che qui conta piu' degli altri: a piano cambiato NON si dice
 * "Sincronizzazione completata" — non lo e', c'e' un allineamento in corso — e
 * non si chiede un clic, perche' il recupero (nuovo tetto prodotti, tabella
 * clienti creata e popolata) parte da solo. Quando finisce, `planChanged` torna
 * falso e il pulsante si assesta da se'.
 */
export function syncCtaState(
  opts: {
    blocked: boolean;
    inProgress: boolean;
    completed: boolean;
    planChanged: boolean;
  },
  t: Pick<Dictionary, 'syncCta'>,
): SyncCta {
  if (opts.inProgress) {
    return { label: t.syncCta.running, disabled: true, loading: true };
  }
  // Il cambio di piano viene prima di tutto il resto: appena e' rilevato il
  // recupero parte da solo, quindi il pulsante non deve mai invitare a un clic —
  // nemmeno quando l'ultima corsa e' fallita e sembrerebbe "mai completata".
  if (opts.planChanged) {
    return { label: t.syncCta.updating, disabled: true, loading: true };
  }
  // Mai sincronizzato su questa connessione (anche dopo un ricollegamento):
  // qui il primo avvio resta manuale.
  if (!opts.completed) {
    return { label: t.syncCta.start, disabled: opts.blocked, loading: false };
  }
  return { label: t.syncCta.completed, disabled: true, loading: false };
}

// Finestra entro cui non si rinnesca il recupero: copre il tempo fra l'innesco
// e la comparsa del job "running", cosi' qualche ricarica ravvicinata della
// dashboard non fa partire piu' corse sovrapposte.
const CATCH_UP_COOLDOWN_MS = 60_000;

/**
 * Se innescare subito il recupero dopo un cambio di piano, invece di aspettare
 * il giro di sincronizzazione automatica.
 */
export function shouldTriggerPlanCatchUp(opts: {
  planChanged: boolean;
  syncInProgress: boolean;
  lastBulkStartedAt: Date | string | null;
  now?: number;
}): boolean {
  if (!opts.planChanged || opts.syncInProgress) return false;
  if (!opts.lastBulkStartedAt) return true;

  const now = opts.now ?? Date.now();
  const startedAt = new Date(opts.lastBulkStartedAt).getTime();
  if (Number.isNaN(startedAt)) return true;
  return now - startedAt >= CATCH_UP_COOLDOWN_MS;
}

// null = illimitato: per i confronti vale come infinito.
function cap(v: number | null): number {
  return v == null ? Number.POSITIVE_INFINITY : v;
}

function capLabel(v: number | null, t: Strings): string {
  return v == null ? t.planChange.capUnlimited : String(v);
}

// Il tetto detto per esteso, come si legge dentro una frase.
function capPhrase(v: number | null, t: Strings): string {
  return v == null ? t.planChange.capPhraseUnlimited : t.planChange.capPhrase(String(v));
}

/**
 * Pezzo di paragrafo. I messaggi non sono piu' solo stringhe perche' in qualche
 * punto una parte va in grassetto (il nuovo tetto), e il banner viene conservato
 * nel sessionStorage: deve restare fatto di dati, non di elementi React.
 */
export interface MessageSegment {
  text: string;
  bold?: boolean;
}

/** Paragrafo: una stringa quando e' tutto testo piano, a pezzi quando non lo e'. */
export type BannerMessage = string | MessageSegment[];

export interface PlanChangeBanner {
  tone: 'success' | 'warning';
  title: string;
  /** Un paragrafo per argomento: prodotti prima, clienti dopo. */
  messages: BannerMessage[];
}

/**
 * Che cosa comporta il piano attuale, nei termini che interessano al merchant:
 * quanti prodotti restano sincronizzabili e che fine fanno i clienti.
 *
 * La parte prodotti e' un confronto fra piani, quindi ha senso solo quando c'e'
 * davvero un passaggio da annunciare. La parte clienti guarda invece lo stato di
 * fatto — i clienti sono inclusi nel piano? esiste gia' la tabella? — perche'
 * l'avviso deve arrivare anche quando la sincronizzazione sotto il piano
 * precedente non era mai andata a buon fine e il confronto fra piani non
 * segnalerebbe nulla.
 *
 * Il tono e' warning appena qualcosa si restringe (tetto prodotti piu' basso o
 * clienti non piu' inclusi), success negli altri casi. `null` quando non c'e'
 * nulla da comunicare.
 */
export function planChangeBanner(opts: {
  planChanged: boolean;
  currentMax: number | null;
  previousMax: number | null;
  customersEnabled: boolean;
  /** La tabella dei clienti risulta gia' creata nel progetto del merchant. */
  customersTableCreated: boolean;
  /**
   * I clienti erano inclusi nel piano precedente. Null quando il piano
   * precedente non si conosce (primo utilizzo, oppure allineamento gia'
   * avvenuto): in quel caso non si annuncia nessuna ripresa, perche' non si sa
   * da dove si viene.
   */
  previousCustomersEnabled?: boolean | null;
  /**
   * Primo piano che rimetterebbe i clienti nella sincronizzazione (nome
   * tecnico). Null se non c'e' nulla da proporre: in quel caso la frase
   * sull'upgrade non compare.
   */
  customersUpgradePlan?: string | null;
}, t: Strings): PlanChangeBanner | null {
  const productsDowngrade = opts.planChanged && cap(opts.currentMax) < cap(opts.previousMax);
  // Clienti inclusi dal piano ma tabella ancora da creare: sta per essere
  // provveduta in automatico.
  const customersGained = opts.customersEnabled && !opts.customersTableCreated;
  // Clienti non piu' inclusi ma tabella gia' popolata: sync sospesa, dati fermi.
  const customersLost = !opts.customersEnabled && opts.customersTableCreated;
  // Clienti tornati nel piano con la tabella gia' li': non c'e' niente da
  // creare, ma la sincronizzazione riparte — ed e' proprio la notizia che il
  // merchant si aspetta dopo aver pagato l'upgrade. Senza questo caso il banner
  // parlerebbe solo del tetto prodotti, come se i clienti non fossero cambiati.
  const customersResumed =
    opts.planChanged &&
    opts.customersEnabled &&
    opts.customersTableCreated &&
    opts.previousCustomersEnabled === false;

  if (!opts.planChanged && !customersGained && !customersLost) return null;

  const messages: BannerMessage[] = [];

  // Scendere di piano perdendo i clienti e' l'unico caso in cui le due cose
  // vanno raccontate insieme: il merchant deve capire in una lettura sola cosa
  // cambia sul tetto prodotti, che i dati dei clienti restano dove sono, e come
  // tornare indietro. Due paragrafi separati lascerebbero il dubbio peggiore —
  // che i clienti gia' raccolti vengano cancellati.
  if (opts.planChanged && customersLost) {
    messages.push([
      { text: t.planChange.downgradeWithCustomers.before },
      { text: capPhrase(opts.currentMax, t), bold: true },
      { text: t.planChange.downgradeWithCustomers.after },
    ]);

    if (opts.customersUpgradePlan) {
      messages.push(t.planChange.upgradeBack(planLabel(opts.customersUpgradePlan)));
    }

    return { tone: 'warning', title: t.planChange.changedTitle, messages };
  }

  if (opts.planChanged) {
    messages.push(
      productsDowngrade
        ? t.planChange.productsDowngrade(capLabel(opts.currentMax, t))
        : t.planChange.productsUpdated(capLabel(opts.currentMax, t)),
    );
  }

  if (customersGained) {
    messages.push(t.planChange.customersGained);
  }

  if (customersResumed) {
    messages.push(t.planChange.customersResumed);
  }

  if (customersLost) {
    messages.push(t.planChange.customersLost);
  }

  const isDowngrade = productsDowngrade || customersLost;

  return {
    tone: isDowngrade ? 'warning' : 'success',
    title: isDowngrade ? t.planChange.changedTitle : t.planChange.updatedTitle,
    messages,
  };
}
