# L'identificativo del visitatore: come si collega

Questo documento descrive **l'unico trasporto supportato** per l'identificativo
con cui l'app riconosce chi torna sul negozio. Non e' una fra piu' opzioni: e'
quella che funziona, e le altre sono state provate e scartate.

Quello che cambia da merchant a merchant e' **come** si installa l'endpoint che
lo regge: due strade, tutte e due nel prodotto, con un asset versionato per
ciascuna sotto [`integrations/`](../integrations/).

## In una riga

Chi chiama l'app e' un **endpoint first-party del negozio** — un container
server-side su un sottodominio suo, un Worker di CDN, il backend del merchant —
mai il browser.

## Perche' non il browser

Tre motivi, e ognuno basterebbe.

**Il cookie sarebbe di terze parti.** Un cookie `SameSite=None; Secure` emesso
dal nostro dominio, letto dentro la pagina del negozio, e' di terze parti:
Safari lo cancella dopo sette giorni quando lo accetta, e spesso non lo accetta;
Firefox lo isola per sito. Un identificativo che deve durare un anno non puo'
vivere li'.

**Non c'e' CORS sulle rotte dei dati, ed e' voluto.** Le rotte `/rest/v1/` non
dichiarano nessun `Access-Control-Allow-Origin` e non rispondono a `OPTIONS`:
una chiamata dalla vetrina fallirebbe il controllo preliminare del browser prima
ancora di partire. L'unica rotta pubblica che si lascia includere da qualunque
dominio e' `/tracking/bridge.js`, che e' uno script identico per tutti e non
contiene nessun dato e nessuna credenziale.

**Il token finirebbe in chiaro.** Una chiamata dalla pagina dovrebbe portarsi
dietro il token di lettura del negozio, che diventerebbe leggibile da chiunque
apra gli strumenti di sviluppo. Quel token vive dove deve vivere: nella pagina
Impostazioni dell'app, dietro sessione amministratore, da dove il merchant lo
copia dentro il proprio container o Worker.

## Le due meta'

### In vetrina: `/tracking/bridge.js`

Uno script solo, uguale per tutti i negozi e per tutte e due le strade di
installazione. Il codice sta in
[`app/lib/tracking/consent-bridge.ts`](../app/lib/tracking/consent-bridge.ts) ed
e' servito dalla rotta `tracking.bridge[.]js`.

```html
<script src="https://api.kerdon.io/tracking/bridge.js"
        data-kerdon-endpoint="https://negozio.it/kerdon/id" async></script>
```

Fa tre cose, in quest'ordine:

1. legge dalla Customer Privacy API di Shopify cosa ha risposto il visitatore;
2. **solo se il permesso c'e'**, chiama l'endpoint first-party del negozio —
   mai noi — e ne riceve l'identificativo;
3. attacca quell'identificativo all'attributo `kerdon_eid` del carrello, cosi'
   risale nell'ordine.

Non contiene nessuna credenziale e non scrive il cookie dell'identificativo: lo
scrive l'endpoint, con `Set-Cookie`, che e' l'unico posto da cui si ottengono
`Secure` e una durata che il browser rispetti.

Alla revoca chiama l'endpoint per far disfare, toglie il cookie dal browser e
svuota l'attributo del carrello — e **non guarda** la risposta di quella
chiamata: un endpoint che rispondesse comunque con un identificativo lo
rimetterebbe addosso a chi ha appena detto di no.

### Dove sta Kerdon nella catena

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

L'unico asset che pubblichiamo e' quindi il modello per il container:
[`integrations/sgtm/`](../integrations/sgtm/). Non ne esiste uno che scavalchi
il container parlando direttamente con noi, e non deve esistere: sarebbe il
merchant a perderci, perche' quel pezzo davanti e' proprio cio' che gli evita di
essere bloccato.

In tutti e due gli asset **l'indirizzo dell'API e' un parametro** e non una
costante scritta nel codice: `KERDON_URL` nel Worker, "Indirizzo dell'API" nel
template. Quando l'indirizzo cambia si modifica il valore e si ripubblica.

## Il giro completo

### Prima visita

1. Il visitatore apre una pagina del negozio e risponde al banner.
2. Il ponte legge il permesso e chiama **l'endpoint del negozio** (es.
   `https://negozio.it/kerdon/id`), non noi.
3. Quell'endpoint chiama l'app con il token di lettura, **senza**
   identificativo: non ne ha ancora uno.
4. L'app ne conia uno e lo restituisce nell'header `X-CoreW-External-Id` (e nel
   corpo, come `external_id`).
5. **L'endpoint del negozio pianta il cookie**, dal proprio dominio, con il
   valore ricevuto. E' un cookie first-party: nessun browser lo tratta da
   estraneo.
6. Il ponte attacca lo stesso valore al carrello.

### Visite successive

1. Il ponte chiama di nuovo l'endpoint del negozio, passando il valore letto dal
   cookie first-party.
2. L'endpoint lo passa all'app in uno di questi due modi:
   - header `X-CoreW-External-Id: corew_...` — la via normale;
   - parametro di query `existing_external_id=corew_...` — dove l'header non si
     puo' aggiungere, cosa che certi template di tag non permettono.
3. L'app **restituisce lo stesso identificativo**, senza coniarne uno nuovo.

Se il valore che arriva non ha la forma giusta viene trattato come assente e se
ne conia uno buono: e' anche cio' che impedisce a qualcuno di farsi assegnare un
identificativo scelto da lui.

## Cosa deve fare l'endpoint del negozio

| | |
|---|---|
| Chiamare | `GET <indirizzo dell'API>/rest/v1/tracking_id` |
| Autenticarsi | la credenziale di **invio**: firmata dove si puo' (vedi sotto), altrimenti presentata intera in `apikey`. Il token di lettura qui non vale |
| Inoltrare | il permesso del visitatore, e `X-CoreW-External-Id` con il valore del cookie first-party quando c'e' |
| Leggere | l'header `X-CoreW-External-Id` della risposta |
| Piantare | il cookie `kerdon_eid` **dal proprio dominio**, con `Secure`, `Path=/`, un `SameSite` dichiarato e una durata |
| Non fare | niente, quando non arriva nessun segnale di permesso |

Il cookie va emesso dall'endpoint del negozio, non da noi: e' quel dominio a
renderlo first-party, ed e' l'unica ragione per cui dura.

## Le due credenziali, e perche' non sono una

Le rotte sotto `/rest/v1/` non si limitano a servire dati: `tracking_id` **conia**
l'identificativo di un visitatore e ne registra la riga, `users` ne scrive le
etichette, `identify` lo **lega a una persona con nome e cognome**. Tutte e tre
scrivono nel progetto del merchant con la chiave di servizio, che salta le RLS.

Finche' per farlo bastava il token di lettura, chi ne aveva uno per consultare i
dati poteva anche scriverli — a cominciare dal legame browser-cliente, cioe' la
possibilita' di attribuirsi gli acquisti di qualcun altro.

| | Lettura | Invio |
|---|---|---|
| Valore | `spx_…`, rileggibile da Impostazioni | `kin_<id>.<segreto>`, mostrato **una volta sola** |
| Come si presenta | si manda tale e quale | non si manda: si usa per **firmare** |
| Ambiti | — | `ingest:identity`, `ingest:browsers`, `ingest:links`, separati |
| Rotazione | sostituisce | sostituisce, e la vecchia vale ancora **48 ore** |
| Revoca | — | immediata, senza nessuna finestra |

### Come si firma

HMAC-SHA256 con il segreto di invio, sulla stringa composta da questi pezzi, uno
per riga:

```
v1                       ← versione delle regole
ingest                   ← destinatario dichiarato
ingest:links             ← l'ambito della rotta chiamata
1789041600000            ← millisecondi dall'epoch
POST                     ← il metodo vero della richiesta
/rest/v1/identify        ← il percorso della rotta, senza querystring
<sha256(corpo) base64url>← per una GET, quello della stringa vuota
<chiave di idempotenza>  ← diversa a ogni chiamata
```

Le intestazioni:

| Intestazione | Valore |
|---|---|
| `X-Kerdon-Key-Id` | il pezzo prima del punto: non e' segreto |
| `X-Kerdon-Timestamp` | lo stesso istante che sta nella firma |
| `X-Kerdon-Signature` | `v1=<firma in base64url>` |
| `X-Kerdon-Idempotency-Key` | al massimo 128 caratteri, diversa a ogni chiamata |

Ogni pezzo della stringa c'e' per un attacco preciso, e toglierne uno riapre
quello: la versione e il destinatario perche' una firma composta altrove non
valga qui; l'ambito perche' una firma catturata su una rotta leggera non si
ripresenti su quella che lega browser e persone; l'istante perche' una richiesta
catturata scada; il metodo e il percorso perche' l'ambito non lo scelga chi
chiama; l'impronta del corpo perche' il corpo non si possa cambiare tenendo la
firma; la chiave di idempotenza perche' due invii uguali restino distinguibili da
un invio ripetuto.

### I rifiuti

| Stato | Quando |
|---|---|
| `401` | nessuna credenziale, credenziale sconosciuta, revocata, scaduta, firma che non torna, istante fuori dalla finestra di **cinque minuti** |
| `403` | la credenziale non ha l'ambito della rotta, oppure il negozio non puo' scrivere |
| `409` | la stessa chiave di idempotenza, dalla stessa credenziale, dentro la finestra |
| `413` | corpo oltre **16 KB** |
| `400` | JSON annidato oltre **6 livelli**, o non leggibile |
| `429` | quota superata; porta `Retry-After` in secondi |

La quota e' per negozio e per credenziale: **300 richieste in un colpo** e
**40 al secondo** di regime, perche' il traffico di una vetrina arriva a
raffiche. L'indirizzo IP e' un segnale secondario — impedisce a una sola
provenienza di consumare la quota di tutte — e **non e' mai un'identita'**: non
autorizza niente e non compare in nessun log.

### Il token di lettura, presentato qui

E' un rifiuto, e non c'e' nessuna data che lo cambi. C'e' stata una fase in cui
veniva ancora accettato — serviva a non spegnere il tracciamento ai negozi gia'
installati — ed e' finita senza aver protetto nessuno, perche' negozi installati
non ce n'erano.

Il rifiuto ha un esito suo nel log, `read_key_on_write_route`, distinto da
`no_credential`: "il container non manda niente" e "il container manda la chiave
sbagliata" sono due guasti con due rimedi diversi, e incollare l'una al posto
dell'altra resta l'errore piu' probabile di tutta la configurazione.

`tracking_setups.ingest_last_signed_at` dice quando da quel negozio e' arrivata
l'ultima scrittura. La colonna `ingest_last_legacy_at` resta nello schema ma non
la scrive piu' nessuno: misurava chi era ancora indietro, e indietro non ci si
puo' piu' stare.

### Cosa finisce nei log

Rotta, riferimento del negozio, identificativo pubblico della credenziale,
esito, stato, millisecondi e — solo quando c'e' stato — quale secchiello ha
detto di no. **Mai** email, telefoni, identificativi di visitatore, pezzi del
corpo, indirizzi IP o chiavi.

## La verifica: finche' non passa, non e' configurato

Una schermata che dice "collegato" guarda cose nostre — il progetto collegato,
la chiave emessa — e il pezzo che manca non e' mai stato nostro. Prima si poteva
arrivare in fondo alla configurazione, vedere tutto a posto, e non tracciare
niente.

`POST /api/tracking/verify` (autenticata, sessione amministratore) chiama
l'endpoint del merchant **davvero**, come lo chiamerebbe il browser di un
visitatore — cioe' senza nessuna credenziale — e guarda:

| Controllo | Cosa deve risultare |
|---|---|
| `endpoint_url` | https, host pubblico, non il nostro, non `myshopify.com`, sullo stesso sito della vetrina |
| `https` | lo schema e' https |
| `reachable` | risponde |
| `no_redirect` | risponde subito, senza 3xx: un rimando fa perdere per strada header e `Set-Cookie` |
| `consent_granted` | con il permesso restituisce un identificativo ben formato e pianta il cookie |
| `cookie_attributes` | `Secure`, `Path=/`, `SameSite` dichiarato, una durata |
| `consent_missing` | **senza nessun segnale** non restituisce niente e non pianta niente |
| `consent_withdrawn` | alla revoca non restituisce piu' niente e fa scadere il cookie |

Finche' tutti e otto non passano, la configurazione del tracciamento **non si
segna completata**: la card mostra "Da verificare". Cambiare strada o indirizzo
annulla una verifica precedente — una verifica e' una frase su una
configurazione precisa, non un bollino sul negozio.

`HttpOnly` non e' richiesto ed e' voluto: il ponte deve poter rileggere il
cookie per attaccare lo stesso identificativo al carrello.

## Cosa viene scritto, e dove

Ogni identificativo coniato o rivisto lascia **una riga per browser** nella
tabella `users` del database del merchant: l'identificativo stesso, l'etichetta
del browser e quella del tipo di dispositivo quando il container le trasmette, il
primo e l'ultimo avvistamento, l'eventuale collegamento al cliente Shopify e il
rimando all'identificativo piu' vecchio quando due browser risultano della stessa
persona.

Non e' un dato anonimo, e non va chiamato cosi': l'identificativo vive nel browser
di una persona e, dal collegamento in poi, dice quali dispositivi usa e quando li
ha usati. Le righe mai collegate a un cliente si cancellano dopo 90 giorni.
Il testo per gli interessati sta in `docs/legal/privacy-policy.it.md`, punto 3.5.

## Il consenso viene prima

Non si conia niente se chi naviga non ha dato il permesso: senza, la risposta
non porta nessun identificativo e non viene scritta nessuna riga. Servono
`analytics` e `marketing` insieme — e' lo stesso identificativo a misurare e ad
attribuire, e non se ne conia mezzo.

**L'assenza di segnale vale come no**, in tutti e tre i punti del giro: nel
ponte, nell'endpoint e nell'app. Nessun valore di ripiego, nessuna regola per
paese scritta da noi: se il negozio non e' in una configurazione che richiede il
consenso, e' Shopify a dire che le finalita' sono permesse, e quel "permesso" si
legge come qualunque altro.

Il container non deve **mai** dichiarare un consenso che il visitatore non ha
dato: sarebbe registrarlo al posto suo. La verifica lo controlla.

Alla revoca il cookie scade e la riga sparisce dal database. Le due meta' della
revoca sono queste, e la prima avviene comunque: se la seconda non riesce, si
perde una cancellazione a valle, non si continua a raccogliere.

## Sulla durata: un massimo tecnico, non una garanzia

Il cookie chiede fino a un anno di vita (`Max-Age`). E' una **richiesta al
browser soggetta al consenso**, non una promessa di conservazione:

- il consenso si puo' ritirare in qualunque momento, e da quell'istante non c'e'
  piu' niente da conservare;
- il browser puo' accorciare la durata per politica propria — Safari lo fa anche
  sui cookie first-party scritti da JavaScript;
- la persona puo' cancellare i cookie, o navigare in una sessione privata che non
  ne conserva nessuno.

Quindi: un anno e' il **massimo** che si chiede, non il tempo per cui un
riconoscimento esiste. Dirlo come una durata certa e' il modo in cui, mesi dopo,
qualcuno si accorge che i numeri non tornano e non capisce perche'. La durata
piu' vicina a quel massimo la ottiene il cookie first-party dell'endpoint del
negozio; quella di un cookie emesso sul nostro dominio sarebbe molto piu'
incerta, ed e' esattamente il motivo per cui questo trasporto esiste.

## Il formato dell'identificativo

`corew_` seguito da 32 caratteri casuali. Non contiene altro: non l'ora in cui
e' stato coniato, non il negozio, non il dispositivo.

Gli identificativi del formato precedente — `corew_<millisecondi>_<32
caratteri>` — restano validi e vengono riconosciuti: sono nei browser delle
persone, e rifiutarli vorrebbe dire coniarne uno nuovo a chiunque torni. Non se
ne creano piu' di nuovi in quella forma.

## Cosa questi asset non fanno

Non parlano con Meta, con Google o con nessun'altra piattaforma. Restituiscono
un identificativo e piantano un cookie. A chi mandarlo, e se mandarlo, lo decide
il merchant nei propri tag: quella decisione deve stare dove avviene il fatto.
Cosa ha risposto il visitatore sulla condivisione con terzi glielo diciamo
nell'header `X-CoreW-Sale-Of-Data`.
