# Dichiarazione dei dati cliente protetti

Cosa rispondere nel modulo **Protected customer data** della Partner Dashboard.

Non è un documento legale: è la traccia da cui compilare quel modulo, e serve a
una cosa sola — che quanto dichiarato là combaci con quanto l'app fa davvero e
con quanto scrivono privacy policy e DPA. Il revisore confronta le tre cose, e
una differenza fra loro è un motivo di rifiuto anche quando il comportamento
dell'app è ineccepibile.

Ultimo allineamento: agosto 2026, con l'aggiunta dell'indirizzo cliente.

## Livello richiesto

**Protected customer data + campi (Level 2).** Non basta il livello base: l'app
tratta nome, email, telefono e indirizzo, che sono campi protetti a sé stanti.

## Campi da dichiarare, e perché

| Campo | Motivazione da dichiarare |
|---|---|
| Nome e cognome | Identificare il cliente negli elenchi di redditività che il merchant consulta nell'app. |
| Indirizzo email | Chiave con cui il merchant riconosce i propri clienti negli strumenti di marketing collegati al proprio database. |
| Telefono | Stessa funzione dell'email come chiave di riconoscimento, per le piattaforme che la usano. |
| Indirizzo (via, CAP, regione, paese) | Paese e CAP sono i campi con cui le piattaforme pubblicitarie riconoscono i clienti fra i propri utenti: senza, il pubblico costruito dal merchant risulta più piccolo del reale. |

**Non** si dichiarano — perché l'app non li tratta: dati di pagamento, indirizzi
prelevati dagli ordini, indirizzo IP, dati di navigazione.

## Le risposte alle domande del modulo

**Perché ti servono questi dati.** L'app copia il catalogo e i clienti del
negozio nel database del merchant — un database suo, che lui controlla — perché
possa calcolare il profitto per prodotto e per cliente e alimentare i propri
strumenti di marketing. I dati non transitano verso di noi: restano fra Shopify
e l'infrastruttura del merchant.

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
telefono e indirizzo, per analisi, marketing e pubblicità.

**Conservazione.** I dati vivono nel database del merchant, che ne è titolare e
decide quanto tenerli. Alla disinstallazione le tabelle e i dati **restano dove
sono**: cancellarli distruggerebbe il patrimonio informativo del merchant senza
che lui l'abbia chiesto. Sui nostri sistemi dei clienti non resta nulla oltre ai
conteggi delle sincronizzazioni.

## Due cose da verificare prima di ogni invio

**Che i due campi non compilati restino non compilati.** `external_id` e
`date_of_birth` esistono come colonne ma l'app non li scrive: Shopify non li
espone come campi del cliente. Se un giorno verranno letti da un metafield, la
dichiarazione va aggiornata **prima** — la data di nascita non è categoria
particolare ai sensi dell'art. 9 GDPR, ma resta un dato personale in più.

**Che i tre documenti dicano la stessa cosa.** Questo file, la privacy policy
(`privacy-policy.it.md`, `privacy-policy.md`, `privacy-policy.html`) e il DPA
(`dpa.it.md`, `dpa.md`). Un campo aggiunto al codice e non a tutti e tre è la
differenza che il revisore trova.
