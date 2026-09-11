# Google Tag Manager server-side

L'endpoint first-party del negozio, come Client del container server-side.

**Serve:** un container server-side gia' attivo su un sottodominio del negozio
(per esempio `sgtm.negozio.it` — non un indirizzo `*.run.app`, che non e'
first-party per nessuno), e la chiave di lettura dalla pagina Impostazioni
dell'app.

## Installazione

1. **Importa il template.** Nel container server-side: Modelli → Modelli client
   → Nuovo → menu ⋮ → Importa, e scegli `kerdon-id-client.tpl`. Salva.

2. **Crea il client.** Client → Nuovo → scegli "Kerdon — Identificativo
   visitatore". Compila:

   | Campo | Valore |
   |---|---|
   | Percorso su cui rispondere | `/kerdon/id` |
   | Indirizzo dell'API | quello indicato in Impostazioni |
   | Chiave di lettura | si copia da Impostazioni |
   | Dominio del negozio | `negozio.it`, senza `https://` |
   | Durata del cookie | `31536000` (un anno) |

   La priorita' del client va lasciata sotto quella dei client di GA4 e di
   Shopify: risponde solo al proprio percorso, ma l'ordine evita sorprese.

3. **Pubblica il container.**

4. **Aggiungi lo script alla vetrina**, nel tema (`theme.liquid`, prima di
   `</head>`) o come tag personalizzato del tag manager web:

   ```html
   <script src="https://api.kerdon.io/tracking/bridge.js"
           data-kerdon-endpoint="https://sgtm.negozio.it/kerdon/id" async></script>
   ```

5. **Verifica**, dall'app: Impostazioni → Verifica installazione.

## Perche' il sottodominio deve essere del negozio

Il cookie lo pianta il container, e vale per il dominio da cui il container
risponde. Se quel dominio non e' quello della vetrina, il cookie e' di terze
parti — cioe' esattamente il cookie che i browser cancellano, e che questo giro
esiste per evitare. Un container su `sgtm.negozio.it` va bene; uno su un
indirizzo di Google Cloud no.

## La chiave non arriva mai al browser

Sta nel campo del client, dentro il container. La chiamata dalla vetrina va al
container, il container chiama Kerdon: chi apre gli strumenti di sviluppo su
quel negozio non trova nessuna credenziale, perche' non ce n'e' mai passata una.

## La chiave di invio, e la data da segnarsi

Dal 2026 il giro del tracciamento ha **due** credenziali, non una: quella di
**lettura**, che serve a farsi restituire dati gia' raccolti, e quella di
**invio**, che serve a comunicare chi sta visitando adesso. Il perche' sta in
[`../README.md`](../README.md): questa rotta non si limita a leggere — conia
l'identificativo del visitatore e ne registra la riga — e finche' per farlo
bastava la chiave di lettura, chi ne aveva una per consultare i dati poteva
anche scriverli.

**Il template di questa cartella usa ancora la sola chiave di lettura.** Una
versione aggiornata, che firma le chiamate con la chiave di invio, e' in
lavorazione; il Worker di Cloudflare la usa gia'.

**Fino al 1 dicembre 2026** questa installazione continua a funzionare
esattamente com'e'. Chi sta su questa strada trovera' in Impostazioni l'avviso
che l'installazione va aggiornata, e le istruzioni, ben prima di quella data —
non c'e' niente da fare adesso.

Chi vuole passare prima ha due possibilita': spostarsi sul Worker di Cloudflare,
oppure — per chi se la cava con i template — far firmare le chiamate dal proprio
container. La stringa da firmare, in HMAC-SHA256 con il segreto di invio, e'
questa, un pezzo per riga:

```
v1
ingest
ingest:identity
<millisecondi dall'epoch>
GET
/rest/v1/tracking_id
<SHA-256 del corpo, base64url; per una GET, quello della stringa vuota>
<una chiave di idempotenza diversa a ogni chiamata>
```

e va nelle intestazioni `X-Kerdon-Key-Id`, `X-Kerdon-Timestamp`,
`X-Kerdon-Signature` (`v1=<firma in base64url>`) e `X-Kerdon-Idempotency-Key`.
La firma vale cinque minuti attorno al proprio istante.
