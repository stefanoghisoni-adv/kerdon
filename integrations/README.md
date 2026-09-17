# Come si chiude il giro del tracciamento

Kerdon riconosce chi torna su un negozio grazie a un identificativo che vive in
un cookie. Quel cookie **non lo puo' scrivere Kerdon**: emesso dal nostro
dominio dentro la pagina di un negozio sarebbe di terze parti, e i browser lo
cancellano — Safari dopo sette giorni quando lo accetta, spesso non lo accetta
affatto. Deve scriverlo il dominio del negozio.

Serve quindi un pezzo che stia **sul dominio del negozio**, riceva la chiamata
dalla vetrina, parli con Kerdon da server a server e pianti il cookie da li'.
Questa cartella contiene quel pezzo: [`sgtm/`](sgtm/), il modello da importare
nel container server-side.

La catena del tracciamento server-side e' **in fila, non a bivio**:

    vetrina
      → endpoint sul dominio del negozio (di solito un Worker di Cloudflare)
      → sottodominio del provider del container (Stape o altro), cifrato
      → Kerdon

Il primo anello lo monta gia' chi si occupa del tracciamento, e il suo mestiere
e' un altro dal nostro: reinstradare in modo cifrato verso il container, perche'
Safari, Brave, Firefox e le estensioni non blocchino le richieste — cosa che
riesce solo perche' il dominio e' di prima parte.

**Kerdon e' l'ultimo anello.** Si fa chiamare dal container, restituisce
l'identificativo, e non sostituisce nessuno dei pezzi che stanno davanti.


## Le due meta'

**In vetrina** — lo script servito da Kerdon a
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

| Chiave | A cosa serve | Dove va |
|---|---|---|
| **di lettura** | Farsi restituire dati gia' raccolti | Nell'applicazione che legge |
| **di invio** (`kin_...`) | Comunicare chi sta visitando adesso | Nel Worker o nel container |

Il giro del tracciamento non solo legge: **conia** l'identificativo di un
visitatore, ne scrive la riga e — quando la persona si rivela — la lega a un
cliente del negozio. Finche' per tutte queste cose bastava la chiave di lettura,
chi ne aveva una per consultare i dati poteva anche scriverli: creare browser, e
dichiarare che un browser qualsiasi appartiene a un cliente qualsiasi. Adesso
sono due permessi distinti, con due credenziali che si ruotano e si revocano
l'una senza toccare l'altra.

**Come si presenta la chiave di invio.** Dove c'e' un pezzo di codice proprio —
un Worker, un endpoint sul dominio del negozio — la si usa per **firmare**: il
segreto resta fermo, sul filo passa solo il risultato di una HMAC e ogni
chiamata vale una volta sola. Dove quel posto non c'e' — il container
server-side di un provider gestito, dove il sandbox non ha dove tenere un
segreto — la si **presenta intera**, su TLS, nello stesso campo dove prima
andava quella di lettura. La seconda forma non chiude il replay e la prima si',
e il server le distingue nei propri log; tutte e due chiudono il privilegio, che
e' il difetto da cui si parte. Chi non puo' firmare non sta facendo niente di
sbagliato: sta usando la strada prevista per il proprio container.

La chiave di invio **si vede una volta sola**, nel momento in cui la si crea in
Impostazioni. Se si perde se ne crea un'altra: quella di prima continua a
funzionare per due giorni, il tempo di ripubblicare il container o il Worker.
Chi invece sospetta che sia finita nelle mani sbagliate non la sostituisce, la
**revoca** — e quella non ha nessuna finestra.

**La chiave di lettura non apre le rotte che scrivono.** Non c'e' nessuna
finestra e nessuna data: un container rimasto su quel valore riceve un rifiuto,
e il log del server lo chiama per nome invece di confonderlo con una chiamata
senza credenziale — perche' incollare l'una al posto dell'altra e' l'errore piu'
probabile di tutta la configurazione.

## Le regole che nessuna delle due versioni puo' rompere

1. **L'assenza di segnale e' un no.** Nessun valore di ripiego, nessuna regola
   per paese: se non arriva niente che dica cosa ha risposto il visitatore, non
   si chiama nessuno, non si conia niente, non si pianta nessun cookie.
2. **Nessuna chiave nel browser.** La chiave sta nel Worker o nel container, mai
   in una pagina: lo script servito alla vetrina non ne contiene nessuna.
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
