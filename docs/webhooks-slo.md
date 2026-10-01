# SLO dei webhook (Service Level Objective)

## Tempo di elaborazione webhook

Questo documento definisce i tempi attesi per l'elaborazione dei webhook ricevuti da Shopify, con particolare attenzione a ordini e rimborsi.

### Scenario normale (con waitUntil)

Su Vercel, quando la funzione serverless riceve un webhook:

1. **Ricevuta immediata** (< 500ms): il webhook viene verificato, la ricevuta viene scritta nel database owner e Shopify riceve il 200 OK
2. **Elaborazione immediata** (1-5 secondi): l'elaborazione inizia subito dopo l'ack e continua grazie a `waitUntil` di `@vercel/functions`, che tiene viva la funzione finché l'elaborazione non termina
3. **Risultato**: l'ordine/rimborso appare nel database del merchant entro pochi secondi dalla vendita

**Tempo atteso normale**: 1-5 secondi dall'evento alla sincronizzazione completata.

### Scenario di fallback (terminazione anticipata o errore)

Se Vercel termina la funzione prima che l'elaborazione finisca, o se l'elaborazione fallisce per un errore transitorio (rete, database non disponibile):

1. **Terminazione prima dell'elaborazione**: la ricevuta resta `queued` con `nextAttemptAt` immediato
2. **Terminazione durante l'elaborazione** (claim già avvenuto): la riga resta `processing` con `startedAt` vecchio; dopo 5 minuti (WEBHOOK_STALE_MS) il cron la riporta a `queued` e la rilavorala
3. **Errore transitorio**: la riga torna `queued` con `nextAttemptAt` distanziato secondo backoff esponenziale (1min, 2min, 5min, 15min, 30min per i primi 5 tentativi)
4. Il cron di drenaggio (`/api/cron/sync`) la recupera quando `nextAttemptAt` è scaduto

**Obiettivo tipico**: recupero entro 30 minuti (cron GitHub Actions ogni */30 min, best-effort)  
**Limite rigido**: entro 24 ore (Vercel Cron giornaliero `0 3 * * *` UTC, garantito dalla piattaforma)  
**Eventi falliti**: dopo 5 tentativi (circa 50 minuti di backoff cumulativo), lo stato diventa `dead_letter` e viene segnalato

### Eventi operativi coperti

- `orders/create`, `orders/updated`, `refunds/create`: nuovi ordini e cambiamenti a ordini esistenti
- `orders/delete`: cancellazione ordini (raro)
- `returns/*`: resi che cambiano il costo dell'ordine
- `products/*`, `customers/*`: aggiornamenti di prodotti e clienti

### Eventi amministrativi

- `app/uninstalled`, `app_subscriptions/update`: elaborazione immediata, stesso SLO

### Cosa succede se Vercel termina la funzione

**Prima del 200 OK**: impossibile — la ricevuta viene scritta *prima* di rispondere, quindi se la funzione muore prima del 200, Shopify ritenta.

**Dopo il 200 OK, senza waitUntil**: la funzione può terminare immediatamente. La ricevuta resta `queued` e il cron la recupera (obiettivo 30min, max 24h).

**Dopo il 200 OK, con waitUntil** (implementazione attuale): Vercel sa che la promise deve finire e tiene viva la funzione. Se la funzione viene comunque terminata (deploy, timeout di piattaforma):
- Se il claim non era ancora avvenuto: ricevuta `queued`, recupero al prossimo cron
- Se il claim era in corso: ricevuta `processing`, ripresa dopo 5 minuti di inattività (WEBHOOK_STALE_MS)

### Idempotenza e deduplica

- Ogni consegna ha un `X-Shopify-Webhook-Id` univoco
- Le consegne duplicate (stesso ID) producono una sola riga nel database
- La "presa" (`updateMany` da `queued` a `processing` con condizione sullo stato) protegge dall'elaborazione doppia
- Due lavorazioni simultanee della stessa riga: la seconda aggiorna zero righe e si ferma

### Monitoraggio

- **Ricevute non lavorate**: contare le righe `queued` o `processing` con `nextAttemptAt` (per queued) o `startedAt` (per processing) scaduti
- **Eventi fermi**: righe in stato `dead_letter` dopo troppi tentativi falliti
- **Budget esaurito**: flag `webhookDrainBudgetExhausted` nella risposta del cron — vero una volta ogni tanto è normale (arretrato in smaltimento), vero sempre significa che gli eventi arrivano più velocemente di quanto si riescano a lavorare

### Comportamento in ambienti diversi

- **Vercel Production**: `waitUntil` attivo, elaborazione immediata standard
- **Vercel Preview**: `waitUntil` attivo, stesso comportamento di production
- **Sviluppo locale**: `waitUntil` non disponibile, degrade silenzioso — l'elaborazione parte e finisce lo stesso perché il processo locale vive finché non lo si ferma
- **Test (vitest)**: `waitUntil` mockabile, il lavoro resta tracciato in `inVolo` e `settleWebhookWork()` lo aspetta
- **Worker dedicato** (se mai deploy su ambiente con worker persistenti): `waitUntil` non necessario, il worker drena continuamente la coda

### Risoluzione problemi comuni

**Ordini che impiegano mezz'ora ad apparire**:
- Verificare che il cron stia girando regolarmente (GitHub Actions ogni 30min)
- Esaminare la colonna `lastError` e `nextAttemptAt` delle righe `queued`
- Controllare righe `processing` con `startedAt` oltre 5 minuti fa (invocazioni terminate mid-work)

**Eventi in `dead_letter`**:
- Errore di configurazione o dati non validi
- Replay manuale: `npm run webhooks:replay -- <event-id>`
- Gli eventi in lettera morta NON vengono cancellati automaticamente — sono l'unica traccia di un evento non applicato

**`webhookDrainBudgetExhausted` sempre true**:
- Arretrato importante, o eventi che arrivano troppo velocemente
- Il drenaggio ha un tetto di tempo (20 secondi) per non bloccare il resto del giro del cron
- Aumentare la frequenza del cron o investigare perché l'elaborazione è lenta
