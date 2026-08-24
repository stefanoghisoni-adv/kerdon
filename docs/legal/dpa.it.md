# Accordo sul trattamento dei dati (DPA) — CoreWard

Ultimo aggiornamento: 25 agosto 2026

> Questo accordo si accetta insieme ai termini di servizio, all'installazione
> dell'app.
>
> Traduzione di cortesia. Il testo che vincola le parti è la versione inglese,
> `dpa.md`; in caso di discrepanza prevale quella.

## Le parti

**Titolare del trattamento**: il merchant, cioè il soggetto intestatario del
negozio Shopify su cui CoreWard è installata.

**Responsabile del trattamento**: Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148 Genova (GE), contatto support@coreward.app.

Il merchant decide finalità e mezzi del trattamento dei dati dei propri clienti.
CoreWard li tratta solo per erogare il servizio e solo su sua istruzione.

## 1. Oggetto e durata

CoreWard sincronizza i dati di catalogo, clientela e ordini del negozio Shopify
del merchant verso un progetto database di cui il merchant è intestatario, ne
mantiene aggiornata la copia e ne calcola indicatori di redditività.

L'accordo dura quanto l'installazione dell'app e termina con la disinstallazione.

## 2. Natura e finalità

Raccolta da Shopify, trasformazione, scrittura nel database del merchant,
aggiornamento e lettura controllata. Su richiesta del merchant, scrittura del
costo di un prodotto verso Shopify.

Finalità: consentire al merchant di usare i propri dati commerciali per misurare
la redditività degli ordini e della clientela.

## 3. Categorie di dati e di interessati

**Interessati**: clienti e potenziali clienti del negozio del merchant.

**Dati dei clienti**: identificativo Shopify, indirizzo email, numero di
telefono, nome, cognome, stato e livello del consenso al marketing, totale speso,
numero di ordini, stato cliente, tag, note.

**Dati degli ordini**: identificativo e numero d'ordine, identificativo del
cliente, nome e cognome del cliente, valuta, totali, stato del pagamento, date di
emissione e di eventuale annullamento e, per ogni riga, prodotto, variante,
quantità, prezzo unitario e sconto.

**Esclusioni esplicite**: nessun indirizzo di spedizione o fatturazione, nessun
dato di pagamento, nessun indirizzo email, numero di telefono o nota prelevati
dagli ordini, nessun indirizzo IP, nessun dato di navigazione, nessuna categoria
particolare di dati ai sensi dell'art. 9 GDPR.

**Limite del trattamento**: fra i clienti vengono trattati unicamente i dati di
chi ha prestato il consenso al marketing su Shopify.

## 4. Obblighi del responsabile

CoreWard si impegna a:

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
fornitore. CoreWard vi accede su sua istruzione.

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

CoreWard informa il merchant **senza ingiustificato ritardo** e comunque entro 72
ore dalla scoperta di una violazione che riguardi i suoi dati, indicando natura
dell'evento, dati e interessati coinvolti, conseguenze probabili e misure
adottate.

La procedura completa è pubblica: `INCIDENT-RESPONSE.md` nel repository del
progetto.

## 8. Diritti degli interessati

CoreWard dà seguito alle richieste di accesso e cancellazione che riceve
attraverso i canali previsti da Shopify. Su richiesta di cancellazione di un
cliente, il record corrispondente viene eliminato in via definitiva dal database
del merchant.

## 9. Al termine

Alla disinstallazione dell'app, CoreWard cessa ogni trattamento: la
sincronizzazione si ferma e le credenziali della sessione Shopify vengono
cancellate.

**I dati già sincronizzati restano nel database del merchant**, che ne è
intestatario. Non si tratta di conservazione da parte del responsabile: quei dati
non sono mai stati sull'infrastruttura di CoreWard. Il merchant può cancellarli
in qualsiasi momento dal proprio progetto.

## 10. Trasferimenti extra UE

Il database dell'applicazione risiede nell'Unione Europea (Parigi, Francia), e
nell'Unione Europea avviene anche l'elaborazione: le funzioni dell'applicazione
sono eseguite nella regione di Parigi.

Anche la coda dei lavori di sincronizzazione risiede nell'Unione Europea
(Francoforte, Germania). Vi transitano peraltro esclusivamente identificatori
interni di negozio, nessun dato personale.

Ogni componente gestito da CoreWard si trova quindi nell'Unione Europea, e il
merchant sceglie la regione del proprio database.

I fornitori elencati al punto 5 sono società statunitensi che erogano il
servizio da infrastrutture europee: per le funzioni accessorie che dovessero
comportare un accesso dagli Stati Uniti (assistenza, manutenzione) valgono le
garanzie previste dai rispettivi accordi — clausole contrattuali standard e,
ove applicabile, EU-US Data Privacy Framework.

## 11. Audit

Il merchant può chiedere le informazioni necessarie a verificare il rispetto di
questo accordo, scrivendo a support@coreward.app.
