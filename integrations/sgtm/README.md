# Google Tag Manager server-side

L'endpoint first-party del negozio, come Client del container server-side.

**Serve:**

- un container server-side già attivo su un sottodominio del negozio (per
  esempio `sgtm.negozio.it` — non un indirizzo `*.run.app`, che non è
  first-party per nessuno);
- la possibilità di aggiungere **una chiave nel file di credenziali del
  container**. È il punto che decide se questa strada è percorribile: se il tuo
  provider non te lo lascia fare, leggi [Se il container non può
  firmare](#se-il-container-non-può-firmare) prima di cominciare.

## Le due metà della chiave di invio

La chiave di invio si vede **una volta sola**, quando la crei in Impostazioni, e
ha questa forma:

```
kin_AbCdEf0123456789.XyZ987...
    └──────┬───────┘ └───┬───┘
     identificativo   segreto
```

Le due metà vanno in due posti diversi, e non è burocrazia:

| Metà | Dove va | Perché |
|---|---|---|
| **identificativo** (prima del punto, senza `kin_`) | nel campo del client | Non è segreto: dice solo quale credenziale usare. Viaggia in chiaro a ogni chiamata. |
| **segreto** (dopo il punto) | nel file di credenziali del container | Non entra in nessun campo, non esce dal container e non viaggia mai. Serve a **calcolare una firma**, ed è la firma che parte. |

## Installazione

1. **Metti il segreto nel file di credenziali del container.** È un file JSON,
   indicato dalla variabile d'ambiente `SGTM_CREDENTIALS`, con questa forma:

   ```json
   {
     "keys": {
       "kerdon_ingest": "<il segreto, codificato in base64>"
     }
   }
   ```

   Il nome `kerdon_ingest` non è a scelta: è quello che il modello chiede, e
   dev'essere scritto esattamente così.

   **Il valore va codificato in base64, non incollato tale e quale.** Il segreto
   è già una stringa di caratteri; qui dentro i valori sono chiavi codificate in
   base64, quindi il segreto va codificato un'altra volta. Da terminale:

   ```sh
   printf '%s' 'XyZ987...' | base64
   ```

   Se lo incolli senza codificarlo, il container firma con qualcosa che non è la
   tua chiave e ogni chiamata viene rifiutata.

   Su un container che gestisci tu (Cloud Run, o una macchina tua) il file si
   monta come un secret e si punta `SGTM_CREDENTIALS` al percorso dove è
   montato — per esempio `/tmp/kerdon.json`. Il nome del file deve finire in
   `.json`.

2. **Importa il modello.** Nel container server-side: Modelli → Modelli client →
   Nuovo → menu ⋮ → Importa, e scegli `kerdon-id-client.tpl`.

3. **Controlla i permessi del modello**, nella scheda Permessi, prima di
   salvare: sotto **Uses custom private keys** dev'esserci `kerdon_ingest`. Se
   non c'è, aggiungilo. Senza, il container si rifiuta di firmare e il client
   risponde sempre a vuoto. Poi salva.

4. **Crea il client.** Client → Nuovo → scegli "Kerdon — Identificativo
   visitatore". Compila:

   | Campo | Valore |
   |---|---|
   | Percorso su cui rispondere | `/kerdon/id` |
   | Indirizzo dell'API | quello indicato in Impostazioni |
   | Identificativo della chiave di invio | la metà prima del punto, senza `kin_` |
   | Dominio del negozio | `negozio.it`, senza `https://` |
   | Durata del cookie | `31536000` (un anno) |

   La priorità del client va lasciata sotto quella dei client di GA4 e di
   Shopify: risponde solo al proprio percorso, ma l'ordine evita sorprese.

5. **Pubblica il container.**

6. **Aggiungi lo script alla vetrina**, nel tema (`theme.liquid`, prima di
   `</head>`) o come tag personalizzato del tag manager web:

   ```html
   <script src="https://api.kerdon.io/tracking/bridge.js"
           data-kerdon-endpoint="https://sgtm.negozio.it/kerdon/id" async></script>
   ```

7. **Verifica**, dall'app: Impostazioni → Verifica installazione.

## Perché il sottodominio deve essere del negozio

Il cookie lo pianta il container, e vale per il dominio da cui il container
risponde. Se quel dominio non è quello della vetrina, il cookie è di terze parti
— cioè esattamente il cookie che i browser cancellano, e che questo giro esiste
per evitare. Un container su `sgtm.negozio.it` va bene; uno su un indirizzo di
Google Cloud no.

## Niente credenziali nel browser, e nemmeno nel container

Il segreto non sta in nessun campo del client: sta nel file di credenziali, e il
container lo usa per calcolare una firma senza mai mostrarlo. Chi apre gli
strumenti di sviluppo su quel negozio non trova niente, perché niente è mai
passato di lì; e chi esporta il container non si porta via la chiave, perché nel
container non c'è.

Questa rotta non si limita a leggere: **conia** l'identificativo del visitatore e
ne registra la riga. Finché per farlo bastava la chiave di lettura, chi ne aveva
una per consultare i dati poteva anche scriverli. Adesso sono due permessi
distinti, con due credenziali che si ruotano e si revocano l'una senza toccare
l'altra.

## Se il container non può firmare

Il modello firma con `hmacSha256`, che nel sandbox di Google Tag Manager **non
accetta un segreto come stringa**: accetta il nome di una chiave dichiarata nel
file JSON indicato da `SGTM_CREDENTIALS`. Servono quindi due cose che non tutti i
provider di container danno: poter caricare un file e poter impostare una
variabile d'ambiente.

- **Container che gestisci tu** (Cloud Run, Docker, una macchina tua): si fa, ed
  è il passo 1 qui sopra.
- **Stape**: al momento della scrittura la documentazione pubblica di Stape non
  dice come farlo, e le impostazioni di un container Stape coprono zone, dominio
  personalizzato, CDN, chiave API e power-up — non variabili d'ambiente del
  server né caricamento di file. Attenzione a un equivoco: le "variabili" di cui
  parla la loro guida, nella cartella `[Stape]_Settings`, sono variabili **dentro
  il container GTM**, non variabili d'ambiente del server, e non servono a
  questo. **Prima di programmare il passaggio, chiedi conferma al loro
  supporto.** Se la risposta è no, questa strada su Stape non è percorribile e
  resta quella qui sotto.
- **Qualunque altro provider gestito**: stessa domanda, stesso ordine. Se non
  puoi mettere una chiave nel file di credenziali, il container non può firmare,
  e non c'è modo di aggirarlo dal modello.

**Cosa resta, se il container non può firmare.** La firma deve avvenire dove la
chiave può stare. Nella catena del tracciamento il container non è il primo
anello: davanti c'è già l'endpoint sul dominio del negozio, ed è codice normale,
senza sandbox e senza vincoli su dove tenere un segreto. Spostare lì la firma è
una decisione di chi cura il tracciamento del negozio, non qualcosa che questo
modello possa risolvere: l'app non la impone e non fornisce un pezzo che scavalchi
il container.

**Fino al 1 dicembre 2026** le installazioni ancora sulla sola chiave di lettura
continuano a funzionare, e in Impostazioni compare l'avviso che vanno aggiornate
ben prima di quella data. Da quella data no.

## La stringa che si firma

È già scritta nel modello, e non c'è niente da comporre a mano. Se ti serve per
verificare, o per firmare da un altro pezzo, è questa — un pezzo per riga:

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
uguale.

Il risultato è una HMAC-SHA256 in base64url, e va nelle intestazioni
`X-Kerdon-Key-Id`, `X-Kerdon-Timestamp`, `X-Kerdon-Signature`
(`v1=<firma>`) e `X-Kerdon-Idempotency-Key`. La firma vale cinque minuti attorno
al proprio istante, quindi l'orologio del container deve essere all'ora giusta.
