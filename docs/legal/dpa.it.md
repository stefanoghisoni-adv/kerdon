# Accordo sul trattamento dei dati (DPA) — Kerdon

Ultimo aggiornamento: 2 ottobre 2026
Versione: 1.5

> Questo accordo si accetta insieme ai termini di servizio, all'installazione
> dell'app.
>
> Traduzione di cortesia. Il testo che vincola le parti è la versione inglese,
> `dpa.md`; in caso di discrepanza prevale quella.

## Le parti

**Titolare del trattamento**: il merchant, cioè il soggetto intestatario del
negozio Shopify su cui Kerdon è installata.

**Responsabile del trattamento**: Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148 Genova (GE), contatto support@kerdon.io.

Il merchant decide finalità e mezzi del trattamento dei dati dei propri clienti.
Kerdon li tratta solo per erogare il servizio e solo su sua istruzione.

## 1. Oggetto e durata

Kerdon sincronizza i dati di catalogo, clientela e ordini del negozio Shopify
del merchant verso un progetto database di cui il merchant è intestatario, ne
mantiene aggiornata la copia e ne calcola indicatori di redditività.

L'accordo dura quanto l'installazione dell'app e termina con la disinstallazione.

## 2. Natura e finalità

Raccolta da Shopify, trasformazione, scrittura nel database del merchant,
aggiornamento e lettura controllata.

Verso Shopify Kerdon scrive due sole cose: il **costo di un prodotto**, su
richiesta del merchant, e la **data di nascita di un cliente** — il valore che
sta nel database del merchant, riportato nel metafield del cliente da cui
Kerdon lo legge, quando quel metafield è vuoto e il cliente ha prestato il
consenso al marketing. Nessun altro campo dell'anagrafica del cliente viene
creato o modificato.

Kerdon tratta inoltre, se il merchant attiva la funzione, il **riconoscimento
dei visitatori** del negozio, descritto al punto 3.

Kerdon può inoltre agire sul progetto database del merchant per riaccenderlo
quando il fornitore lo ha messo in pausa. Non è un trattamento nuovo di dati
personali — nessun dato viene letto, scritto o cancellato per farlo — ma è
un'azione automatica sull'infrastruttura del titolare, ed è descritta al punto
6.

Finalità: consentire al merchant di usare i propri dati commerciali per misurare
la redditività degli ordini e della clientela, al netto di quanto ogni ordine è
costato da spedire, imballare e, se reso, far rientrare.

## 3. Categorie di dati e di interessati

**Interessati**: clienti e potenziali clienti del negozio del merchant.

**Dati dei clienti**: identificativo Shopify, indirizzo email, numero di
telefono, nome, cognome, stato e livello del consenso al marketing, totale speso,
numero di ordini, stato cliente, tag, note, indirizzo predefinito (via, CAP,
regione, paese), la data di nascita — letta dal metafield del cliente che il
merchant indica — e un identificativo esterno, che è l'identificativo del browser
da cui la persona sta navigando.

**Dati degli ordini**: identificativo e numero d'ordine, identificativo del
cliente, nome e cognome del cliente, valuta, totali, stato del pagamento, date di
emissione e di eventuale annullamento e, per ogni riga, prodotto, variante,
quantità, prezzo unitario e sconto.

**Dati di spedizione e logistica degli ordini**, trattati per calcolare il costo
logistico di ogni ordine, che viene sottratto dal profitto dell'ordine e, tramite
questo, dal profitto e dal valore nel tempo (LTV) di ciascun cliente:

| Voce | Trattamento | Dove viene conservata |
|---|---|---|
| Paese di spedizione | Codice a due lettere del paese dell'indirizzo di spedizione; sceglie zona e tariffa | Database del merchant, `shipping_country_code` |
| Se l'ordine va spedito | Indicazione di Shopify, letta per interpretare un indirizzo mancante | Non conservata |
| Stato di evasione | Se l'ordine è partito | Database del merchant, `fulfillment_status` |
| Codici di tracciamento | Letti solo per contare i colli distinti, poi scartati | Non conservati, da nessuna parte, log compresi |
| Numero di colli | Quanti colli sono partiti | Database del merchant, `package_count` |
| Opzione di spedizione | Nome dell'opzione scelta al checkout | Database del merchant, `shipping_method` |
| Categoria di consegna | Se quell'opzione è una consegna o un ritiro | Non conservata |
| Peso totale | Peso dell'ordine in grammi | Database del merchant, `total_weight_grams` |
| Numero di articoli | Unità rimaste al cliente, per stimare il peso | Database del merchant, `item_count` |
| Resi | Stato e data di creazione di ogni reso; contano solo i resi aperti o chiusi | Database del merchant, `returned_at` (solo la data) |
| Categoria di imballo | Valore del metafield d'ordine `custom.packaging_category` | Database del merchant, `packaging_category` |
| Costo logistico | Calcolato da Kerdon a partire dalle voci sopra e dalle tariffe del merchant | Database del merchant, `logistics_cost` e `logistics_facts_version` |

Dell'indirizzo di spedizione si chiede a Shopify il solo paese: via, città, CAP e
nome del destinatario non vengono chiesti né conservati. Di un reso si chiedono
soltanto stato e data: né il motivo, né gli articoli resi, né messaggi del
cliente. Le notifiche di ordini e resi che Shopify manda (webhook) possono
contenere quei dati, e altri — indirizzo di spedizione e di fatturazione
completi, email, telefono, codici di tracciamento, motivi dei resi: ogni
notifica viene scartata alla ricezione, e se ne tengono solo gli identificativi
dell'ordine, del reso, del cliente e, per il riconoscimento dei visitatori, del
browser. Del resto niente viene conservato, registrato nei log o inoltrato. Le tariffe del
merchant — zone di spedizione, costi delle opzioni, categorie di imballo e costo
dei resi — sono configurazione conservata nel database di Kerdon e non
contengono dati personali.

**Dati di riconoscimento dei visitatori** (solo se il merchant attiva la
funzione, e solo per i visitatori che hanno prestato il consenso): un
identificativo pseudonimo del browser coniato da Kerdon, l'etichetta del
browser e quella del tipo di dispositivo quando l'endpoint del merchant le
trasmette, il primo e l'ultimo avvistamento, l'unione fra gli identificativi che
risultano della stessa persona e il collegamento all'identificativo del cliente
Shopify. Non è dato anonimo: l'identificativo resta nel browser di una persona e,
una volta collegato a un cliente, è a lei ricollegabile. Per scrivere il
collegamento, l'endpoint del merchant trasmette a Kerdon l'indirizzo email o il
numero di telefono lasciato dalla persona; Kerdon li usa per la sola ricerca
nel database del merchant e non li conserva.

**Cookie.** L'identificativo sta nel browser del visitatore in cookie
first-party che il container server-side del merchant scrive sul dominio del
negozio: `kerdon_eid` (l'identificativo, solo con il consenso; un anno per
impostazione, il massimo richiesto; `Secure`, `SameSite=Lax`, non `HttpOnly`) e
`kerdon_rv` (solo dopo una revoca non ancora confermata da Kerdon, per portare a
termine la cancellazione; al massimo 30 giorni; `Secure`, `HttpOnly`,
`SameSite=Lax`). Il nome di prima, `corew_eid`, non si scrive più. La sezione
3.5 dell'informativa li elenca per intero, con finalità, durata e contenuto.

**Esclusioni esplicite**: nessun dato di pagamento; dagli ordini non viene
chiesto né conservato alcun indirizzo email, numero di telefono, nota o
indirizzo — salvo il paese di spedizione descritto sopra; nessuna etichetta del corriere viene
acquistata o letta, e nessun codice di tracciamento viene conservato; nessun
indirizzo IP; nessuna pagina visitata; nessuna categoria particolare di dati ai
sensi dell'art. 9 GDPR.

L'indirizzo trattato per intero è quello predefinito dell'anagrafica cliente, non
un indirizzo di spedizione o fatturazione ricavato da un ordine; da un ordine si
prende soltanto il paese di spedizione. La data di nascita
non costituisce categoria particolare ai sensi dell'art. 9.

**Limite del trattamento**: fra i clienti vengono trattati unicamente i dati di
chi ha prestato il consenso al marketing su Shopify.

## 4. Obblighi del responsabile

Kerdon si impegna a:

a) trattare i dati solo su istruzione documentata del merchant, salvo obblighi di
legge, dandone comunicazione salvo che la legge lo vieti;

b) vincolare alla riservatezza chiunque abbia accesso ai dati;

c) adottare le misure di sicurezza descritte al punto 6;

d) non ricorrere a sub-responsabili diversi da quelli elencati al punto 5 senza
preventiva informazione al merchant, che può opporsi;

e) assistere il merchant nel rispondere alle richieste degli interessati;

f) assistere il merchant negli obblighi di sicurezza, notifica delle violazioni e
valutazione d'impatto;

g) mettere a disposizione le informazioni necessarie a dimostrare il rispetto di
questi obblighi.

## 5. Sub-responsabili autorizzati

| Fornitore | Ruolo | Dati trattati |
|---|---|---|
| Vercel Inc. | Esecuzione dell'applicazione | Dati in transito durante l'elaborazione |
| Supabase Inc. | Database dell'applicazione | Configurazione, credenziali cifrate, registri |
| Upstash Inc. | Cache dei conteggi mostrati nell'app e, se attivati, contatori anti-abuso delle scritture | Solo identificatore interno di negozio, identificativo pubblico della chiave di invio, finestra temporale e conteggi aggregati; nessun dato personale |

Il database di catalogo e clientela **non** compare in questa tabella: è
intestato al merchant, che ha un rapporto contrattuale diretto con il proprio
fornitore. Kerdon vi accede su sua istruzione.

## 6. Misure di sicurezza

- Cifratura in transito (HTTPS/TLS) su ogni comunicazione
- Cifratura dei segreti a riposo con AES-256-GCM
- Cifratura a riposo e backup cifrati sul database dell'applicazione
- Row Level Security attiva su tutte le tabelle dell'applicazione, senza policy
  di accesso pubblico
- L'interfaccia di lettura è limitata alla sola lettura e alle tabelle previste
  dal piano
- Credenziali distinte per la lettura e per la scrittura, generate in modo
  indipendente, ciascuna ruotabile e revocabile senza toccare l'altra, ciascuna
  con i propri ambiti
- Verifica del consenso a ogni lettura di dati dei clienti
- Registrazione di ogni accesso a dati personali, conservata 12 mesi
- Ambienti di sviluppo e produzione separati, su database distinti
- Accesso ai sistemi di produzione limitato al solo responsabile
- Ripristino della disponibilità del database del merchant: quando il progetto
  risulta in pausa, Kerdon ne chiede la riattivazione prima che la finestra di
  riattivazione si chiuda

**La riattivazione automatica del database del merchant** va detta per intero,
perché è l'unica azione che Kerdon compie sull'infrastruttura del titolare
senza una sua richiesta puntuale. Un progetto database gratuito lasciato
inattivo viene messo in pausa, e dalla pausa non si esce per sempre: chiusa la
finestra di riattivazione il progetto non è più recuperabile e dei dati restano
i soli backup. Kerdon se ne accorge quando una lettura del database fallisce,
lo segnala al merchant dentro l'app e gli offre di riaccenderlo; se il merchant
non lo fa, prima che quella finestra si chiuda la richiesta la inoltra Kerdon,
con le credenziali che il merchant gli ha concesso collegando il proprio
account presso il fornitore. La richiesta riguarda il solo stato del progetto:
nessun dato personale viene letto, scritto o cancellato per effetto di quel
gesto.

Vale come misura di ripristino tempestivo della disponibilità e dell'accesso ai
dati ai sensi dell'art. 32(1), lettera c), GDPR, ed è dichiarata qui perché
valga anche come istruzione documentata del titolare ai sensi dell'art. 28(3),
lettera a): accettando questo accordo il merchant istruisce Kerdon a compierla.
Il merchant può revocare l'istruzione in qualsiasi momento, dall'interruttore
in Impostazioni → Database; l'avviso e il pulsante restano, e sono suoi. Kerdon
non interviene sul database di un negozio che ha disinstallato l'app, di uno di
cui Shopify ha chiesto la cancellazione, o di uno il cui collegamento
all'account del fornitore è decaduto: in quei casi non ne ha né il mandato né
le credenziali.

## 7. Violazioni dei dati

Kerdon informa il merchant **senza ingiustificato ritardo** e comunque entro 72
ore dalla scoperta di una violazione che riguardi i suoi dati, indicando natura
dell'evento, dati e interessati coinvolti, conseguenze probabili e misure
adottate.

La procedura completa è descritta in `INCIDENT-RESPONSE.md`, che forniamo su
richiesta.

## 8. Diritti degli interessati

Kerdon dà seguito alle richieste di accesso e cancellazione che riceve
attraverso i canali previsti da Shopify.

**Accesso**: Kerdon raccoglie dal database del merchant la riga del cliente, i
suoi ordini — dati di spedizione e logistica compresi — e le relative righe, e le righe dei browser a lui collegati.
L'esportazione così ottenuta contiene dati personali e viene conservata sui
sistemi di Kerdon, dove il merchant la scarica dentro l'app con la propria
sessione di amministratore, **per un massimo di 30 giorni**; alla scadenza viene
cancellata.

**Cancellazione**: la riga del cliente viene eliminata in via definitiva dal
database del merchant, insieme alle righe dei browser a lui collegati. Gli ordini
non vengono cancellati — sono scritture contabili che il merchant è tenuto a
conservare (art. 17(3), lettere b ed e, GDPR) — ma vengono privati
dell'identificativo del cliente, del suo nome e cognome e del paese di
spedizione, e marcati con la data della cancellazione (`customer_redacted_at`);
una guardia nel database del merchant impedisce a qualunque scrittura successiva
di ripristinare quei campi. Gli altri dati di spedizione e logistica descrivono
il pacco e non la persona, e restano sull'ordine, con il costo logistico
invariato, perché i costi del merchant restino corretti.

## 9. Al termine

Alla disinstallazione dell'app, Kerdon cessa ogni trattamento: la
sincronizzazione si ferma e le credenziali della sessione Shopify vengono
cancellate.

**I dati già sincronizzati restano nel database del merchant**, che ne è
intestatario, e li può cancellare in qualsiasi momento dal proprio progetto.

Sull'infrastruttura di Kerdon quei dati transitano al momento in cui vengono
scritti o riletti, e in quattro casi limitati vi restano scritti: le riparazioni
in sospeso, che portano l'identificativo Shopify di un cliente e, per la data di
nascita, il valore ancora da riscrivere; il messaggio firmato di una richiesta
privacy, fino alla chiusura della richiesta; l'esportazione preparata per una
richiesta di accesso, per un massimo di 30 giorni; l'identificativo del browser e
quello del cliente su una revoca di consenso, cifrati e azzerati appena la revoca
è applicata. Nessuno dei quattro sopravvive alla propria ragione d'essere.

## 10. Trasferimenti extra UE

Il database dell'applicazione risiede nell'Unione Europea (Parigi, Francia), e
nell'Unione Europea avviene anche l'elaborazione: le funzioni dell'applicazione
sono eseguite nella regione di Parigi.

La coda dei lavori di sincronizzazione vive nel database dell'applicazione,
quindi nella stessa regione. Anche la cache dei conteggi mostrati nell'app
risiede nell'Unione Europea (Francoforte, Germania): vi stanno un identificatore
interno di negozio e dei conteggi aggregati, nessun dato personale.

Ogni componente gestito da Kerdon si trova quindi nell'Unione Europea, e il
merchant sceglie la regione del proprio database.

I fornitori elencati al punto 5 sono società statunitensi che erogano il
servizio da infrastrutture europee: per le funzioni accessorie che dovessero
comportare un accesso dagli Stati Uniti (assistenza, manutenzione) valgono le
garanzie previste dai rispettivi accordi — clausole contrattuali standard e,
ove applicabile, EU-US Data Privacy Framework.

## 11. Audit

Il merchant può chiedere le informazioni necessarie a verificare il rispetto di
questo accordo, scrivendo a support@kerdon.io.
