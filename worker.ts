// worker.ts
//
// Il consumatore della coda per lo sviluppo locale.
//
// In produzione questo processo non esiste: su Vercel Free non ci sono processi
// long-running, e a drenare la coda e' la rotta `/api/cron/sync`. Qui serve
// perche' in locale nessun cron chiama quella rotta ogni trenta minuti, e
// aspettare a mano dopo ogni clic renderebbe impossibile lavorare.
//
// LA REGOLA CHE NON SI VIOLA: un consumatore alla volta. Prima erano due — un
// Worker BullMQ qui e il cron che chiamava i processor direttamente — e la
// coda non aveva nessuna presa, quindi potevano lavorare lo stesso job insieme.
// Adesso il consumatore e' uno solo (`drainSyncRequests`) e la presa e'
// atomica, ma la regola resta scritta: se questo processo gira e qualcuno
// chiama anche `/api/cron/sync`, i due si spartiscono il lavoro senza
// sovrapporsi — e va bene — mentre due implementazioni diverse dello stesso
// drenaggio, no.

import { drainSyncRequests } from './app/lib/queue/drain.server';

/** Ogni quanto si guarda se c'e' qualcosa da fare. */
const INTERVALLO_MS = 5_000;

console.log('Consumatore della coda avviato (sviluppo locale).');

const spegnimento = new AbortController();

for (const segnale of ['SIGTERM', 'SIGINT'] as const) {
  process.on(segnale, () => {
    if (spegnimento.signal.aborted) return;
    console.log(`${segnale} ricevuto: si finisce il giro e si esce.`);
    // Non si esce di colpo: il drenaggio in corso riceve il segnale, restituisce
    // alla coda quello che non ha lavorato e rilascia il lucchetto. Uscire qui
    // lascerebbe item 'processing' fermi fino alla scadenza del lease.
    spegnimento.abort(new Error(`${segnale}`));
  });
}

async function giro(): Promise<void> {
  while (!spegnimento.signal.aborted) {
    try {
      const esito = await drainSyncRequests({ signal: spegnimento.signal });
      if (esito.claimed > 0) {
        console.log(
          `Coda: presi ${esito.claimed}, conclusi ${esito.completed}, ` +
            `rimessi in coda ${esito.retried}, in lettera morta ${esito.deadLettered}.`,
        );
        for (const errore of esito.errors) console.warn(`  ${errore}`);
        // C'era lavoro: si riprova subito, senza aspettare. Con una coda piena
        // aspettare cinque secondi fra un item e l'altro sarebbe l'unica cosa
        // che rende lento lo sviluppo.
        continue;
      }
    } catch (error) {
      console.error('Errore nel drenaggio:', error);
    }

    await new Promise((risolvi) => setTimeout(risolvi, INTERVALLO_MS));
  }
}

void giro().then(() => {
  console.log('Consumatore fermato.');
  process.exit(0);
});
