# Scope OAuth Shopify

La fonte di verità è il campo `scopes` in `shopify.app.toml`. Ogni altra
dichiarazione — `.env.example`, README, test e2e, documenti legali — deve
ripetere quella riga parola per parola.

## Elenco completo

```
read_products
read_inventory
write_inventory
read_customers
write_customers
read_publications
read_themes
read_orders
read_all_orders
read_shipping
read_returns
```

## Giustificazione per scope

Ogni scope è necessario a una funzione specifica dell'app. Qui si documenta quale
funzione e dove nel codice.

### `read_products`

**Funzione:** Sincronizzazione del catalogo prodotti verso il database del merchant.

**Evidenza:**
- `app/lib/shopify-api.server.ts` — `getProducts()` legge prodotti e varianti via GraphQL Admin
- `app/lib/workers/processors.server.ts` — `processProductsBulk()` sincronizza il catalogo completo
- `app/routes/webhooks.products.*.ts` — webhook che intercetta creazione, modifica e cancellazione prodotti

### `read_inventory`

**Funzione:** Lettura del costo per articolo (`InventoryItem.unitCost`), necessario
per il calcolo del profitto.

**Evidenza:**
- `app/lib/shopify-api.server.ts` — `enrichVariantCosts()` legge `unitCost.amount` per ogni variante
- `app/lib/workers/processors.server.ts` — integra i costi nel bulk sync prima di scrivere verso Supabase

### `write_inventory`

**Funzione:** Scrittura del costo per articolo su `InventoryItem` quando il merchant
lo modifica dalla tab Prodotti dell'app.

**Evidenza:**
- `app/lib/shopify-api.server.ts` — `inventoryItemUpdate()` scrive `cost` verso Shopify GraphQL Admin
- `app/routes/app.products._index.tsx` — UI della tab Prodotti con modifica dei costi

**Nota:** È l'unica scrittura verso l'inventario. L'app non modifica quantità né
localizzazioni.

### `read_customers`

**Funzione:** Sincronizzazione dei clienti verso il database del merchant, inclusi
i metafield (es. data di nascita).

**Evidenza:**
- `app/lib/shopify-api.server.ts` — `getCustomers()` legge clienti e metafield via GraphQL Admin
- `app/lib/workers/processors.server.ts` — `processCustomersBulk()` sincronizza i clienti
- `app/routes/webhooks.customers.*.ts` — webhook per creazione, modifica e cancellazione clienti

### `write_customers`

**Funzione:** Due scritture sui metafield dei clienti:
1. Creazione della definizione del metafield "Data di nascita" (namespace + chiave + tipo)
2. Scrittura del valore del metafield quando il merchant ha il dato e Shopify no

**Evidenza:**
- `app/lib/shopify-api.server.ts` — `metafieldDefinitionCreate()` crea la definizione
- `app/lib/shopify-api.server.ts` — `writeCustomerMetafields()` scrive i valori tramite `metafieldsSet`
- `app/lib/customers/birthdate-writeback.ts` — logica di writeback della data di nascita
- `app/lib/workers/processors.server.ts` — `processBirthdateWriteback()` esegue il writeback in batch

**Nota:** L'app NON modifica anagrafiche (nome, email, telefono, indirizzo). Scrive
solo il metafield della data di nascita. Shopify non ha uno scope dedicato alle
definizioni dei metafield: chiede quello di scrittura del tipo a cui la definizione
appartiene.

### `read_publications`

**Funzione:** Verifica che un prodotto sia pubblicato sul canale "Online Store" prima
di sincronizzarlo (filtro di idoneità).

**Evidenza:**
- `app/lib/shopify-api.server.ts` — campo `publishedOnCurrentPublication` nelle query GraphQL dei prodotti
- `app/lib/workers/processors.server.ts` — skip dei prodotti non pubblicati nel bulk sync

### `read_themes`

**Funzione:** Rilevamento del tema attivo del negozio per personalizzazioni future
dell'integrazione lato checkout/vetrina.

**Evidenza:**
- Preparazione per integrazioni future. Al momento l'app embedded non legge il tema,
  ma lo scope è richiesto per le funzioni dichiarate nel modulo di installazione.

**Nota:** Scope richiesto dal Partner Dashboard per app che si integrano con lo
storefront. L'app non lo usa attivamente al momento, ma è necessario per
l'approvazione.

### `read_orders`

**Funzione:** Lettura degli ordini per calcolo di profitto, margine e LTV.

**Evidenza:**
- `app/lib/shopify-api.server.ts` — `getOrders()` legge ordini e line items via GraphQL Admin
- `app/lib/workers/processors.server.ts` — sincronizzazione ordini verso Supabase
- `app/routes/webhooks.orders.ts` — webhook per creazione e modifica ordini in tempo reale

### `read_all_orders`

**Funzione:** Accesso allo storico completo degli ordini, inclusi quelli archiviati
e oltre i 60 giorni. Necessario per calcolo LTV e analisi di profitto storico.

**Evidenza:**
- `app/lib/shopify-api.server.ts` — query GraphQL che richiedono accesso agli ordini archiviati
- `app/lib/workers/processors.server.ts` — bulk sync dello storico ordini completo

**Giustificazione esplicita:** Il calcolo del LTV (Lifetime Value) richiede tutti
gli ordini di un cliente, non solo quelli recenti. Senza `read_all_orders`, l'app
vedrebbe solo gli ordini degli ultimi 60 giorni e il profitto storico risulterebbe
parziale.

### `read_shipping`

**Funzione:** Lettura delle informazioni di spedizione sugli ordini per il calcolo
del profitto netto.

**Evidenza:**
- `app/lib/shopify-api.server.ts` — campo `shippingLine` nelle query GraphQL degli ordini
- I costi di spedizione incassati dal merchant (`order.totalShippingPriceSet`) vengono
  sottratti dal ricavo lordo per ottenere il profitto.

**Nota:** L'app non legge corrieri, tracking o etichette. Legge solo l'importo di
spedizione incassato al checkout, che contribuisce al profitto.

### `read_returns`

**Funzione:** Gestione dei rimborsi e resi per rettificare il profitto.

**Evidenza:**
- `app/routes/webhooks.orders.ts` — sottoscrizione a `refunds/create`
- Quando un ordine viene rimborsato, il profitto deve essere ricalcolato sottraendo
  le righe restituite.

**Nota:** L'app non gestisce il flusso fisico dei resi. Legge solo i dati di
rimborso per mantenere accurato il calcolo del profitto.

## Scope rimossi

### `write_products` ❌

**Motivo rimozione:** Nessuna mutation verso prodotti. L'unica scrittura dell'app
verso Shopify è su `InventoryItem` (costo) e sui metafield dei clienti (data di
nascita). Nessun `productUpdate`, `productCreate`, `productSet`,
`productVariantsBulkUpdate` o `metafieldsSet` su prodotti.

**Data rimozione:** 26 settembre 2026 (T6, audit remediation plan)

## Scope opzionali

Nessuno. Tutti gli scope sono obbligatori per il funzionamento dell'app. Il campo
`optional_scopes` in `shopify.app.toml` è vuoto.

## Riferimenti normativi

Gli scope vanno dichiarati nel modulo **Protected customer data** del Partner
Dashboard. Per i dettagli su cosa dichiarare e come, vedi
`docs/legal/protected-customer-data.md`.
