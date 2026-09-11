# Worker Cloudflare

L'endpoint first-party del negozio, senza container e senza build.

**Serve:** il dominio del negozio su Cloudflare, e le due credenziali dalla
pagina Impostazioni dell'app — la chiave di lettura e quella di invio.

## Installazione

1. **Prendi i valori** da Impostazioni → Connessione e credenziali di
   tracking: l'indirizzo dell'app, la chiave di lettura, e la **chiave di
   invio** (il pulsante "Crea la chiave di invio").

   La chiave di invio si vede **una volta sola**, nel momento in cui la crei.
   Copiala prima di chiudere la schermata: se la perdi ne crei un'altra, e
   quella di prima continua a funzionare per due giorni — il tempo di
   ripubblicare il Worker.

2. **Apri `wrangler.toml`** e sostituisci `negozio.it` con il dominio vero, in
   tutte e tre le righe dove compare (`routes`, `zone_name`, `COOKIE_DOMAIN`).
   La rotta deve stare sul dominio da cui si vede la vetrina: e' l'unica cosa
   che renda first-party il cookie.

3. **Carica le chiavi come segreti** — non nel file:

   ```bash
   npx wrangler secret put KERDON_TOKEN            # la chiave di lettura
   npx wrangler secret put KERDON_INGEST_KEY_ID    # la prima meta di quella di invio
   npx wrangler secret put KERDON_INGEST_SECRET    # la seconda meta
   ```

   La chiave di invio e' fatta di due pezzi separati da un punto
   (`kin_<identificativo>.<segreto>`): il pezzo prima del punto va in
   `KERDON_INGEST_KEY_ID`, quello dopo in `KERDON_INGEST_SECRET`.

4. **Pubblica:**

   ```bash
   npx wrangler deploy
   ```

5. **Aggiungi lo script alla vetrina**, nel tema (`theme.liquid`, prima di
   `</head>`) o come tag personalizzato del tag manager:

   ```html
   <script src="https://api.kerdon.io/tracking/bridge.js"
           data-kerdon-endpoint="https://negozio.it/kerdon/id" async></script>
   ```

6. **Verifica**, dall'app: Impostazioni → Verifica installazione.

## Cosa fa, in ordine

1. Legge cosa ha risposto il visitatore — dal parametro che manda lo script
   della vetrina, dal cookie di consenso di Shopify, o dal cookie che lo script
   scrive. Il primo che dice qualcosa vince.
2. **Se non c'e' nessun segnale**: risponde `[]` e finisce li'. Nessuna
   chiamata, nessun cookie.
3. **Se c'e' il permesso**: chiede l'identificativo a Kerdon con la chiave —
   da server a server — e pianta il cookie `kerdon_eid` sul dominio del negozio,
   con `Secure`, `Path=/`, `SameSite=Lax` e un anno di durata richiesta.
4. **Se il permesso e' stato revocato**: fa scadere il cookie e dice a Kerdon di
   dimenticare quell'identificativo.

## Le variabili

| Nome | Dove | A cosa serve |
|---|---|---|
| `KERDON_URL` | `wrangler.toml`, `[vars]` | L'indirizzo dell'API. E' un parametro apposta: quando cambia si modifica qui. |
| `COOKIE_DOMAIN` | `wrangler.toml`, `[vars]` | Il dominio su cui piantare il cookie. Con il punto davanti vale anche per i sottodomini. |
| `KERDON_TOKEN` | segreto (`wrangler secret put`) | La chiave di lettura. Nel file finirebbe nel controllo di versione. |
| `KERDON_INGEST_KEY_ID` | segreto | L'identificativo della chiave di invio. Non e' segreto di per se', ma sta con l'altro pezzo. |
| `KERDON_INGEST_SECRET` | segreto | Il segreto di invio. **Non viaggia mai**: il Worker lo usa per calcolare una firma, ed e' la firma che parte. |

Senza `KERDON_URL` o senza `KERDON_TOKEN` il Worker non chiama nessuno e
risponde `[]`: una configurazione incompleta non traccia a meta', non traccia.

## Perche' le credenziali sono due

Questa rotta non si limita a leggere: **conia** l'identificativo del visitatore e
ne registra la riga nel database del negozio. Finche' bastava la chiave di
lettura, chiunque l'avesse per farsi restituire i dati poteva anche riempire
quelle tabelle — e dichiarare che un browser qualsiasi appartiene a un cliente
qualsiasi. Adesso leggere e scrivere sono due permessi distinti, con due
credenziali che si ruotano e si revocano l'una senza toccare l'altra.

**Fino al 1 dicembre 2026** un Worker con la sola `KERDON_TOKEN` continua a
funzionare: e' il tempo per aggiornare le installazioni esistenti. Da quella
data, senza chiave di invio la chiamata viene rifiutata. Se la tua installazione
e' ancora indietro lo vedi in Impostazioni, molto prima che smetta di
funzionare.
