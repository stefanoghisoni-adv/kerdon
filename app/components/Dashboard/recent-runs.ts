import { syncStatusBadge, tableCreationMessage, type StatusBadge } from './sync-log-format';
import type { Dictionary } from '~/lib/i18n/context';

/**
 * Le ultime corse, come si leggono nella card della dashboard.
 *
 * Logica pura, senza componenti: qui si decide cosa dice ogni riga, e il test
 * lo verifica senza montare niente.
 */

/** Quanto della corsa serve per scriverne una riga. */
export interface RecentRunInput {
  id: string;
  jobType: string;
  status: string;
  /** Data in ISO: la formattazione vuole il fuso del negozio e sta nel componente. */
  startedAt: string;
}

export interface RecentRunRow {
  id: string;
  badge: StatusBadge;
  /** Cosa e' successo, in tre parole. */
  label: string;
  startedAt: string;
}

/**
 * Le richieste GDPR non compaiono: arrivano da Shopify, non sono
 * sincronizzazioni, e in un riquadro che si intitola "Ultime sincronizzazioni"
 * sarebbero fuori posto. Nel registro completo restano.
 */
const HIDDEN_JOB_TYPES = new Set([
  'gdpr_data_request',
  'gdpr_redact',
  'gdpr_shop_redact',
]);

/**
 * Come si chiama, per il merchant, una corsa.
 *
 * Due titoli in tutto, piu' quello della creazione tabelle. Prima erano quattro
 * — "Sincronizzazione completa", "Aggiornamento periodico", "Aggiornamento da
 * Shopify", "Sincronizzazione" — e distinguevano cose che al merchant non
 * servono: da Shopify arriva tutto, e che la corsa sia partita da un orario o
 * da un webhook e' una faccenda nostra. Per lui e' sempre la stessa cosa, i
 * suoi dati che si allineano.
 *
 * Il titolo dice "completata" solo quando lo e' davvero: accanto c'e' il badge
 * con lo stato, e un titolo che promette successo sopra un badge rosso si legge
 * come un errore dell'app.
 */
export function recentRunLabel(jobType: string, status: string, t: Dictionary): string {
  // Le creazioni di tabella hanno gia' una frase loro, la stessa del registro:
  // due modi di dire la stessa cosa nelle due pagine sarebbero uno di troppo.
  const creation = tableCreationMessage(jobType, t);
  if (creation) return creation;

  if (status === 'completed') return t.dashboard.recentRuns.run.done;
  // Parziale ha un titolo suo: "Sincronizzazione" e basta si legge come una
  // corsa ancora in viaggio, e questa invece e' finita lasciando indietro
  // qualcosa. Il badge accanto dice lo stato, il titolo dice cos'e' successo.
  if (status === 'completed_with_repairs') return t.dashboard.recentRuns.run.partial;
  return t.dashboard.recentRuns.run.running;
}

/**
 * I tipi di corsa di cui parla l'avviso di sincronizzazione.
 *
 * Solo la corsa completa: e' quella che il pulsante "Sincronizzazione manuale"
 * fa partire (il lavoro manuale riusa la stessa procedura del primo
 * allineamento, e scrive `initial_bulk`). I controlli periodici sono lavoro
 * automatico, vivono per conto loro e questa funzione non li tocca.
 */
const BULK_JOB_TYPES = new Set(['initial_bulk']);

/** L'id della riga che rappresenta il lavoro chiesto ma non ancora partito. */
export const PENDING_RUN_ID = 'pending-sync';

/**
 * La card e l'avviso, tenuti d'accordo per costruzione.
 *
 * IL DIFETTO CHE QUESTA FUNZIONE CHIUDE. Fra il clic sul pulsante e l'effettiva
 * partenza del lavoro non esiste ancora nessuna riga in `sync_job`: in cima
 * alla card restava quindi la corsa PRECEDENTE, gia' chiusa, con il badge
 * "Completato", mentre l'avviso sopra diceva che si stava lavorando. Il
 * merchant leggeva due cose opposte nella stessa schermata e non aveva modo di
 * sapere quale credere.
 *
 * LA SOLUZIONE, E PERCHE' QUESTA. Si poteva nascondere la corsa precedente, ma
 * cancellare un'informazione vera per non contraddirne un'altra e' il rimedio
 * peggiore del male: quella corsa e' avvenuta, ed e' l'unica cosa che il
 * merchant ha da guardare mentre aspetta. Si antepone invece una riga che dice
 * quel che sta succedendo davvero — c'e' una sincronizzazione chiesta e non
 * ancora conclusa — datata al momento in cui e' stata chiesta.
 *
 * E la simmetria conta quanto il resto: a lavoro NON in volo, una riga rimasta
 * su 'running' non e' "in corso", e' un'invocazione stroncata che non ha fatto
 * in tempo a riscriversi. Tenerla farebbe dire alla card l'esatto contrario
 * dell'avviso, che e' il disaccordo da cui tutto questo e' partito; quindi si
 * toglie. Nel registro completo resta, perche' li' una corsa appesa e'
 * un'informazione utile — qui, dove la domanda e' una sola ("sta girando
 * adesso?"), sarebbe una risposta sbagliata.
 *
 * Il risultato e' che la card mostra una corsa completa in corso SE E SOLO SE
 * l'avviso e' acceso: nascono dallo stesso valore e non possono divergere.
 */
export function withPendingRun(
  runs: RecentRunInput[],
  pending: { since: string } | null,
): RecentRunInput[] {
  const inCorso = runs.some(
    (run) => BULK_JOB_TYPES.has(run.jobType) && run.status === 'running',
  );

  if (!pending) {
    return inCorso
      ? runs.filter((run) => !(BULK_JOB_TYPES.has(run.jobType) && run.status === 'running'))
      : runs;
  }

  // La riga vera c'e' gia': e' migliore di quella sintetica — ha l'id del job e
  // l'ora d'inizio esatta — e non va raddoppiata.
  if (inCorso) return runs;

  return [
    {
      id: PENDING_RUN_ID,
      jobType: 'initial_bulk',
      status: 'running',
      startedAt: pending.since,
    },
    ...runs,
  ];
}

/**
 * Le righe da mostrare, al massimo `limit`.
 *
 * L'ordine arriva gia' fatto da chi legge il database (dalla piu' recente): qui
 * si filtra e si taglia, non si riordina.
 */
export function recentRunRows(
  runs: RecentRunInput[],
  t: Dictionary,
  limit = 5,
): RecentRunRow[] {
  return runs
    .filter((run) => !HIDDEN_JOB_TYPES.has(run.jobType))
    .slice(0, limit)
    .map((run) => ({
      id: run.id,
      badge: syncStatusBadge(run.status, t),
      label: recentRunLabel(run.jobType, run.status, t),
      startedAt: run.startedAt,
    }));
}
