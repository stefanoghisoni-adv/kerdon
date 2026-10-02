# SLO dei webhook (Service Level Objective)

## Tempo di elaborazione webhook

Questo documento definisce i tempi attesi per l'elaborazione dei webhook ricevuti da Shopify, con particolare attenzione a ordini e rimborsi.

### Scenario normale (con waitUntil)

Su Vercel, quando la funzione serverless riceve un webhook:

1. **Ricevuta immediata**: il webhook viene verificato, la ricevuta viene scritta nel database owner e Shopify riceve il 200 OK (obiettivo: p95 < `WEBHOOK_RESPONSE_TARGET_MS` = 1s, limite duro: < `WEBHOOK_RESPONSE_HARD_LIMIT_MS` = 5s)
2. **Elaborazione immediata**: l'elaborazione inizia subito dopo l'ack e continua grazie a `waitUntil` di `@vercel/functions`, che tiene viva la funzione finché l'elaborazione non termina
3. **Risultato**: l'ordine/rimborso appare nel database del merchant entro pochi secondi dalla vendita (tempo stimato: pochi secondi, variabile in base al carico di Shopify API e database merchant)

### Scenario di fallback (terminazione anticipata o errore)

Se Vercel termina la funzione prima che l'elaborazione finisca, o se l'elaborazione fallisce per un errore transitorio (rete, database non disponibile):

1. **Terminazione prima dell'elaborazione**: la ricevuta resta `queued` con `nextAttemptAt` immediato
2. **Terminazione durante l'elaborazione** (claim già avvenuto): la riga resta `processing` con `startedAt` vecchio; dopo `WEBHOOK_STALE_MS` = 5 minuti il cron la riporta a `queued` e la rilavorala
3. **Errore transitorio**: la riga torna `queued` con `nextAttemptAt` distanziato secondo backoff esponenziale
4. Il cron di drenaggio (`/api/cron/sync`) la recupera quando `nextAttemptAt` è scaduto

**Backoff esponenziale** (`nextWebhookAttemptAt`, inbox-model.ts):
- Formula: `WEBHOOK_BACKOFF_BASE_MS` (1 min) × 2^(attempts-1), tetto `WEBHOOK_BACKOFF_MAX_MS` (30 min)
- Tentativo 1 fallisce → attesa 1 min
- Tentativo 2 fallisce → attesa 2 min
- Tentativo 3 fallisce → attesa 4 min
- Tentativo 4 fallisce → attesa 8 min
- Tentativo 5 fallisce → `dead_letter` (nessuna 5ª attesa, `MAX_WEBHOOK_ATTEMPTS` = 5)
- Backoff cumulativo: 1+2+4+8 = 15 minuti

**Cron schedules**:
- GitHub Actions: `*/30 * * * *` (ogni 30 minuti, best-effort)
- Vercel Cron: `0 3 * * *` (giornaliero alle 3am UTC, garantito dalla piattaforma)

**Tempi di recupero**:
- **Primo tentativo fallito**: recupero al prossimo cron (obiettivo ~30min con GitHub Actions, limite rigido 24h se solo Vercel Cron)
- **Tentativi successivi**: backoff + cron successivo
  - Con GitHub Actions (ogni 30min): ogni retry aspetta backoff + ~0-30min → ~2 ore totali per 4 retry
  - Solo Vercel Cron (giornaliero): ogni retry aspetta backoff + ~0-24h → fino a ~4 giorni per 4 retry
- **Eventi esauriti**: dopo `MAX_WEBHOOK_ATTEMPTS` = 5 tentativi falliti (15 min di backoff + attese cron), lo stato diventa `dead_letter` e viene segnalato

### Eventi operativi coperti

- `orders/create`, `orders/updated`, `refunds/create`: nuovi ordini e cambiamenti a ordini esistenti
- `orders/delete`: cancellazione ordini (raro)
- `returns/*`: resi che cambiano il costo dell'ordine
- `products/*`, `customers/*`: aggiornamenti di prodotti e clienti

### Eventi amministrativi

- `app/uninstalled`, `app_subscriptions/update`: elaborazione immediata, stesso SLO

### Limiti di durata delle funzioni

Le funzioni webhook in `vercel.json` **non dichiarano** `maxDuration`. Vale quindi
il limite di default del progetto Vercel.

**Come verificare il limite attuale**:
- `vercel inspect <url-deployment>` mostra i limiti di tutte le funzioni
- Dashboard Vercel → Progetto → Settings → Functions → Max Duration

**Limite tipico** (Hobby/Pro senza override): 10 secondi per funzione serverless.

**Cosa succede se il limite viene superato**:
- Vercel termina forzatamente la funzione, anche se `waitUntil` è in corso
- La ricevuta rimane nello stato in cui si trovava:
  - Se il claim non era ancora avvenuto: ricevuta `queued`, recupero al prossimo cron
  - Se il claim era in corso: ricevuta `processing`, ripresa dopo 5 minuti (`WEBHOOK_STALE_MS`)
- Il cron di drenaggio (`/api/cron/sync`) riprende il lavoro dalla riga lasciata indietro

**Nota**: l'elaborazione webhook è progettata per non dipendere da `maxDuration`
lungo. La scrittura della ricevuta + ack è sotto 1 secondo (target), e `waitUntil`
tiene viva la funzione solo se l'elaborazione finisce nel limite di piattaforma.
L'arretrato viene smaltito dal cron.

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
