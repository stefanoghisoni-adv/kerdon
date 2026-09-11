# Accordo sul trattamento dei dati (DPA) — Kerdon

Ultimo aggiornamento: 6 settembre 2026

> Questo accordo si accetta insieme ai termini di servizio, all'installazione
> dell'app.
>
> Traduzione di cortesia. Il testo che vincola le parti è la versione inglese,
> `dpa.md`; in caso di discrepanza prevale quella.

## Le parti

**Titolare del trattamento**: il merchant, cioè il soggetto intestatario del
negozio Shopify su cui Kerdon è installata.

**Responsabile del trattamento**: Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148 Genova (GE), contatto support@coreward.app.

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

Finalità: consentire al merchant di usare i propri dati commerciali per misurare
la redditività degli ordini e della clientela.

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

**Esclusioni esplicite**: nessun dato di pagamento; dagli ordini non viene
prelevato alcun indirizzo, indirizzo email, numero di telefono o nota; nessun
dato di spedizione — nessun corriere, codice di tracciamento, etichetta o costo
di spedizione, poiché le etichette vengono acquistate fuori da Shopify e di quel
che riguarda la consegna resta solo quanto il cliente ha pagato al checkout;
nessun indirizzo IP; nessuna pagina visitata; nessuna categoria particolare di
dati ai sensi dell'art. 9 GDPR.

L'indirizzo trattato è quello predefinito dell'anagrafica cliente, non un
indirizzo di spedizione o fatturazione ricavato da un ordine. La data di nascita
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
| Upstash Inc. | Coda dei lavori | Solo identificatori interni di negozio |

Il database di catalogo e clientela **non** compare in questa tabella: è
intestato al merchant, che ha un rapporto contrattuale diretto con il proprio
fornitore. Kerdon vi accede su sua istruzione.

## 6. Misure di sicurezza

- Cifratura in transito (HTTPS/TLS) su ogni comunicazione
- Cifratura dei segreti a riposo con AES-256-GCM
- Cifratura a riposo e backup cifrati sul database dell'applicazione
- Row Level Security attiva su tutte le tabelle dell'applicazione, senza policy
  di accesso pubblico
- Accesso in sola lettura ai dati del merchant, limitato alle tabelle previste
  dal piano
- Verifica del consenso a ogni lettura di dati dei clienti
- Registrazione di ogni accesso a dati personali, conservata 12 mesi
- Ambienti di sviluppo e produzione separati, su database distinti
- Accesso ai sistemi di produzione limitato al solo responsabile

## 7. Violazioni dei dati

Kerdon informa il merchant **senza ingiustificato ritardo** e comunque entro 72
ore dalla scoperta di una violazione che riguardi i suoi dati, indicando natura
dell'evento, dati e interessati coinvolti, conseguenze probabili e misure
adottate.

La procedura completa è pubblica: `INCIDENT-RESPONSE.md` nel repository del
progetto.

## 8. Diritti degli interessati

Kerdon dà seguito alle richieste di accesso e cancellazione che riceve
attraverso i canali previsti da Shopify.

**Accesso**: Kerdon raccoglie dal database del merchant la riga del cliente, i
suoi ordini e le relative righe, e le righe dei browser a lui collegati.
L'esportazione così ottenuta contiene dati personali e viene conservata sui
sistemi di Kerdon, dove il merchant la scarica dentro l'app con la propria
sessione di amministratore, **per un massimo di 30 giorni**; alla scadenza viene
cancellata.

**Cancellazione**: la riga del cliente viene eliminata in via definitiva dal
database del merchant, insieme alle righe dei browser a lui collegati. Gli ordini
non vengono cancellati — sono scritture contabili che il merchant è tenuto a
conservare (art. 17(3), lettere b ed e, GDPR) — ma vengono privati
dell'identificativo del cliente e del suo nome e cognome.

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

Anche la coda dei lavori di sincronizzazione risiede nell'Unione Europea
(Francoforte, Germania). Vi transitano peraltro esclusivamente identificatori
interni di negozio, nessun dato personale.

Ogni componente gestito da Kerdon si trova quindi nell'Unione Europea, e il
merchant sceglie la regione del proprio database.

I fornitori elencati al punto 5 sono società statunitensi che erogano il
servizio da infrastrutture europee: per le funzioni accessorie che dovessero
comportare un accesso dagli Stati Uniti (assistenza, manutenzione) valgono le
garanzie previste dai rispettivi accordi — clausole contrattuali standard e,
ove applicabile, EU-US Data Privacy Framework.

## 11. Audit

Il merchant può chiedere le informazioni necessarie a verificare il rispetto di
questo accordo, scrivendo a support@coreward.app.
