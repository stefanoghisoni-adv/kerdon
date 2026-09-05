# La coda dei lavori sta su Postgres, non su Redis

Stato: **accettata** — 5 settembre 2026
Riguarda: `app/lib/queue/*`, `app/routes/api.cron.sync.tsx`, `worker.ts`,
tabelle `sync_requests` e `shop_locks`.

## In una riga

La coda dei lavori vive nel database owner con una presa atomica, perche' su
Vercel Free non gira nessun processo che possa fare da consumatore a BullMQ — e
una coda senza consumatore non e' una coda, e' un magazzino da cui si legge
senza prendere niente in mano.

## Il vincolo che impone la scelta

Il README lo dice fin dal principio: l'app sta su **Vercel Free**, dove non
esistono processi long-running. Non c'e' nessun Worker BullMQ in produzione, e
non ci puo' essere.

Da questo vincolo discendeva il modello precedente, che era questo:

```ts
const queued = await syncQueue.getJobs(['waiting', 'delayed'], 0, 20);
for (const job of queued) {
  ...
  await processManualSync(job.data.shopId, job);
  await job.remove();
}
```

Cioe': si leggevano i job in attesa e si chiamavano i processor a mano. BullMQ
faceva da deposito, non da coda.

## Cosa si rompeva

**Nessuna presa.** `getJobs()` legge, non prende possesso. Due drenaggi
simultanei — quello del cron ogni trenta minuti e quello che un gesto manuale
innesca subito, `triggerSyncDrain` — vedevano lo stesso job e lo lavoravano
tutti e due. Finche' il drenaggio lo faceva solo il cron la cosa non si vedeva;
da quando il pulsante ne innesca uno immediato, e' un caso concreto.

**Il danno non era un doppione innocuo.** La corsa completa, alla fine, spazza
dal database del merchant le righe con `synced_at` anteriore al proprio inizio:
e' cosi' che toglie i prodotti spariti da Shopify. Due corse sovrapposte hanno
due istanti d'inizio diversi, e la piu' vecchia porta via le righe che la piu'
recente ha appena scritto. Non lascia errori. Si vede dopo, come prodotti
mancanti.

**Il fallimento cancellava il lavoro.** Nel `catch` c'era `await job.remove()`.
Gli `attempts: 3` e il `backoff` esponenziale erano configurati con cura su
`defaultJobOptions` — e non li applicava nessuno, perche' li applica il Worker,
che non esisteva. Un errore di rete di due secondi perdeva una sincronizzazione
per sempre.

**Il lucchetto era fail-open.** `withShopSyncLock` aveva una TTL fissa di dieci
minuti che nessuno rinnovava, e se Redis non rispondeva proseguiva senza
lucchetto — scritto e motivato cosi': "un negozio che non si sincronizza e' un
guasto certo; due corse sovrapposte sono un rischio". Il paragone e' sbagliato
nel modo piu' costoso: pesa una sincronizzazione rimandata contro delle righe
cancellate nel database di un merchant.

**I tipi sconosciuti restavano in attesa per sempre.** Il drenaggio, davanti a
un tipo che non riconosceva, faceva `continue`. L'item restava `waiting` e non
c'era niente da guardare per accorgersene.

## La decisione

1. **Una tabella `sync_requests` nel database owner**, con `dedupKey` unico,
   `attempts`, `nextAttemptAt`, `leaseOwner`, `leaseExpiresAt`, `fencingToken`,
   `lastError` redatto.

2. **La presa e' una sola istruzione SQL**:
   `UPDATE ... WHERE id IN (SELECT ... ORDER BY ... LIMIT n FOR UPDATE SKIP LOCKED) RETURNING ...`.
   Un'istruzione sola, e non una transazione a piu' giri, perche' `DATABASE_URL`
   punta al **pooler di Supabase in transaction mode**: li' una sessione non e'
   di nessuno fra una query e l'altra. `SKIP LOCKED` fa il resto — due drenaggi
   che partono insieme non si aspettano, si dividono il lavoro.

3. **Ogni scrittura porta il gettone.** Chiusura, riprogrammazione, lettera
   morta e battito hanno `id + leaseOwner + fencingToken` nella `WHERE`. Se il
   gettone non e' piu' il nostro l'aggiornamento tocca zero righe, e chi ha
   chiamato lo sa. E' quello che impedisce a un processo sopravvissuto a un
   deploy di dichiarare completato un lavoro che sta facendo qualcun altro.

4. **Un item fallito non si cancella mai.** Torna in coda con `nextAttemptAt`
   spostato in avanti (esponenziale con jitter), e solo dopo il quinto tentativo
   va in `dead_letter` — con una riga di log che comincia per ALLARME e il
   comando per farlo ripartire (`npm run queue:replay -- <id>`).

5. **Il lucchetto per negozio e' fail-closed**, ed e' anch'esso una riga su
   Postgres (`shop_locks`): presa condizionata alla scadenza, rinnovata da un
   battito, con un gettone che cresce a ogni presa. Se il database non risponde
   non si prende, e chi non prende non lavora: il lavoro torna in coda.

6. **Le scritture distruttive verificano il possesso** (`lease.assertHeld()`)
   un istante prima di partire: la spazzata dei prodotti obsoleti, la
   riconciliazione delle varianti, il `DROP TABLE` dello scollegamento, la
   cancellazione di un cliente per GDPR.

7. **Il tipo sconosciuto e' rifiutato all'accodamento**, con un allarme. Se una
   riga con un tipo ignoto arriva comunque — scritta da un'altra versione
   dell'app — finisce in lettera morta, non in attesa.

## Perche' non un advisory lock di Postgres

Era l'alternativa naturale, ed e' inutilizzabile qui.

`pg_advisory_lock` e' **di sessione**, e con il pooler in transaction mode la
sessione cambia fra una query e l'altra: il lucchetto verrebbe preso su una
connessione e rilasciato — o, peggio, non rilasciato — su un'altra.

`pg_advisory_xact_lock` vive quanto la transazione, e una sincronizzazione dura
minuti: non si tiene aperta una transazione del pooler per tutto quel tempo.

Una riga con una scadenza non ha nessuno dei due problemi. In piu' la si puo'
guardare — `SELECT * FROM shop_locks` risponde a "chi sta lavorando su cosa",
che a un advisory lock non si chiede.

## Perche' non tenere BullMQ e aggiungerci la presa

Perche' vorrebbe dire **due consumatori sullo stesso nome di coda**, ed e'
esattamente il guasto da cui si parte. Non c'e' modo di far coesistere un Worker
BullMQ e un drenaggio a chiamata sulla stessa coda senza che, in qualche
finestra, lavorino lo stesso item: le due prese vivrebbero su due sistemi
diversi che non si parlano.

Quindi:

- **BullMQ non e' piu' una dipendenza della coda.** `queues.server.ts`,
  `scheduler.server.ts` e la rotta `api.cron.schedule-syncs.tsx` (che
  registrava job ripetibili che nessuno avrebbe consumato) sono stati rimossi.
- **`worker.ts` resta**, ma consuma la coda su Postgres: e' lo stesso
  `drainSyncRequests` della rotta cron, in un ciclo. Serve in locale, dove
  nessun cron chiama `/api/cron/sync` ogni trenta minuti.
- **Redis resta**, ma solo per quello che gia' faceva bene e che non e' una
  coda: la cache delle statistiche (`app/lib/cache/stats-cache.server.ts`).

## Il vincolo che resta, e che va rispettato

**Un consumatore alla volta per la coda.** Oggi l'implementazione e' una sola
(`drainSyncRequests`) e puo' girare in piu' invocazioni insieme senza danno,
perche' la presa e' atomica e il lucchetto e' fail-closed. Quello che non deve
tornare mai e' una **seconda implementazione** del drenaggio — un Worker, uno
script, una rotta che chiama i processor direttamente — che non passi per
`claim`.

Il momento in cui questo vincolo si viola e' una migrazione fatta a meta': la
procedura per cambiare consumatore sta in `docs/database-migrations.md`, sotto
"Cambiare il consumatore della coda".

## Cosa si e' rinunciato ad avere

- **La latenza sotto il secondo.** Una coda su Redis con un Worker in ascolto
  parte subito; questa parte al prossimo drenaggio. In pratica non cambia
  niente, perche' il drenaggio lo innesca gia' il gesto manuale
  (`triggerSyncDrain`) e il cron ci ripassa ogni trenta minuti.
- **La ripetizione automatica** dei job ripetibili di BullMQ. La cadenza dei
  controlli periodici la calcola il cron dal piano del negozio, come faceva gia'
  in produzione: i job ripetibili erano codice che girava solo in locale.
- **Le dashboard di BullMQ.** Al loro posto ci sono due tabelle interrogabili e
  `npm run queue:replay`, che elenca cosa e' fermo.

## Il costo sul database owner

Una riga per lavoro, potata dopo sette giorni per le concluse (le morte
restano: sono l'unica traccia di un lavoro non fatto). Una riga per negozio
nella tabella dei lucchetti, viva quanto la corsa. Su un piano Supabase Free,
per un'app con un numero di negozi nell'ordine delle decine, e' rumore.
