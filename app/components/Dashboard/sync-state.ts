export type SyncState = 'idle' | 'in_progress' | 'completed' | 'failed';

interface JobLike {
  status: string;
  startedAt: Date | string;
}

/**
 * Stato della sincronizzazione iniziale/manuale, LEGATO ALLA CONNESSIONE CORRENTE.
 *
 * Prende in ingresso l'ULTIMA corsa completa del negozio, non un elenco da
 * filtrare. La differenza non e' di stile: prima questa funzione riceveva le
 * ultime dieci righe di `sync_job` di qualunque tipo e ci cercava dentro il
 * bulk piu' recente. Su un piano che sincronizza spesso, dieci controlli
 * periodici bastavano a spingere il bulk fuori da quella finestra, e da quel
 * momento la dashboard si comportava come se una sincronizzazione completa non
 * fosse mai avvenuta. Chiedere direttamente l'ultimo bulk rende quell'errore
 * impossibile da commettere di nuovo.
 *
 * Vale solo se avviata a partire da `connectionVerifiedAt`: cosi',
 * disconnettendo e ricollegando (anche a un progetto diverso o vuoto), la corsa
 * della connessione precedente non conta piu' e il pulsante torna abilitato.
 *
 * `failed` e' uno stato a se' e non un ripiego su `idle`. Una corsa fallita non
 * e' una corsa mai avvenuta: chi guarda deve poterlo sapere, e chi aspetta deve
 * poter smettere di aspettare.
 */
export function resolveSyncState(
  latestBulk: JobLike | null | undefined,
  connectionVerifiedAt: Date | string | null | undefined,
): SyncState {
  if (!connectionVerifiedAt || !latestBulk) return 'idle';

  const connectedAt = new Date(connectionVerifiedAt).getTime();
  if (new Date(latestBulk.startedAt).getTime() < connectedAt) return 'idle';

  if (latestBulk.status === 'running') return 'in_progress';
  if (latestBulk.status === 'completed') return 'completed';
  if (latestBulk.status === 'failed') return 'failed';
  return 'idle';
}
