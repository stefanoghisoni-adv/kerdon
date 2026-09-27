# Dichiarazione dei dati cliente protetti

Cosa rispondere nel modulo **Protected customer data** della Partner Dashboard.

Non è un documento legale: è la traccia da cui compilare quel modulo, e serve a
una cosa sola — che quanto dichiarato là combaci con quanto l'app fa davvero e
con quanto scrivono privacy policy e DPA. Il revisore confronta le tre cose, e
una differenza fra loro è un motivo di rifiuto anche quando il comportamento
dell'app è ineccepibile.

Ultimo allineamento: 27 settembre 2026, con i dati di spedizione e logistica
degli ordini (informativa 1.4). Il 17 settembre: la data di nascita riscritta
verso Shopify, il riconoscimento dei visitatori e la separazione fra la
credenziale che legge e quella che scrive.

## Livello richiesto

**Protected customer data + campi (Level 2).** Non basta il livello base: l'app
tratta nome, email, telefono e indirizzo, che sono campi protetti a sé stanti.

## Campi da dichiarare, e perché

| Campo | Motivazione da dichiarare |
|---|---|
| Nome e cognome | Identificare il cliente negli elenchi di redditività che il merchant consulta nell'app. |
| Indirizzo email | Chiave con cui il merchant riconosce i propri clienti negli strumenti di marketing collegati al proprio database. |
| Telefono | Stessa funzione dell'email come chiave di riconoscimento, per le piattaforme che la usano. |
| Indirizzo (via, città, CAP, regione, paese) | Paese e CAP sono i campi con cui le piattaforme pubblicitarie riconoscono i clienti fra i propri utenti: senza, il pubblico costruito dal merchant risulta più piccolo del reale. |
| Indirizzo di spedizione dell'ordine — solo il paese | Il paese sceglie la zona e la tariffa di spedizione con cui si calcola il costo logistico dell'ordine, che si sottrae dal profitto per ordine e per cliente. Via, città, CAP e nome del destinatario non vengono chiesti né conservati; la notifica di Shopify può contenerli, e viene scartata alla ricezione. |
| Data di nascita (metafield del cliente) | Le piattaforme pubblicitarie la confrontano nel formato `AAAAMMGG` per riconoscere i clienti. L'app la legge dal metafield indicato dal merchant e, quando il merchant ha il dato e Shopify no, **la riscrive nel metafield del cliente su Shopify**. |

**Va dichiarata anche la scrittura verso Shopify.** Sono due, e sono le uniche:
il costo per articolo su `inventory_items` e la data di nascita nel metafield del
cliente. La seconda è una scrittura di dato personale, e va detta: l'app non crea
clienti e non modifica nome, email, telefono o indirizzo di nessuno.

**Il riconoscimento dei visitatori va dichiarato fra i dati raccolti**, anche se
non è uno dei campi protetti dell'elenco di Shopify. L'app conia un
identificativo pseudonimo del browser, conserva l'etichetta del browser e quella
del tipo di dispositivo quando il container del merchant le trasmette, il primo e
l'ultimo avvistamento, l'unione fra gli identificativi della stessa persona e il
collegamento al cliente Shopify. **Non è un dato anonimo**: resta nel browser di
una persona ed è a lei ricollegabile appena il collegamento esiste. Si scrive solo
con il consenso del visitatore; le righe mai collegate a un cliente si cancellano
dopo 90 giorni.

**Vanno dichiarati i dati di spedizione e logistica degli ordini** (decisione
DEC-03: il trattamento resta, e si dichiara per intero). L'elenco completo è
nella sezione che segue.

**Non** si dichiarano — perché l'app non li tratta: dati di pagamento, indirizzi
completi prelevati dagli ordini (dell'indirizzo di spedizione si prende solo il
paese), email, telefoni e note degli ordini, etichette dei corrieri, motivi e
contenuto dei resi, indirizzo IP, pagine visitate.

## Dati di spedizione e logistica degli ordini

La fonte di verità è `app/lib/legal/order-data-inventory.ts`. Il test
`order-data-inventory.test.ts` confronta quell'inventario con i campi che l'app
chiede davvero a Shopify (ogni query sugli ordini, compresi i completamenti e il
recupero dello storico), con le colonne della tabella `orders` e con le tabelle
di questo file, dell'informativa e del DPA: un campo nuovo nel codice e non qui
fa fallire la build.

**Finalità, per tutte le voci.** Calcolare il costo logistico di ogni ordine —
spedizione, imballo e, se l'ordine è tornato, rientro — e sottrarlo dal profitto
dell'ordine, e da lì dal profitto e dal valore nel tempo (LTV) di ciascun
cliente. Senza, il profitto risulterebbe più alto del vero.

| Voce | Campo Shopify (GraphQL, sull'ordine) | Dove finisce | Alla cancellazione del cliente |
|---|---|---|---|
| Paese di spedizione | `shippingAddress.countryCodeV2` | Database del merchant, `shipping_country_code` | Azzerato |
| Se l'ordine va spedito | `requiresShipping` | Non conservato: usato durante l'elaborazione | Niente da cancellare |
| Stato di evasione | `displayFulfillmentStatus`, `fulfillments.status` | Database del merchant, `fulfillment_status` | Resta sull'ordine anonimo |
| Codici di tracciamento | `fulfillments.trackingInfo.number` | Non conservati: si contano i distinti e si scartano, nemmeno nei log | Niente da cancellare |
| Numero di colli | ricavato da `fulfillments` | Database del merchant, `package_count` | Resta sull'ordine anonimo |
| Opzione di spedizione | `shippingLines.nodes.title` | Database del merchant, `shipping_method` | Resta sull'ordine anonimo |
| Categoria di consegna | `shippingLines.nodes.deliveryCategory` | Non conservata: usata durante l'elaborazione | Niente da cancellare |
| Peso totale | `totalWeight` | Database del merchant, `total_weight_grams` | Resta sull'ordine anonimo |
| Numero di articoli | `lineItems.nodes.currentQuantity` | Database del merchant, `item_count` | Resta sull'ordine anonimo |
| Resi | `returns.nodes.status`, `returns.nodes.createdAt` | Database del merchant, `returned_at` (solo la data del primo reso aperto o chiuso) | Resta sull'ordine anonimo |
| Categoria di imballo | metafield d'ordine `custom.packaging_category` | Database del merchant, `packaging_category` | Resta sull'ordine anonimo |
| Costo logistico | calcolato dall'app | Database del merchant, `logistics_cost` e `logistics_facts_version` | Resta sull'ordine anonimo |

**Dove.** Tutto quello che riguarda un ordine sta nel database del merchant, un
progetto Supabase suo, che controlla lui. Nel database di Kerdon resta solo la
configurazione che il merchant imposta — zone di spedizione, tariffe, costi delle
opzioni, categorie di imballo, costo di un reso — che non contiene dati dei
clienti.

**Le notifiche di Shopify.** I webhook degli ordini (`orders/create`,
`orders/updated`, `refunds/create`, `orders/delete`) e dei resi
(`returns/approve`, `decline`, `cancel`, `close`, `reopen`) arrivano con il corpo
intero che Shopify manda: indirizzo di spedizione e di fatturazione completi,
email, telefono, codici di tracciamento, motivi dei resi. L'app non li chiede e
non li conserva: il corpo viene scartato alla ricezione, e nella posta in arrivo
restano i soli identificativi (ordine o reso, cliente, browser degli attributi
del carrello), cancellati 7 giorni dopo la chiusura. Niente del resto finisce
nei log — nemmeno in quelli d'errore, che nominano topic e negozio — né nella
lettera morta. Se manca l'intestazione `X-Shopify-Webhook-Id`, il corpo entra
in un'impronta SHA-256 che fa da identificativo della consegna: a senso unico.

**Conservazione.** Queste voci vivono sull'ordine: restano quanto l'ordine, per il
tempo che decide il merchant, e se ne vanno quando l'ordine viene cancellato su
Shopify (webhook `orders/delete`).

**Esportazione e cancellazione.** La richiesta di accesso (`customers/data_request`)
esporta le righe intere degli ordini della persona, quindi tutte le colonne
qui sopra. La richiesta di cancellazione (`customers/redact`) azzera sugli ordini
della persona identificativo, nome, cognome e paese di spedizione, e li marca con
`customer_redacted_at`: da lì un trigger nel database del merchant
(`kerdon_orders_keep_redacted`) impedisce a sincronizzazione, webhook, recupero
dello storico e ricalcolo di rimetterli, e tiene il costo logistico già
calcolato. Le altre voci descrivono il pacco e non la persona, e restano
sull'ordine, non più collegato alla persona, come il totale e le righe. `shop/redact` cancella la configurazione del negozio dal
database di Kerdon, tariffe comprese; il database del merchant resta suo.

## Le risposte alle domande del modulo

**Perché ti servono questi dati.** L'app copia il catalogo e i clienti del
negozio nel database del merchant — un database suo, che lui controlla — perché
possa calcolare il profitto per prodotto e per cliente e alimentare i propri
strumenti di marketing.

La sincronizzazione va da Shopify al database del merchant, e sui nostri sistemi
resta in via ordinaria il solo conteggio delle corse. I dati passano dalla nostra
infrastruttura mentre vengono scritti, e possono passarci di nuovo quando il
merchant li rilegge attraverso l'interfaccia di lettura — su sua istruzione, per
finalità che decide lui.

Quattro eccezioni, e vanno dichiarate perché sono riferimenti a una persona
scritti da noi: le riparazioni in sospeso (identificativo Shopify del cliente e,
per la data di nascita, il valore ancora da riscrivere); il messaggio firmato di
una richiesta privacy, fino alla chiusura; l'esportazione preparata per una
richiesta di accesso, al massimo 30 giorni; l'identificativo del browser e quello
del cliente su una revoca di consenso, cifrati e azzerati appena la revoca è
applicata.

Non vendiamo i dati, e non siamo noi a inviarli a piattaforme pubblicitarie:
quello lo fa il merchant, che di quel trattamento è titolare.

**Rispetti le decisioni dei clienti di rifiutare la vendita dei propri dati?**
→ **Sì.** L'app sincronizza unicamente i clienti che hanno prestato il consenso
al marketing. Quando un cliente lo revoca il suo record non viene cancellato — la
cancellazione distruggerebbe uno storico del merchant — ma viene marcato come non
più consenziente, e da quel momento ogni richiesta di lettura che lo riguarda
viene rifiutata.

**Processo decisionale automatizzato con effetti legali o rilevanti?**
→ **Non applicabile.** L'app calcola redditività per il merchant. Nessuna
decisione viene presa su un singolo cliente: nessun punteggio, nessun prezzo
personalizzato, nessun servizio negato.

**Quali informazioni chiedi ai clienti, e per quali finalità.** Nome, email,
telefono, indirizzo e data di nascita, per analisi, marketing e pubblicità; dagli
ordini, il paese di spedizione e i fatti della spedizione e dei resi elencati
sopra, per calcolare il costo logistico e quindi il profitto; più
l'identificativo pseudonimo del browser con cui il negozio riconosce chi torna,
quando il merchant attiva quella funzione e il visitatore ha dato il consenso.

**Conservazione.** I dati vivono nel database del merchant, che ne è titolare e
decide quanto tenerli. Alla disinstallazione le tabelle e i dati **restano dove
sono**: cancellarli distruggerebbe il patrimonio informativo del merchant senza
che lui l'abbia chiesto. L'unica scadenza che l'app applica da sé è sulle righe
dei browser mai collegati a un cliente, cancellate dopo 90 giorni. I dati di
spedizione e logistica degli ordini restano quanto l'ordine e se ne vanno con
lui (`orders/delete`); la richiesta di accesso li esporta, quella di
cancellazione azzera il paese e marca l'ordine (`customer_redacted_at`) perché
non torni. Il corpo delle notifiche di Shopify non si conserva: viene scartato
alla ricezione.

Sui nostri sistemi restano i conteggi delle sincronizzazioni, il registro degli
accessi all'interfaccia di lettura (solo esito e stato HTTP, 12 mesi) e le
quattro eccezioni elencate sopra, ciascuna con la propria scadenza.

## Tre cose da verificare prima di ogni invio

**Che la dichiarazione copra le due scritture verso Shopify.** `date_of_birth` ed
`external_id` non sono più colonne vuote: la prima si legge dal metafield indicato
dal merchant e si **riscrive** su Shopify quando lì è vuota; la seconda la scrive
il riconoscimento dei visitatori, con l'identificativo del browser da cui la
persona sta navigando. La data di nascita non è categoria particolare ai sensi
dell'art. 9 GDPR, ma è un dato personale in più, e la direzione della scrittura
va dichiarata insieme al campo.

**Che la separazione fra lettura e scrittura sia raccontata.** Il token con cui
il merchant legge i propri dati non è quello con cui si scrivono le righe del
riconoscimento visitatori: sono due credenziali generate in modo indipendente,
ognuna con i propri ambiti, la propria rotazione e la propria revoca. Sugli
endpoint che scrivono vale soltanto la credenziale di invio; il token di lettura
viene rifiutato. Se il modulo chiede quali misure proteggono i dati, questa è fra
le prime da nominare — ed è anche la risposta a «il token di lettura può
scrivere?», che è «no», senza date e senza eccezioni.

**Che i tre documenti dicano la stessa cosa.** Questo file, la privacy policy
(`privacy-policy.it.md`, `privacy-policy.md`, `privacy-policy.html`) e il DPA
(`dpa.it.md`, `dpa.md`). Un campo aggiunto al codice e non a tutti e tre è la
differenza che il revisore trova. Per gli ordini lo controlla
`order-data-inventory.test.ts`; per clienti e visitatori va ancora fatto a mano.

**Che una modifica sostanziale dell'informativa sia annunciata in app.** La
sezione 10 lo promette. L'avviso in app non esiste ancora ed è nella lista
«Prima del lancio» di `CHANGELOG.md`, insieme alla voce per la 1.4.

**Che gli scope dichiarati siano quelli veri.** La fonte di verità è `scopes` in
`shopify.app.toml`; `SHOPIFY_SCOPES` in `.env.example` e nel README deve ripetere
quella riga parola per parola. Oggi sono: `read_products`, `read_inventory`,
`write_inventory`, `read_customers`, `write_customers`, `read_publications`,
`read_themes`, `read_orders`, `read_all_orders`, `read_shipping`, `read_returns`.
Fra questi, `write_customers` serve **soltanto** ad abilitare la definizione del
metafield "Data di nascita" e a scrivere il valore di quel metafield quando il
merchant ha il dato e Shopify no: se il modulo chiede a cosa serve un permesso di
scrittura sui clienti, la risposta è questa e nient'altro.

## Per il proprietario: cosa spuntare nella Partner Dashboard

Partner Dashboard → app Kerdon → **API access** → **Protected customer data
access** → *Request access*. Da compilare prima dell'invio in revisione, e da
rifare se l'inventario cambia.

1. **Protected customer data (livello 1): sì.** L'app legge clienti e ordini.
   Finalità da spuntare: funzionalità dell'app e analisi (il profitto per ordine
   e per cliente); per i clienti con consenso anche marketing/pubblicità, perché
   il merchant li usa per i propri pubblici.
2. **Campi protetti (livello 2), uno per uno:**
   - [ ] **Name** — nome e cognome del cliente, sull'anagrafica e sull'ordine
     (`customer.firstName`, `customer.lastName`).
   - [ ] **Email** — anagrafica dei clienti con consenso.
   - [ ] **Phone** — anagrafica dei clienti con consenso.
   - Da scrivere nella motivazione di Name, Email, Phone e Address: i webhook
     degli ordini e dei resi consegnano anche email, telefono e indirizzo
     completo (spedizione e fatturazione) di **ogni** ordine; l'app non li
     chiede e non li conserva, il corpo viene scartato alla ricezione e se ne
     tengono i soli identificativi.
   - [ ] **Address** — due usi, da scrivere tutti e due nella motivazione:
     l'indirizzo predefinito dei clienti con consenso (per i pubblici) e il
     **solo paese** dell'indirizzo di spedizione dell'ordine
     (`shippingAddress.countryCodeV2`, per il costo logistico). Senza questo
     campo Shopify oscura `shippingAddress` e il paese non arriva: l'app lo
     tratta come "sconosciuto" e non calcola la spedizione.
3. **Dati da nominare nella descrizione, anche se non sono campi di livello 2**:
   stato di evasione e spedizioni (`fulfillments`), codici di tracciamento letti
   solo per contare i colli e **mai conservati**, opzione di spedizione e
   categoria di consegna, peso, resi (solo stato e data), metafield
   `custom.packaging_category`, costo logistico calcolato. Testo pronto:
   «Kerdon reads fulfilment status, tracking numbers (only to count parcels; they
   are never stored), shipping method, total weight, return status and date, and
   the shipping country, to calculate each order's shipping, packaging and return
   cost and subtract it from profit per order and per customer. The results are
   stored in the merchant's own database.»
4. **Scope che lo motivano**: `read_orders`, `read_all_orders`, `read_shipping`
   (le zone di spedizione del negozio, per le tariffe), `read_returns` (resi e
   loro webhook).
5. **Conservazione e cancellazione**: rispondere con il paragrafo
   «Conservazione» della sezione «Le risposte alle domande del modulo» qui
   sopra (il dettaglio per voce è in «Dati di spedizione e logistica degli
   ordini»): nel database del merchant, finché c'è l'ordine; esportati con
   `customers/data_request`; paese azzerato e ordine marcato
   (`customer_redacted_at`) con `customers/redact`.
6. **Informativa da linkare**: `https://api.kerdon.io/policies/privacy-policy`,
   versione 1.4 del 27-09-2026 o successiva.
