# Dichiarazione dei dati cliente protetti

Cosa rispondere nel modulo **Protected customer data** della Partner Dashboard.

Non è un documento legale: è la traccia da cui compilare quel modulo, e serve a
una cosa sola — che quanto dichiarato là combaci con quanto l'app fa davvero e
con quanto scrivono privacy policy e DPA. Il revisore confronta le tre cose, e
una differenza fra loro è un motivo di rifiuto anche quando il comportamento
dell'app è ineccepibile.

Ultimo allineamento: 17 settembre 2026, con la data di nascita riscritta verso
Shopify, il riconoscimento dei visitatori e la separazione fra la credenziale
che legge e quella che scrive.

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

**Non** si dichiarano — perché l'app non li tratta: dati di pagamento, indirizzi
prelevati dagli ordini, dati di spedizione (nessun corriere, codice di
tracciamento, etichetta o costo: le etichette si comprano fuori da Shopify, e
della consegna resta solo quanto pagato al checkout), indirizzo IP, pagine
visitate.

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
telefono, indirizzo e data di nascita, per analisi, marketing e pubblicità; più
l'identificativo pseudonimo del browser con cui il negozio riconosce chi torna,
quando il merchant attiva quella funzione e il visitatore ha dato il consenso.

**Conservazione.** I dati vivono nel database del merchant, che ne è titolare e
decide quanto tenerli. Alla disinstallazione le tabelle e i dati **restano dove
sono**: cancellarli distruggerebbe il patrimonio informativo del merchant senza
che lui l'abbia chiesto. L'unica scadenza che l'app applica da sé è sulle righe
dei browser mai collegati a un cliente, cancellate dopo 90 giorni.

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
il merchant legge i propri dati non è più quello con cui si scrivono le righe del
riconoscimento visitatori: sono due credenziali generate in modo indipendente,
ognuna con i propri ambiti, la propria rotazione e la propria revoca. Fino al 1º
dicembre 2026 il token di lettura è ancora accettato sugli endpoint di scrittura,
perché i negozi già installati non perdano il tracciamento da un giorno all'altro;
dopo quella data non scrive più niente. Se il modulo chiede quali misure
proteggono i dati, questa è fra le prime da nominare — ed è anche l'unica
risposta onesta a «il token di lettura può scrivere?», che oggi è «sì, ancora per
un po', e c'è una data».

**Che i tre documenti dicano la stessa cosa.** Questo file, la privacy policy
(`privacy-policy.it.md`, `privacy-policy.md`, `privacy-policy.html`) e il DPA
(`dpa.it.md`, `dpa.md`). Un campo aggiunto al codice e non a tutti e tre è la
differenza che il revisore trova.

**Che gli scope dichiarati siano quelli veri.** La fonte di verità è `scopes` in
`shopify.app.toml`; `SHOPIFY_SCOPES` in `.env.example` e nel README deve ripetere
quella riga parola per parola. Oggi sono: `read_products`, `write_products`,
`read_inventory`, `write_inventory`, `read_customers`, `write_customers`,
`read_publications`, `read_themes`, `read_orders`, `read_all_orders`. Fra questi,
`write_customers` serve **soltanto** ad abilitare la definizione del metafield
"Data di nascita" e a scrivere quel metafield: se il modulo chiede a cosa serve un
permesso di scrittura sui clienti, la risposta è questa e nient'altro.
