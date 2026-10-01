# L'identificativo del visitatore: come si collega

Questo documento descrive **l'unico trasporto supportato** per l'identificativo
con cui l'app riconosce chi torna sul negozio. Non e' una fra piu' opzioni: e'
quella che funziona, e le altre sono state provate e scartate.

L'app **non installa niente nel tema** del negozio, e non l'ha mai avuto come
obiettivo: nessuno script in vetrina, nessuna riga in `theme.liquid`. L'unico
asset che Kerdon pubblica per il lato negozio e' il modello del container
server-side, in [`integrations/sgtm/`](../integrations/sgtm/).

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
ancora di partire.

**Il token finirebbe in chiaro.** Una chiamata dalla pagina dovrebbe portarsi
dietro il token di lettura del negozio, che diventerebbe leggibile da chiunque
apra gli strumenti di sviluppo. Quel token vive dove deve vivere: nella pagina
Impostazioni dell'app, dietro sessione amministratore, da dove il merchant lo
copia dentro il proprio container o Worker.

## La catena

### Dove sta Kerdon

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

**L'indirizzo dell'API e' un parametro** del template ("Indirizzo dell'API") e
non una costante scritta nel codice: quando l'indirizzo cambia si modifica il
valore e si ripubblica.

### Chi fa partire la chiamata

La chiamata dalla pagina all'endpoint del negozio la predispone chi cura il
tracciamento del merchant, con gli strumenti che usa gia' (il tag manager web,
il proprio Worker). Deve partire **a ogni pagina, anche senza consenso**: senza
consenso il template non conia niente e non pianta niente, ma e' proprio quella
chiamata a portare il no — letto dal cookie `_tracking_consent` di Shopify, che
viaggia da se' verso il dominio del negozio, oppure dal parametro `consent` —
e quindi a far partire la revoca.

## Il giro completo

### Prima visita

1. Il visitatore apre una pagina del negozio e risponde al banner.
2. La pagina chiama **l'endpoint del negozio** (es.
   `https://negozio.it/kerdon/id`), non noi; il container riceve la chiamata e
   legge il permesso.
3. Il container chiama l'app con la chiave di invio, **senza**
   identificativo: non ne ha ancora uno.
4. L'app ne conia uno e lo restituisce nell'header `X-CoreW-External-Id` (e nel
   corpo, come `external_id`).
5. **L'endpoint del negozio pianta il cookie**, dal proprio dominio, con il
   valore ricevuto. E' un cookie first-party: nessun browser lo tratta da
   estraneo.
6. A chi mandarlo — dataLayer, piattaforme — lo decidono i tag del merchant.
   Per il legame con l'ordine vedi "Il legame con l'ordine" qui sotto.

### Visite successive

1. La pagina chiama di nuovo l'endpoint del negozio; il cookie first-party
   viaggia con la chiamata.
2. Il template lo legge **dal cookie `kerdon_eid`** e lo passa all'app
   nell'header `X-Kerdon-External-Id`.
3. L'app **restituisce lo stesso identificativo**, senza coniarne uno nuovo.

**Il cookie e' l'unica fonte.** Il template accetta il parametro
`existing_external_id` solo quando e' identico al cookie `kerdon_eid` che la
chiamata porta; altrimenti lo ignora. Un valore arrivato da fuori senza il
cookie non e' di quel browser: puo' essere un identificativo gia' revocato,
rimasto in un dataLayer o in un tag, e riusarlo ricucirebbe la persona di prima
della revoca a quella di dopo. Per la stessa ragione **l'app non riusa mai un
identificativo revocato**: se ne arriva uno — da header, parametro o cookie — ne
conia uno nuovo.

Se il valore che arriva non ha la forma giusta viene trattato come assente e se
ne conia uno buono: e' anche cio' che impedisce a qualcuno di farsi assegnare un
identificativo scelto da lui.

## Il legame con l'ordine

L'identificativo diventa utile quando si lega a un ordine. Le strade sono due, e
le monta chi cura il tracciamento:

1. **L'attributo del carrello `_kerdon_external_id`.** I tag delle pagine
   copiano il valore del cookie `kerdon_eid` (non e' `HttpOnly`, si legge dalla
   pagina) nell'attributo del carrello `_kerdon_external_id`, per esempio con
   `POST /cart/update.js` e `{"attributes": {"_kerdon_external_id": "<valore>"}}`.
   L'underscore lo rende privato: Shopify non lo mostra al cliente. Il webhook
   degli ordini lo legge da `note_attributes` e lega il browser al cliente
   dell'ordine. Il nome `_corew_external_id` (di prima del cambio di marchio) si
   legge ancora come ripiego; se ci sono tutti e due vince quello nuovo. Un
   valore che non ha la forma di un identificativo viene scartato.
2. **`POST /rest/v1/identify`**, dal container e con la chiave di invio
   (ambito `ingest:links`), al momento dell'acquisto o quando il visitatore
   lascia un contatto. Corpo JSON piatto: `external_id` (il valore del cookie),
   `email` e/o `phone`, e il permesso del visitatore. Se dietro quel contatto
   c'e' un cliente del negozio, browser e cliente si legano. Senza permesso non
   si lega niente; con un no esplicito si avvia la revoca.

Il cookie e l'attributo si scrivono solo con il consenso: senza, `kerdon_eid`
non esiste e non c'e' niente da copiare.

## Cosa deve fare l'endpoint del negozio

| | |
|---|---|
| Chiamare | `GET <indirizzo dell'API>/rest/v1/tracking_id` |
| Autenticarsi | la credenziale di **invio**: firmata dove si puo' (vedi sotto), altrimenti presentata intera in `apikey`. Il token di lettura qui non vale |
| Inoltrare | il permesso del visitatore, e `X-Kerdon-External-Id` con il valore del cookie first-party quando c'e' (solo dal cookie, mai da un parametro che non coincide) |
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

`HttpOnly` non e' richiesto ed e' voluto: i tag del merchant nella pagina
possono doverlo rileggere.

## Cosa viene scritto, e dove

Ogni identificativo coniato o rivisto lascia **una riga per browser** nella
tabella `users` del database del merchant: l'identificativo stesso, l'etichetta
del browser e quella del tipo di dispositivo quando il container le trasmette, il
primo e l'ultimo avvistamento, l'eventuale collegamento al cliente Shopify e il
rimando all'identificativo piu' vecchio quando due browser risultano della stessa
persona.

Non e' un dato anonimo, e non va chiamato cosi': l'identificativo vive nel browser
di una persona e, dal collegamento in poi, dice quali dispositivi usa e quando li
ha usati. La pulizia automatica lato server riguarda **solo le righe anonime**:
quelle mai collegate a un cliente (`shopify_customer_id` vuoto) si cancellano
90 giorni dopo l'ultimo avvistamento (`pruneAnonymousUsers`). **Le righe
collegate a un cliente non vengono potate**: restano finche' non arriva una
revoca o la disinstallazione (vedi "Limiti noti").
Il testo per gli interessati sta in `docs/legal/privacy-policy.it.md`, punto 3.5.

## Il consenso viene prima

Non si conia niente se chi naviga non ha dato il permesso: senza, la risposta
non porta nessun identificativo e non viene scritta nessuna riga. Servono
`analytics` e `marketing` insieme — e' lo stesso identificativo a misurare e ad
attribuire, e non se ne conia mezzo.

**L'assenza di segnale vale come no**, in tutti e due i punti del giro:
nell'endpoint del negozio e nell'app. Nessun valore di ripiego, nessuna regola per
paese scritta da noi: se il negozio non e' in una configurazione che richiede il
consenso, e' Shopify a dire che le finalita' sono permesse, e quel "permesso" si
legge come qualunque altro.

Il container non deve **mai** dichiarare un consenso che il visitatore non ha
dato: sarebbe registrarlo al posto suo. La verifica lo controlla.

### La revoca, e perche' non si perde

Alla revoca il cookie scade e la riga sparisce dal database. Le due meta' della
revoca sono queste, e la prima avviene comunque: `kerdon_eid` scade nella
risposta alla prima chiamata che porta il no.

La seconda non si perde, e non ha bisogno di nessuno script in vetrina:

- l'identificativo passa in un secondo cookie, `kerdon_rv` (`HttpOnly`,
  `Secure`, 30 giorni), nella forma `<no compatto>~<identificativo>`. Serve
  **solo** a cancellare: non e' mai restituito come identificativo, e nessuno
  script della pagina lo legge;
- se Kerdon conferma (2xx) il template risponde `200 []` e `kerdon_rv` scade;
- se non conferma — rete giu', timeout, `429`, `5xx`, qualunque non-2xx, o il
  client configurato male — risponde `503` con `Retry-After` (mai `200`) e
  `kerdon_rv` resta;
- **la chiamata successiva, con qualunque permesso**, ripresenta a Kerdon il no
  registrato e l'identificativo. Finche' `kerdon_rv` c'e' non si conia e non si
  riusa niente; alla conferma, se il permesso c'e', se ne conia uno **nuovo**;
- `kerdon_rv` non si riscrive a ogni tentativo fallito: scade 30 giorni dopo la
  prima volta. Se nel frattempo Kerdon aveva registrato la revoca la completa da
  se'; se non l'aveva mai ricevuta, la riga resta fino alla potatura dei
  visitatori anonimi (solo se anonima, vedi sopra).

Sul server la revoca e' durevole appena registrata: il 2xx dice che la riga di
revoca e' scritta, e il drenaggio la porta a termine anche se il primo tentativo
non riesce. E' anche idempotente: ripetere quella di un identificativo gia'
revocato, o mai visto, risponde `200`. Kerdon risponde `503` solo quando non
riesce a scrivere la riga di revoca.

Chi mette un proprio Worker davanti al container deve lasciar passare i cookie
del negozio verso il container e i `Set-Cookie` di ritorno, e non trasformare un
`503` in un `200`.

## Sulla durata: un massimo tecnico, non una garanzia

Il cookie chiede fino a un anno di vita (`Max-Age`). E' una **richiesta al
browser soggetta al consenso**, non una promessa di conservazione:

- il consenso si puo' ritirare in qualunque momento, e da quell'istante non c'e'
  piu' niente da conservare;
- il browser puo' accorciare la durata per politica propria — Safari lo fa anche
  sui cookie first-party scritti da JavaScript, riducendoli a 7 giorni quando
  rileva pattern di tracciamento cross-site (ITP);
- Firefox con Enhanced Tracking Protection (strict) puo' isolare i cookie per sito,
  anche se first-party, quando l'infrastruttura che li scrive e' classificata come
  tracker;
- il CNAME cloaking verso IP di terzi (Stape, altri CDN) puo' essere rilevato da
  Safari e Firefox: se il CNAME punta a un indirizzo IP noto per il tracciamento,
  il browser puo' trattare il cookie come di terze parti anche se il dominio e'
  quello del negozio;
- la persona puo' cancellare i cookie, o navigare in una sessione privata che non
  ne conserva nessuno.

Quindi: un anno e' il **massimo** che si chiede, non il tempo per cui un
riconoscimento esiste. Dirlo come una durata certa e' il modo in cui, mesi dopo,
qualcuno si accorge che i numeri non tornano e non capisce perche'. La durata
piu' vicina a quel massimo la ottiene il cookie first-party dell'endpoint del
negozio con una rotta same-origin o edge verificata; quella di un cookie emesso
sul nostro dominio sarebbe molto piu' incerta, ed e' esattamente il motivo per cui
questo trasporto esiste.

**Per verificare la persistenza reale** del cookie nei browser principali (Safari
macOS e iOS, Firefox con protezione standard e strict) con il dominio e il CDN di
produzione, segui la checklist in
[`docs/tracking-persistenza-test.md`](tracking-persistenza-test.md). I test
coprono: primo PageView con consenso, ritorno dopo 1 e 7 giorni, rinnovo della
scadenza, revoca del consenso, cancellazione dati del browser, e confronto fra
CNAME verso infrastruttura terza e rotta same-origin.

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

## Limiti noti e cose da fare

- **Righe collegate a un cliente: nessuna potatura automatica.**
  `pruneAnonymousUsers` cancella solo le righe con `shopify_customer_id` vuoto,
  90 giorni dopo l'ultimo avvistamento. Una riga collegata a un cliente resta
  finche' non arriva una revoca o la disinstallazione. Da fare: decidere una
  durata massima anche per queste righe e aggiungerla alla potatura, e
  verificare che la cancellazione di un cliente (`customers/redact`) le
  raggiunga.
- **Tra il no e la chiamata successiva.** Senza script in vetrina, `kerdon_eid`
  scade alla prima chiamata all'endpoint che porta il no, non nell'istante del
  clic sul banner. I tag del merchant che lo leggono nella pagina devono
  guardare il consenso da se'.
- **La revoca riparte solo se la pagina richiama l'endpoint.** Se chi cura il
  tracciamento fa partire la chiamata solo con il consenso, il no non arriva
  mai al container: la chiamata va fatta a ogni pagina (vedi "Chi fa partire la
  chiamata").
