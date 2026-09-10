# Worker Cloudflare

L'endpoint first-party del negozio, senza container e senza build.

**Serve:** il dominio del negozio su Cloudflare, e la chiave di lettura dalla
pagina Impostazioni dell'app.

## Installazione

1. **Prendi i due valori** da Impostazioni → Connessione e credenziali di
   tracking: l'indirizzo dell'app e la chiave di lettura.

2. **Apri `wrangler.toml`** e sostituisci `negozio.it` con il dominio vero, in
   tutte e tre le righe dove compare (`routes`, `zone_name`, `COOKIE_DOMAIN`).
   La rotta deve stare sul dominio da cui si vede la vetrina: e' l'unica cosa
   che renda first-party il cookie.

3. **Carica la chiave come segreto** — non nel file:

   ```bash
   npx wrangler secret put KERDON_TOKEN
   ```

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
   da server a server — e pianta il cookie `corew_eid` sul dominio del negozio,
   con `Secure`, `Path=/`, `SameSite=Lax` e un anno di durata richiesta.
4. **Se il permesso e' stato revocato**: fa scadere il cookie e dice a Kerdon di
   dimenticare quell'identificativo.

## Le variabili

| Nome | Dove | A cosa serve |
|---|---|---|
| `KERDON_URL` | `wrangler.toml`, `[vars]` | L'indirizzo dell'API. E' un parametro apposta: quando cambia si modifica qui. |
| `COOKIE_DOMAIN` | `wrangler.toml`, `[vars]` | Il dominio su cui piantare il cookie. Con il punto davanti vale anche per i sottodomini. |
| `KERDON_TOKEN` | segreto (`wrangler secret put`) | La chiave di lettura. Nel file finirebbe nel controllo di versione. |

Senza `KERDON_URL` o senza `KERDON_TOKEN` il Worker non chiama nessuno e
risponde `[]`: una configurazione incompleta non traccia a meta', non traccia.
