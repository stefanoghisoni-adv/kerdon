# Google Tag Manager server-side

L'endpoint first-party del negozio, come Client del container server-side.

**Serve:**

- un container server-side già attivo su un sottodominio del negozio (per
  esempio `sgtm.negozio.it` — non un indirizzo `*.run.app`, che non è
  first-party per nessuno);
- la **chiave di invio** del negozio, che si crea in Impostazioni → Connessione
  e credenziali di tracking.

Niente altro: nessun file da caricare sul container, nessuna variabile
d'ambiente da impostare. Il modello ha tre campi da compilare, e la chiave è uno
di quelli.

## Quale chiave, e dove si prende

L'app ne mostra due, e **qui ne va una sola**.

| Chiave | A cosa serve | Va nel container? |
|---|---|---|
| **di invio** — comincia con `kin_` | Dire a Kerdon chi sta visitando adesso: conia l'identificativo e scrive la riga | **Sì**, in questo campo |
| **di lettura** | Farsi restituire dati già raccolti, da un'altra applicazione | No |

La chiave di invio si crea in **Impostazioni → Connessione e credenziali di
tracking**, e si vede **una volta sola**, nel momento in cui la crei. Ha questa
forma:

```
kin_AbCdEf0123456789.XyZ987...
```

Si incolla **intera**, com'è, punto compreso. Se l'hai persa, non c'è modo di
rileggerla: se ne crea un'altra, e quella di prima continua a funzionare per due
giorni — il tempo di ripubblicare il container.

**L'errore che si fa più spesso è incollare l'altra chiave.** Sulle rotte che
scrivono serve la chiave di invio, e nient'altro: con la chiave di lettura il
server rifiuta la chiamata e non torna nessun identificativo. Il modello, in
anteprima, scrive una riga quando il valore non comincia con `kin_`. Se la vedi,
hai incollato la chiave sbagliata — ed è quasi sempre quello il motivo per cui
"non arriva niente".

## Installazione

1. **Crea la chiave di invio**, in Impostazioni → Connessione e credenziali di
   tracking. Tienila negli appunti: dalla pagina non si rilegge.

2. **Importa il modello.** Nel container server-side: Modelli → Modelli client →
   Nuovo → menu ⋮ → Importa, e scegli `kerdon-id-client.tpl`. Poi salva.

3. **Crea il client.** Client → Nuovo → scegli "Kerdon — Identificativo
   visitatore". Compila:

   | Campo | Valore |
   |---|---|
   | Percorso su cui rispondere | `/kerdon/id` |
   | Indirizzo dell'API | quello indicato in Impostazioni |
   | Chiave di invio (comincia con `kin_`) | la chiave intera, come l'app l'ha mostrata |
   | Dominio del negozio | `negozio.it`, senza `https://` |
   | Durata del cookie | `31536000` (un anno) |

   La priorità del client va lasciata sotto quella dei client di GA4 e di
   Shopify: risponde solo al proprio percorso, ma l'ordine evita sorprese.

4. **Pubblica il container.**

5. **Aggiungi lo script alla vetrina**, nel tema (`theme.liquid`, prima di
   `</head>`) o come tag personalizzato del tag manager web:

   ```html
   <script src="https://api.kerdon.io/tracking/bridge.js"
           data-kerdon-endpoint="https://sgtm.negozio.it/kerdon/id" async></script>
   ```

6. **Verifica**, dall'app: Impostazioni → Verifica installazione.

## Perché il sottodominio deve essere del negozio

Il cookie lo pianta il container, e vale per il dominio da cui il container
risponde. Se quel dominio non è quello della vetrina, il cookie è di terze parti
— cioè esattamente il cookie che i browser cancellano, e che questo giro esiste
per evitare. Un container su `sgtm.negozio.it` va bene; uno su un indirizzo di
Google Cloud no.

## Niente credenziali nel browser

La chiave sta in un campo del client, dentro il container, e da lì non esce: chi
apre gli strumenti di sviluppo su quel negozio non trova niente, perché niente è
mai passato di lì.

Questa rotta non si limita a leggere: **conia** l'identificativo del visitatore e
ne registra la riga. Finché per farlo bastava la chiave con cui si consultano i
dati, chi ne aveva una per guardare poteva anche scrivere. Adesso sono due
permessi distinti, con due credenziali che si ruotano e si revocano l'una senza
toccare l'altra: se la chiave di invio finisce nelle mani sbagliate la si revoca,
e chi legge i dati non se ne accorge nemmeno.

## La firma, per chi può farla

La chiave di invio presentata così com'è chiude la cosa che contava: chi legge
non scrive. Non chiude tutto. Il valore viaggia a ogni chiamata, e una richiesta
catturata si potrebbe rigiocare finché quella chiave vive — su TLS non è cosa da
poco, ma è una differenza vera, e vale la pena saperla.

C'è una forma più forte, ed è **firmare**: il segreto resta fermo dov'è, sul filo
passa solo il risultato di una HMAC, e ogni chiamata vale una volta sola. Il
server l'accetta e la preferisce. Questo modello però non la usa, e non per una
scelta di comodo: nel sandbox di Google Tag Manager `hmacSha256` non accetta un
segreto come stringa — vuole il nome di una chiave dichiarata in un file JSON che
il container deve avere sul disco, indicato da una variabile d'ambiente del
server. Su un container gestito quel file non si può mettere, e un modello che lo
pretendesse non sarebbe installabile dalla maggior parte dei negozi.

**Se non firmi non stai facendo niente di sbagliato**: è la strada prevista, ed è
quella che l'app verifica e supporta.

Firmare ha senso per chi ha già un pezzo di codice suo nella catena — un Worker
di Cloudflare o un endpoint proprio sul dominio del negozio, che di solito sta
già davanti al container — o un container che gestisce da sé, dove un file di
credenziali si può montare e un modello proprio si può scrivere. In quel caso la
firma si calcola su questa stringa, un pezzo per riga:

```
v1
ingest
ingest:identity
<millisecondi dall'epoch>
GET
/rest/v1/tracking_id
47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU
<una chiave di idempotenza diversa a ogni chiamata>
```

La settima riga è l'impronta SHA-256 del corpo in base64url: questa rotta si
chiama in GET e non porta corpo, quindi è quella della stringa vuota, sempre
uguale. La terza è l'ambito della rotta che si sta chiamando.

Il risultato è una HMAC-SHA256 in base64url, calcolata con il **segreto** della
chiave — la metà dopo il punto — e va nelle intestazioni `X-Kerdon-Key-Id` (la
metà prima del punto, senza `kin_`), `X-Kerdon-Timestamp`, `X-Kerdon-Signature`
(`v1=<firma>`) e `X-Kerdon-Idempotency-Key`. La firma vale cinque minuti attorno
al proprio istante, quindi l'orologio di chi firma deve essere all'ora giusta.

Le quattro intestazioni si mandano **al posto** della chiave nel campo `apikey`,
non insieme: chi manda `X-Kerdon-Key-Id` sta chiedendo la strada firmata, e da
quel momento le altre tre sono obbligatorie.
