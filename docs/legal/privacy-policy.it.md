# Kerdon — Informativa sulla privacy

**Ultimo aggiornamento:** 17-09-2026
**Versione:** 1.2

> Traduzione di cortesia. Il testo che vincola le parti è la versione inglese,
> `privacy-policy.md`; in caso di discrepanza prevale quella.

## 1. Chi siamo

Kerdon è un'applicazione per negozi Shopify, gestita da Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148 Genova (GE), Italia, P. IVA IT02705860993. Puoi scriverci a support@kerdon.io.

## 2. Il nostro ruolo e il tuo

Kerdon si installa nel tuo negozio Shopify e copia una parte dei dati del negozio in **un database di cui sei intestatario** — un progetto Supabase collegato al tuo account. È questa distinzione a determinare chi risponde di che cosa.

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

Tratta inoltre l'**indirizzo predefinito** del cliente — via, città, CAP, regione e paese — la **data di nascita** e un **identificativo esterno**. Questi ultimi due non restano vuoti: li scrive l'app, e come li scrive è detto qui sotto.

**La data di nascita.** Shopify non la espone come campo dell'anagrafica: vive in un metafield del cliente. L'app legge il campo che indichi tu — il campo standard di Shopify `facts.birth_date`, oppure un metafield di tipo data che esiste già nel tuo negozio — e ne copia il valore nel tuo database. Dalla tab Clienti puoi anche chiedere all'app di attivare per te la definizione standard `facts.birth_date`: è a questo che serve il permesso di scrittura sui clienti che l'app richiede all'installazione.

**La data di nascita viene anche riscritta verso Shopify.** Quando nel tuo database la data c'è e il metafield su Shopify è vuoto, l'app scrive quel valore dentro il metafield da cui legge. Vale solo per i clienti che hanno prestato il consenso al marketing, solo se hai indicato un campo da cui leggere la data, e solo se quel campo è di tipo data. L'app non riscrive mai un valore che su Shopify esiste già, non scrive niente se ciò che trova nel tuo database non è una data, e non tocca nessun altro campo dell'anagrafica del cliente: non crea clienti, non ne modifica nome, email, telefono o indirizzo. È comunque la scrittura di un dato personale verso Shopify, ed è dichiarata qui perché è tale.

**L'identificativo esterno.** Lo scrive il riconoscimento dei visitatori descritto al punto 3.5: quando un browser viene collegato a un cliente, sulla riga di quel cliente finisce l'identificativo del browser da cui sta navigando in quel momento.

Perché l'indirizzo: paese e CAP sono ciò che le piattaforme pubblicitarie usano per riconoscere i tuoi clienti fra i propri utenti, e senza di essi il pubblico che costruisci risulta più piccolo del vero. Per la stessa ragione il numero di telefono viene scritto in sole cifre, prefisso internazionale compreso, e la data di nascita nel formato `AAAAMMGG`: è la forma che quelle piattaforme confrontano.

I clienti che non hanno prestato il consenso non vengono mai copiati nel tuo database.

**Se un cliente revoca il consenso**, il suo record non viene cancellato — cancellarlo distruggerebbe uno storico che potrebbe servirti — ma viene marcato come non più consenziente, e da quel momento ogni richiesta di lettura che lo riguarda viene rifiutata.

### 3.4 Ordini

Dove hai concesso all'app l'accesso agli ordini, vengono trattati: identificativo e numero d'ordine, identificativo del cliente e suo nome e cognome, valuta, totale, stato del pagamento, data di annullamento, data dell'ordine e, per ogni riga, prodotto e variante, quantità, prezzo unitario pagato e sconto di riga.

Dagli **ordini** l'app deliberatamente **non** preleva indirizzi, indirizzi email, numeri di telefono, note dell'ordine o dati di pagamento. Al calcolo del profitto non servono, quindi non vengono presi.

Non tratta nemmeno **dati di spedizione**: nessun corriere, nessun codice di tracciamento, nessuna etichetta, nessun costo di spedizione. Di quel che riguarda la consegna resta soltanto quanto il cliente ha pagato al checkout, che è già dentro il totale dell'ordine.

L'indirizzo del cliente descritto al punto 3.3 è cosa diversa: è l'indirizzo predefinito dell'anagrafica, di chi ha prestato il consenso al marketing, e non viene ricavato dagli ordini.

### 3.5 Riconoscimento dei visitatori

Se attivi il riconoscimento dei visitatori, l'app tiene nel **tuo** database una tabella `users` con **una riga per browser**. Ogni riga contiene:

- un **identificativo pseudonimo del browser**, coniato dall'app (il prefisso `kerdon_` seguito da 32 caratteri casuali) e conservato in un cookie emesso dal tuo dominio. Gli identificativi coniati sotto il nome precedente dell'app, con il prefisso `corew_`, restano validi e vengono ancora accettati: rifiutarli vorrebbe dire coniarne uno nuovo a chiunque torni;
- l'**etichetta del browser** e quella del **tipo di dispositivo** — per esempio «Chrome», «mobile» — quando il tuo endpoint di tracciamento le trasmette;
- il **primo e l'ultimo avvistamento** di quel browser;
- il **collegamento al cliente Shopify**, scritto quando la persona si identifica lasciando un'email o un numero di telefono, oppure quando compra e l'identificativo del browser arriva insieme all'ordine;
- l'**unione fra identificativi**: quando più browser risultano della stessa persona, i più recenti dichiarano quale sia il più vecchio, che diventa quello di riferimento. Nessuna riga viene cancellata per questo.

**Non è un dato anonimo, ed è importante non chiamarlo così.** L'identificativo non contiene un nome, ma vive nel browser di quella persona e, dal momento in cui viene collegato a un cliente, dice quali dispositivi usa quella persona e quando li ha usati. È un dato personale, e va trattato come tale.

**Il consenso viene prima.** Senza il permesso del visitatore — che l'app legge dai segnali del Customer Privacy di Shopify trasmessi dal tuo endpoint — non viene coniato nessun identificativo e non viene scritta nessuna riga. Alla revoca le scritture si fermano, la riga di quel browser viene cancellata insieme ai legami che la univano agli altri, e l'app fa scadere il cookie che aveva emesso sul proprio dominio. Il cookie piantato dal tuo dominio è tuo: a toglierlo è il tuo endpoint, che è l'unico a poterlo fare.

**Per collegare un browser a un cliente** il tuo endpoint ci trasmette l'email o il numero di telefono che la persona ha appena lasciato: l'app li usa per cercare quel cliente nel tuo database e scrivere il collegamento. Quei due valori non vengono conservati sui nostri sistemi.

**Le righe non collegate a nessun cliente vengono cancellate dopo 90 giorni** dall'ultimo avvistamento.

Di chi naviga l'app **non** tratta l'indirizzo IP e **non** registra le pagine visitate.

### 3.6 Registri operativi

Per far funzionare l'app e assisterti conserviamo, nel nostro database: un record di ogni sincronizzazione (tipo, esito, orari e quanti record sono stati aggiunti, aggiornati o rimossi), voci a livello di prodotto che indicano quali prodotti sono cambiati, gli addebiti di fatturazione e i registri di accesso all'interfaccia di lettura, con il solo esito e stato HTTP.

Quanto ai **clienti**, ciò che teniamo è in larghissima parte fatto di conteggi: la sincronizzazione non copia nel nostro database nomi, indirizzi email o numeri di telefono. Ci sono però quattro casi in cui un riferimento a una singola persona resta scritto da noi, e vanno detti:

- **Riparazioni in sospeso.** Quando un'operazione che riguarda un singolo cliente non riesce — marcare chi ha ritirato il consenso, riscrivere la data di nascita su Shopify — resta una riga con l'identificativo Shopify di quel cliente e, per la data di nascita, il valore da riscrivere. Sparisce quando l'operazione riesce, o quando viene abbandonata dopo i tentativi previsti.
- **Richieste privacy in lavorazione.** Il messaggio firmato che Shopify ci consegna contiene l'identificativo della persona, e viene conservato finché la richiesta non si chiude. Resta più a lungo solo quando una richiesta si blocca e deve essere portata a termine a mano: senza, non si saprebbe più di chi si tratta.
- **Esportazioni per il diritto di accesso.** Contengono i dati della persona e restano sui nostri sistemi al massimo 30 giorni: vedi il punto 8.
- **Revoche del consenso al riconoscimento.** L'identificativo del browser e, quando la revoca ne nomina uno, l'identificativo del cliente restano cifrati sulla riga della revoca finché non è stata applicata. Poi vengono azzerati, e resta la sola prova — non leggibile — che una revoca c'era stata.

## 4. Dove risiedono i dati

**I tuoi dati vivono in un database tuo.** Il progetto Supabase collegato in configurazione appartiene al tuo account Supabase, nella regione che hai scelto. Non ne siamo intestatari, non possiamo trasferirlo e non possiamo accedervi dopo che hai scollegato l'app.

**Il nostro database** conserva i registri operativi descritti sopra, insieme alla configurazione del negozio e alle credenziali cifrate. È ospitato nell'Unione Europea.

## 5. Chi altro è coinvolto

| Fornitore | Finalità | Ubicazione |
|---|---|---|
| Shopify | Origine dei dati di negozio, prodotti, clienti e ordini; fatturazione | Secondo i termini di Shopify |
| Supabase | Il tuo database e il nostro | Unione Europea |
| Vercel | Hosting dell'applicazione | Unione Europea |
| Upstash | Cache dei conteggi che l'app ti mostra — prodotti pronti, clienti e simili | Unione Europea |

**Non vendiamo dati.** Né i tuoi, né quelli dei tuoi clienti, a nessuno e in nessuna forma. E non li usiamo per addestrare modelli.

Oltre ai fornitori elencati qui sopra — che agiscono su nostra istruzione e non per conto proprio — non trasmettiamo dati a nessun altro. In particolare **non siamo noi** a inviarli a piattaforme pubblicitarie o di analisi.

Quello che l'app fa è portare i dati **nel tuo database** e metterli a tua disposizione. Da lì in poi decidi tu: se li usi per costruire un pubblico su una piattaforma pubblicitaria, quell'invio lo fai tu, il titolare del trattamento sei tu, e la base giuridica è il consenso che il cliente ha prestato nel tuo negozio. È esattamente la ragione per cui l'app sincronizza soltanto chi quel consenso l'ha dato, e smette di rispondere per chi lo revoca.

## 6. Sicurezza

I token di accesso e le chiavi del database sono cifrati a riposo con AES-256-GCM. La chiave privilegiata del tuo database non viene mai inviata a un browser.

Le tabelle create dall'app nel tuo database hanno la row-level security attiva e nessuna policy pubblica: con una chiave pubblica non sono leggibili.

L'interfaccia di lettura richiede un token emesso per il tuo negozio, è limitata alla sola lettura e rifiuta le richieste relative a clienti che hanno revocato il consenso.

**Leggere e scrivere sono due credenziali distinte.** Il token con cui si leggono i tuoi dati non è quello con cui si scrivono le righe del riconoscimento visitatori: sono generati in modo indipendente e dall'uno non si ricava l'altro. Dare il token di lettura a un'agenzia le dà la lettura, e nient'altro. La credenziale di scrittura ti viene mostrata una volta sola, si ruota e si revoca senza toccare quella di lettura, e porta con sé i propri permessi — coniare l'identificativo di un browser, scrivere le etichette di browser e dispositivo e collegare un browser a un cliente sono tre permessi distinti, e ogni endpoint chiede soltanto quello che gli serve. Dove chi chiama sa firmare le proprie richieste, la credenziale non viaggia affatto: viaggia una firma, valida per pochi minuti e per il solo destinatario a cui è rivolta.

Le richieste provenienti da Shopify sono verificate per firma prima di essere eseguite.

## 7. Per quanto tempo restano i dati

I dati nel **tuo** database restano per il tempo che decidi tu. L'app non li cancella a scadenza, con una sola eccezione: le righe dei browser mai collegati a un cliente, che vengono cancellate dopo 90 giorni dall'ultimo avvistamento.

**Nel nostro database**: i registri di accesso all'interfaccia di lettura si conservano 12 mesi, poi vengono cancellati; le esportazioni preparate per una richiesta di accesso al massimo 30 giorni; le righe di riparazione e le richieste privacy fino alla loro chiusura, come descritto al punto 3.6. Gli eventi webhook consegnati da Shopify vengono cancellati 7 giorni dopo essere stati conclusi. Una revoca del consenso al riconoscimento viene cancellata 7 giorni dopo essere stata applicata; se una revoca resta bloccata e non viene mai applicata, il suo contenuto cifrato viene azzerato dopo 30 giorni e resta la sola prova, non leggibile, che una revoca c'era stata.

**Quando disinstalli l'app**, i tuoi dati restano dove sono — nel tuo database, che rimane tuo — e la nostra sessione con il negozio termina. Conserviamo i nostri registri operativi e di fatturazione per il tempo richiesto dagli obblighi contabili e di legge.

**Quando Shopify ci chiede di cancellare il negozio** — la richiesta di redaction inviata 48 ore dopo la disinstallazione — eliminiamo dai nostri sistemi la configurazione del negozio, le credenziali e i registri operativi. Non tocchiamo il tuo database: non è nostro da cancellare.

Di quella cancellazione resta una riga sola, ed è la prova che è avvenuta: contiene un'impronta a senso unico del dominio del negozio, i conteggi di ciò che è stato cancellato e l'istante in cui è successo. Dall'impronta non si risale al negozio; chi però arriva con il dominio in mano può ricalcolarla e verificare che la cancellazione c'è stata.

## 8. Richieste dei tuoi clienti

Shopify ci inoltra automaticamente le richieste privacy dei clienti, e l'app vi dà seguito.

**Richiesta di accesso** — l'app raccoglie dal tuo database ciò che di quella persona è stato scritto: la sua riga fra i clienti, i suoi ordini e le righe di quegli ordini, e i browser collegati a lei. L'esportazione viene preparata e messa a tua disposizione dentro l'app, dove la scarichi con la tua sessione di amministratore: non finisce su nessun indirizzo pubblico. **Resta sui nostri sistemi al massimo 30 giorni**, poi viene cancellata da sola.

**Richiesta di cancellazione** — la riga del cliente viene eliminata in via definitiva dal tuo database, e con lei le righe dei browser collegati a quella persona. Gli **ordini non vengono cancellati**: sono scritture contabili che sei tenuto a conservare, e cancellarle cambierebbe il tuo fatturato. Vengono privati di ciò che riporta alla persona — identificativo del cliente, nome e cognome — e restano indistinguibili da un acquisto fatto senza account. L'operazione viene registrata nei tuoi log.

Se un cliente si rivolge direttamente a te, puoi anche cancellarne il record da solo: il database è tuo.

## 9. I tuoi diritti

Dove agiamo da titolari per i dati del tuo account, puoi chiedere accesso, rettifica, cancellazione, limitazione, portabilità od opporti al trattamento scrivendo a support@kerdon.io. Hai inoltre il diritto di proporre reclamo all'autorità di controllo competente.

Dove agiamo da responsabili, le richieste che riguardano i tuoi clienti vanno indirizzate a te in quanto titolare; noi ti assistiamo nel rispondere.

## 10. Modifiche

Se cambiamo il modo in cui l'app tratta i dati, aggiorniamo questa pagina e la data in cima. Le modifiche sostanziali vengono annunciate dentro l'app prima di avere effetto.
