# Come si chiude il giro del tracciamento

Kerdon riconosce chi torna su un negozio grazie a un identificativo che vive in
un cookie. Quel cookie **non lo puo' scrivere Kerdon**: emesso dal nostro
dominio dentro la pagina di un negozio sarebbe di terze parti, e i browser lo
cancellano — Safari dopo sette giorni quando lo accetta, spesso non lo accetta
affatto. Deve scriverlo il dominio del negozio.

Serve quindi un pezzo che stia **sul dominio del negozio**, riceva la chiamata
dalla vetrina, parli con Kerdon da server a server e pianti il cookie da li'.
Questa cartella contiene quel pezzo, in due versioni: se ne installa **una**.

| Cartella | Per chi |
|---|---|
| [`sgtm/`](sgtm/) | Ha gia' un container server-side di Google Tag Manager su un sottodominio proprio |
| [`cloudflare-worker/`](cloudflare-worker/) | Ha il dominio su Cloudflare e non vuole un container |

## Le due meta'

**In vetrina** — lo stesso script per tutte e due le strade, servito da Kerdon a
`/tracking/bridge.js`. Legge cosa ha risposto il visitatore al banner, e **solo
se il permesso c'e'** chiama l'endpoint del negozio, poi attacca al carrello
l'identificativo che riceve. Non contiene nessuna chiave.

```html
<script src="https://api.kerdon.io/tracking/bridge.js"
        data-kerdon-endpoint="https://negozio.it/kerdon/id" async></script>
```

**Sul dominio del negozio** — il Worker o il Client di GTM. Questo pezzo ha le
credenziali, e per questo non sta nel browser.

## Le credenziali sono due, e non e' burocrazia

| Chiave | A cosa serve | Come si presenta |
|---|---|---|
| **di lettura** | Farsi restituire dati gia' raccolti | Si manda tale e quale |
| **di invio** | Comunicare chi sta visitando adesso | Non si manda: si usa per **firmare** |

Il giro del tracciamento non solo legge: **conia** l'identificativo di un
visitatore, ne scrive la riga e — quando la persona si rivela — la lega a un
cliente del negozio. Finche' per tutte queste cose bastava la chiave di lettura,
chi ne aveva una per consultare i dati poteva anche scriverli: creare browser, e
dichiarare che un browser qualsiasi appartiene a un cliente qualsiasi. Adesso
sono due permessi distinti, con due credenziali che si ruotano e si revocano
l'una senza toccare l'altra.

La chiave di invio **si vede una volta sola**, nel momento in cui la si crea in
Impostazioni. Se si perde se ne crea un'altra: quella di prima continua a
funzionare per due giorni, il tempo di ripubblicare il container o il Worker.
Chi invece sospetta che sia finita nelle mani sbagliate non la sostituisce, la
**revoca** — e quella non ha nessuna finestra.

**Fino al 1 dicembre 2026** le installazioni con la sola chiave di lettura
continuano a funzionare. Da quella data no. Un'installazione ancora indietro si
riconosce da un avviso in Impostazioni, che compare molto prima.

## Le regole che nessuna delle due versioni puo' rompere

1. **L'assenza di segnale e' un no.** Nessun valore di ripiego, nessuna regola
   per paese: se non arriva niente che dica cosa ha risposto il visitatore, non
   si chiama nessuno, non si conia niente, non si pianta nessun cookie.
2. **Nessuna chiave nel browser.** Tutte e due le chiavi stanno nel Worker o nel
   container, mai in una pagina. E il segreto di invio non esce nemmeno da li':
   serve a calcolare una firma, ed e' la firma che viaggia.
3. **Il cookie e' first-party.** Sul dominio da cui si vede la vetrina, con
   `Secure`, `Path=/`, un `SameSite` dichiarato e una durata.
4. **La revoca disfa.** Al no esplicito il cookie scade e la riga sparisce.
5. **Niente integrazioni dirette.** Questi asset restituiscono un identificativo
   e piantano un cookie. A chi mandarlo lo decide il merchant nei propri tag.

## L'indirizzo dell'API e' un parametro

In tutti e due gli asset l'indirizzo di Kerdon si configura (`KERDON_URL` nel
Worker, "Indirizzo dell'API" nel template) e non e' scritto nel codice: quando
cambia si modifica il valore e si ripubblica, senza rifare l'asset.

## Prima di dire che funziona

Non fidarsi di una schermata che dice "collegato": in Impostazioni → Connessione
e credenziali di tracking c'e' **Verifica installazione**, che chiama l'endpoint
davvero e prova i tre casi che contano — con il permesso, senza nessun segnale,
e alla revoca. Finche' quella verifica non passa, la configurazione del
tracciamento non e' completa.
