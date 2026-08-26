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

  return status === 'completed'
    ? t.dashboard.recentRuns.run.done
    : t.dashboard.recentRuns.run.running;
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
