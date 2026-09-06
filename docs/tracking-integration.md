# L'identificativo del visitatore: come si collega

Questo documento descrive **l'unico trasporto supportato** per l'identificativo
con cui CoreWard riconosce chi torna sul negozio. Non e' una fra piu' opzioni:
e' quella che funziona, e le altre sono state provate e scartate.

## In una riga

Chi chiama CoreWard e' un **endpoint first-party del negozio** — un container
server-side su un sottodominio suo, un worker di CDN, il backend del merchant —
mai il browser.

## Perche' non il browser

Tre motivi, e ognuno basterebbe.

**Il cookie sarebbe di terze parti.** Un cookie `SameSite=None; Secure` emesso
dal dominio di CoreWard, letto dentro la pagina del negozio, e' di terze parti:
Safari lo cancella dopo sette giorni quando lo accetta, e spesso non lo accetta;
Firefox lo isola per sito. Un identificativo che deve durare un anno non puo'
vivere li'.

**Non c'e' CORS, ed e' voluto.** Il progetto non dichiara nessun
`Access-Control-Allow-Origin` e non risponde a `OPTIONS`: una chiamata dalla
vetrina fallirebbe il controllo preliminare del browser prima ancora di partire.
(Prima si dichiarava `Access-Control-Expose-Headers`, che senza
`Allow-Origin` non serve a niente: e' stato tolto, perche' prometteva qualcosa
che non e' mai stato vero.)

**Il token finirebbe in chiaro.** Una chiamata dalla pagina dovrebbe portarsi
dietro il token di lettura del negozio, che diventerebbe leggibile da chiunque
apra gli strumenti di sviluppo. Quel token vive dove deve vivere: nella pagina
Impostazioni dell'app, dietro sessione amministratore, da dove il merchant lo
copia dentro il proprio container.

## Il giro completo

### Prima visita

1. Il visitatore apre una pagina del negozio.
2. Il tag chiama **l'endpoint del negozio** (es. `https://sgtm.negozio.it/...`),
   non CoreWard.
3. Quell'endpoint chiama CoreWard con il token di lettura, **senza**
   identificativo: non ne ha ancora uno.
4. CoreWard ne conia uno e lo restituisce nell'header
   `X-CoreW-External-Id` (e nel corpo, come `external_id`).
5. **L'endpoint del negozio pianta il cookie**, dal proprio dominio, con il
   valore ricevuto. E' un cookie first-party: nessun browser lo tratta da
   estraneo.

### Visite successive

1. Il tag chiama di nuovo l'endpoint del negozio.
2. L'endpoint legge il **proprio** cookie first-party.
3. Lo passa a CoreWard in uno di questi due modi:
   - header `X-CoreW-External-Id: corew_...` — la via normale;
   - parametro di query `existing_external_id=corew_...` — dove l'header non si
     puo' aggiungere, cosa che certi template di tag non permettono.
4. CoreWard **restituisce lo stesso identificativo**, senza coniarne uno nuovo.

Se il valore che arriva non ha la forma giusta viene trattato come assente e se
ne conia uno buono: e' anche cio' che impedisce a qualcuno di farsi assegnare un
identificativo scelto da lui.

## Cosa deve fare l'endpoint del negozio

| | |
|---|---|
| Chiamare | `GET https://api.coreward.app/rest/v1/tracking_id` |
| Autenticarsi | header `apikey: <token di lettura>` oppure `Authorization: Bearer <token>` |
| Inoltrare | `X-CoreW-External-Id` con il valore del cookie first-party, quando c'e' |
| Leggere | l'header `X-CoreW-External-Id` della risposta |
| Piantare | il cookie `corew_eid` **dal proprio dominio**, con quel valore |

Il cookie va emesso dall'endpoint del negozio, non da CoreWard: e' quel dominio
a renderlo first-party, ed e' l'unica ragione per cui dura.

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

CoreWard non conia niente se chi naviga non ha dato il permesso: senza, la
risposta non porta nessun identificativo e non viene scritta nessuna riga. Il
permesso si legge dai segnali del Customer Privacy di Shopify, che l'endpoint
del negozio inoltra insieme alla chiamata. Alla revoca, le scritture successive
si fermano.

Il container non deve **mai** dichiarare un consenso che il visitatore non ha
dato: sarebbe registrarlo al posto suo.

## Sulla durata

Il cookie chiede un anno di vita (`Max-Age`). E' una richiesta al browser, non
una garanzia: il browser puo' accorciarla per politica, la persona puo'
cancellare i cookie, una sessione privata non ne conserva nessuno. La durata
vera la ottiene il cookie first-party dell'endpoint del negozio; quella del
cookie che CoreWard emette sul proprio dominio e' molto piu' incerta, ed e'
esattamente il motivo per cui questo trasporto esiste.

## Il formato dell'identificativo

`corew_` seguito da 32 caratteri casuali. Non contiene altro: non l'ora in cui
e' stato coniato, non il negozio, non il dispositivo.

Gli identificativi del formato precedente — `corew_<millisecondi>_<32
caratteri>` — restano validi e vengono riconosciuti: sono nei browser delle
persone, e rifiutarli vorrebbe dire coniarne uno nuovo a chiunque torni. Non se
ne creano piu' di nuovi in quella forma.
