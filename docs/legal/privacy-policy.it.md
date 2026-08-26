# CoreWard — Informativa sulla privacy

**Ultimo aggiornamento:** 25-08-2026
**Versione:** 1.0

> Traduzione di cortesia. Il testo che vincola le parti è la versione inglese,
> `privacy-policy.md`; in caso di discrepanza prevale quella.

## 1. Chi siamo

CoreWard è un'applicazione per negozi Shopify, gestita da Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148 Genova (GE), Italia, P. IVA IT02705860993. Puoi scriverci a support@coreward.app.

## 2. Il nostro ruolo e il tuo

CoreWard si installa nel tuo negozio Shopify e copia una parte dei dati del negozio in **un database di cui sei intestatario** — un progetto Supabase collegato al tuo account. È questa distinzione a determinare chi risponde di che cosa.

**Tu sei il titolare del trattamento** dei dati del tuo negozio, compresi i dati personali dei tuoi clienti. Decidi tu perché vengono trattati e per quanto tempo conservati.

**Noi siamo responsabili del trattamento** e agiamo su tua istruzione. Trattiamo quei dati solo per fornire le funzioni descritte qui sotto, mai per finalità nostre, e mai per costruire profili o basi di dati che attraversino più negozi.

**Noi siamo titolari** delle poche informazioni che ti riguardano come nostro cliente: l'indirizzo del negozio, il piano attivo, i documenti di fatturazione e la corrispondenza di assistenza.

## 3. Che cosa tratta l'app

### 3.1 Dati del negozio e dell'account

Il dominio del negozio Shopify e il dominio principale, il fuso orario, la valuta di fatturazione, il piano attivo, la lingua preferita e i token di accesso che permettono all'app di dialogare con Shopify per tuo conto. I token sono conservati cifrati.

### 3.2 Catalogo prodotti

Titoli di prodotti e varianti, descrizioni, fornitore, tipo, handle, stato, tag, SKU, codice a barre, prezzo, prezzo di confronto, **costo per articolo**, quantità e politica di magazzino, peso, immagini e valori delle opzioni.

Il costo per articolo è la ragione per cui l'app esiste: è ciò che consente di calcolare il profitto. Quando ne compili uno mancante, su tua istruzione l'app può anche riscriverlo su Shopify.

### 3.3 Dati dei clienti — solo con il consenso al marketing

L'app sincronizza **unicamente i clienti che hanno prestato il consenso al marketing** nel tuo negozio. Di quei clienti tratta: identificativo Shopify, indirizzo email, numero di telefono, nome e cognome, stato e livello del consenso, totale speso, numero di ordini, stato cliente, tag, note, indicatori di email verificata ed esenzione fiscale, date di creazione e aggiornamento.

Tratta inoltre l'**indirizzo predefinito** del cliente — via, CAP, regione e paese — e due campi che restano a tua disposizione: un identificativo esterno e la data di nascita. Questi due l'app non li compila: Shopify non li espone come campi del cliente, e restano vuoti finché non sei tu a decidere da quale metafield leggerli.

Perché l'indirizzo: paese e CAP sono ciò che le piattaforme pubblicitarie usano per riconoscere i tuoi clienti fra i propri utenti, e senza di essi il pubblico che costruisci risulta più piccolo del vero. Per la stessa ragione il numero di telefono viene scritto in sole cifre, prefisso internazionale compreso, e la data di nascita nel formato `AAAAMMGG`: è la forma che quelle piattaforme confrontano.

I clienti che non hanno prestato il consenso non vengono mai copiati nel tuo database.

**Se un cliente revoca il consenso**, il suo record non viene cancellato — cancellarlo distruggerebbe uno storico che potrebbe servirti — ma viene marcato come non più consenziente, e da quel momento ogni richiesta di lettura che lo riguarda viene rifiutata.

### 3.4 Ordini

Dove hai concesso all'app l'accesso agli ordini, vengono trattati: identificativo e numero d'ordine, identificativo del cliente e suo nome e cognome, valuta, totale, stato del pagamento, data di annullamento, data dell'ordine e, per ogni riga, prodotto e variante, quantità, prezzo unitario pagato e sconto di riga.

Dagli **ordini** l'app deliberatamente **non** preleva indirizzi, indirizzi email, numeri di telefono, note dell'ordine o dati di pagamento. Al calcolo del profitto non servono, quindi non vengono presi.

L'indirizzo del cliente descritto al punto 3.3 è cosa diversa: è l'indirizzo predefinito dell'anagrafica, di chi ha prestato il consenso al marketing, e non viene ricavato dagli ordini.

### 3.5 Registri operativi

Per far funzionare l'app e assisterti conserviamo, nel nostro database: un record di ogni sincronizzazione (tipo, esito, orari e quanti record sono stati aggiunti, aggiornati o rimossi), voci a livello di prodotto che indicano quali prodotti sono cambiati, gli addebiti di fatturazione e i registri di accesso all'interfaccia di lettura, con il solo esito e stato HTTP.

Quanto ai **clienti**, nel nostro database ci sono **soltanto conteggi**. Nessun nome, indirizzo email, numero di telefono o identificativo di un cliente viene scritto sui nostri sistemi dalla sincronizzazione.

## 4. Dove risiedono i dati

**I tuoi dati vivono in un database tuo.** Il progetto Supabase collegato in configurazione appartiene al tuo account Supabase, nella regione che hai scelto. Non ne siamo intestatari, non possiamo trasferirlo e non possiamo accedervi dopo che hai scollegato l'app.

**Il nostro database** conserva i registri operativi descritti sopra, insieme alla configurazione del negozio e alle credenziali cifrate. È ospitato nell'Unione Europea.

## 5. Chi altro è coinvolto

| Fornitore | Finalità | Ubicazione |
|---|---|---|
| Shopify | Origine dei dati di negozio, prodotti, clienti e ordini; fatturazione | Secondo i termini di Shopify |
| Supabase | Il tuo database e il nostro | Unione Europea |
| Vercel | Hosting dell'applicazione | Unione Europea |
| Upstash | Coda dei lavori di sincronizzazione | Unione Europea |

**Non vendiamo dati.** Né i tuoi, né quelli dei tuoi clienti, a nessuno e in nessuna forma. E non li usiamo per addestrare modelli.

Oltre ai fornitori elencati qui sopra — che agiscono su nostra istruzione e non per conto proprio — non trasmettiamo dati a nessun altro. In particolare **non siamo noi** a inviarli a piattaforme pubblicitarie o di analisi.

Quello che l'app fa è portare i dati **nel tuo database** e metterli a tua disposizione. Da lì in poi decidi tu: se li usi per costruire un pubblico su una piattaforma pubblicitaria, quell'invio lo fai tu, il titolare del trattamento sei tu, e la base giuridica è il consenso che il cliente ha prestato nel tuo negozio. È esattamente la ragione per cui l'app sincronizza soltanto chi quel consenso l'ha dato, e smette di rispondere per chi lo revoca.

## 6. Sicurezza

I token di accesso e le chiavi del database sono cifrati a riposo con AES-256-GCM. La chiave privilegiata del tuo database non viene mai inviata a un browser.

Le tabelle create dall'app nel tuo database hanno la row-level security attiva e nessuna policy pubblica: con una chiave pubblica non sono leggibili.

L'interfaccia di lettura richiede un token emesso per il tuo negozio, è limitata alla sola lettura e rifiuta le richieste relative a clienti che hanno revocato il consenso.

Le richieste provenienti da Shopify sono verificate per firma prima di essere eseguite.

## 7. Per quanto tempo restano i dati

I dati nel **tuo** database restano per il tempo che decidi tu. L'app non li cancella a scadenza.

**Quando disinstalli l'app**, i tuoi dati restano dove sono — nel tuo database, che rimane tuo — e la nostra sessione con il negozio termina. Conserviamo i nostri registri operativi e di fatturazione per il tempo richiesto dagli obblighi contabili e di legge.

**Quando Shopify ci chiede di cancellare il negozio** — la richiesta di redaction inviata 48 ore dopo la disinstallazione — eliminiamo dai nostri sistemi la configurazione del negozio, le credenziali e i registri operativi. Non tocchiamo il tuo database: non è nostro da cancellare.

## 8. Richieste dei tuoi clienti

Shopify ci inoltra automaticamente le richieste privacy dei clienti, e l'app vi dà seguito.

**Richiesta di accesso** — raccogliamo il record sincronizzato del cliente perché tu possa fornirlo.

**Richiesta di cancellazione** — il record del cliente viene eliminato in via definitiva dal tuo database, e l'operazione viene registrata nei tuoi log.

Se un cliente si rivolge direttamente a te, puoi anche cancellarne il record da solo: il database è tuo.

## 9. I tuoi diritti

Dove agiamo da titolari per i dati del tuo account, puoi chiedere accesso, rettifica, cancellazione, limitazione, portabilità od opporti al trattamento scrivendo a support@coreward.app. Hai inoltre il diritto di proporre reclamo all'autorità di controllo competente.

Dove agiamo da responsabili, le richieste che riguardano i tuoi clienti vanno indirizzate a te in quanto titolare; noi ti assistiamo nel rispondere.

## 10. Modifiche

Se cambiamo il modo in cui l'app tratta i dati, aggiorniamo questa pagina e la data in cima. Le modifiche sostanziali vengono annunciate dentro l'app prima di avere effetto.
