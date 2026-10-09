# Integrazioni: Klaviyo

Spec per l'interfaccia di gestione delle integrazioni nella tab Clienti.

## 3.1 Card «Integrazioni»

La card mostra tutte le integrazioni disponibili come riquadri cliccabili.

### Layout

Riquadri impilati verticalmente, ciascuno con:
- Logo dell'integrazione (Thumbnail size="medium")
- Nome in grassetto (Text variant="headingMd" fontWeight="bold")
- Stato colorato sotto il nome

### Stati

1. **Non disponibile** (coming_soon): grigio, non cliccabile
   - Logo spento (opacità/scala di grigi via CSS)
   - Nome e stato tone="disabled"
   - Nessun UnstyledButton

2. **Da collegare**: disponibile, non ancora collegata
   - Stato tone="subdued"
   - Cliccabile

3. **Installata**: collegata, nessun problema
   - Stato tone="success" («Installata»)
   - Cliccabile

4. **Richiede attenzione**: needs_reconnect o conflitti aperti > 0
   - Stato tone="caution" («Richiede attenzione»)
   - Cliccabile

### Comportamento

- Clic su riquadro cliccabile → apre modal di configurazione per quella integrazione
- Scrollable con altezza massima 400px
- Header: solo titolo «Integrazioni» (Text h2 headingMd), nessun pulsante

## 3.2 Modal di configurazione

Apre sempre una singola integrazione (prop `preselected` dal clic su un riquadro).

### Struttura

- Titolo: nome dell'integrazione dal registro («Klaviyo»)
- Nessun catalogo, nessuna ricerca, nessuna navigazione
- Azioni nel footer della modal (primaryAction + secondaryActions)

### Non collegata / needs_reconnect

- Frase di beneficio («Importa le date di nascita…»)
- Banner errore OAuth (se presente)
- Banner popup bloccato (se presente)
- Pulsante di collegamento nel footer come primaryAction («Collega Klaviyo» / «Riconnetti»)

### Collegata: 3 sezioni (separate da Divider)

#### Sezione 1: Account

Riga con:
- Logo (Thumbnail size="small") + nome account (se presente) + stato colorato (stesso testo e tono della card)
- Pulsante «Scollega» (Button variant="plain" tone="critical") sulla stessa riga, allineato a destra

Note:
- Se accountName è vuoto/null, la riga del nome non compare (non mostrare «Account:» vuoto)
- Stato usa `tileState()` per colore e testo coerenti con la card
- Banner di conferma scollegamento sotto la riga (se attivo)
- Banner errori (properties, saveMapping, disconnect) in questa sezione

#### Sezione 2: Associazione campi

- Titolo «Associazione campi»
- Due Select affiancate con FormLayout + FormLayout.Group:
  - «Proprietà Klaviyo»
  - «Campo Kerdon» (fisso: birthdate, disabled)
- Select formato data sotto le due Select (se proprietà ambigua)
- Anteprima sotto (List con conversioni raw → display)

#### Sezione 3: Import

- Data ultimo import + campi riempiti (frase `t.customers.integrations.lastImport`)
- Link ai conflitti aperti (se > 0): chiude la modal e naviga a view=conflicts
- Testo «import in corso» (se running)
- Banner importReason (se presente)

### Footer

- `primaryAction`: «Salva» (loading, disabled se !canSave)
- `secondaryActions`: «Importa dati» (loading, disabled se !mapping o running)

Comportamento:
- Salva chiude la modal
- Import parte (senza chiudere)
- Errori mostrati in banner

## Note implementative

- Polaris Modal con size predefinita (il contenuto sta comodamente senza size="large")
- KlaviyoDetail espone azioni al genitore via callback `onActionsChange`
- Link conflitti usa `buildConflictsUrl(searchParams)` e chiude modal prima di navigare
- OAuth popup aperto in modo sincrono nel click handler (vincolo esistente)
