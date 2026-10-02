# Checklist App Store Submission — Kerdon

Questa checklist va eseguita direttamente nel **Partner Dashboard di Shopify** prima di inviare l'app in revisione. Ogni voce (DASH-01…10) contiene:

- Cosa controllare
- Dove trovarlo nel Partner Dashboard
- Il valore esatto da inserire o verificare (preso dai file del repository)
- Come verificarlo
- Casella da spuntare al completamento

**Ultimo aggiornamento:** 2026-10-02

---

## DASH-01 — Pricing del listing

### Cosa controllare
Il listino prezzi dichiarato nell'App Store deve coincidere esattamente con i piani implementati nel codice: **Basic, Growth, Scale e Core**, con i relativi limiti di prodotti e clienti. **Nessun limite sugli ordini**.

### Dove nel Partner Dashboard
Partner Dashboard → App **Kerdon** → **Distribution** → **Pricing** → Manage pricing plans

### Valori esatti dal repository

**Fonte:** `app/lib/billing/plan-tiers.ts` (righe 29-66)

| Piano | Prezzo mensile | Prezzo annuale | Max prodotti | Max clienti | Sync clienti | Product feeds |
|-------|----------------|----------------|--------------|-------------|--------------|---------------|
| **Basic** | €0 / $0 | €0 / $0 | 20 | 0 | No | No |
| **Growth** | €29 / $29 | €290 / $290 | 200 | 250 | Sì | Sì |
| **Scale** | €79 / $79 | €790 / $790 | 1.000 | 500 | Sì | Sì |
| **Core** | €149 / $149 | €1.490 / $1.490 | Illimitati | Illimitati | Sì | Sì |

**Piano Lifetime:** illimitato su tutto, incluso in `prisma/owner-bootstrap.sql`, mantiene i suoi valori (non va nel listing pubblico).

**Valute supportate:** EUR e USD con le stesse cifre (fonte: `PLAN_CURRENCIES` riga 69).

**Nessun limite ordini:** la colonna `max_orders` non esiste nella tabella `plans` (verificato in `prisma/plan-catalog-sync.test.ts` riga 167).

### ⚠️ Rischio segnalato
Il limite clienti (250 su Growth, 500 su Scale) è **mostrato** nel listino ma **non ancora applicato** nel codice. L'enforcement è previsto per una release successiva. Il revisore potrebbe chiedere chiarimenti.

### Come verificare
1. Ogni piano nel Dashboard deve riportare prezzo e limiti identici alla tabella sopra
2. Verificare che NON compaia nessun limite ordini in nessun piano
3. Controllare che i nomi siano esattamente Basic / Growth / Scale / Core (non Free / Pro / Business / Enterprise, che erano i nomi vecchi)

### [ ] Fatto
Confermo che il pricing del listing coincide con i valori in `plan-tiers.ts`.

---

## DASH-02 — Protected Customer Data (campi dichiarati)

### Cosa controllare
Tutti i tipi e campi di dati cliente protetti che l'app interroga devono essere dichiarati nel modulo **Protected customer data access**.

### Dove nel Partner Dashboard
Partner Dashboard → App **Kerdon** → **API access** → **Protected customer data access** → Request access (o Manage access se già dichiarato)

### Valori esatti dal repository

**Fonte primaria:** `docs/legal/protected-customer-data.md` (righe 21-31, 56-84)  
**Inventario ordini:** `app/lib/legal/order-data-inventory.ts` (righe 84-295)  
**Test di coerenza:** `app/lib/legal/order-data-inventory.test.ts` confronta inventario con query GraphQL, colonne DB e documenti legali

#### Livello richiesto
**Protected customer data + campi (Level 2)** — l'app tratta nome, email, telefono e indirizzo, che sono campi protetti specifici.

#### Campi GraphQL effettivamente interrogati

**Da clienti (`app/lib/shopify-api.server.ts` — query `getCustomers`):**
- `customer.id` — identificativo
- `customer.firstName`, `customer.lastName` — nome e cognome
- `customer.email` — email
- `customer.phone` — telefono
- `customer.defaultAddress` (via, città, CAP, regione, paese) — indirizzo predefinito
- `customer.metafield` (namespace `facts`, key `birth_date` o custom) — data di nascita

**Da ordini (`app/lib/shopify-api.server.ts` — query `getOrders`):**
- `order.customer.id`, `order.customer.firstName`, `order.customer.lastName` — cliente dell'ordine
- `order.shippingAddress.countryCodeV2` — **solo il paese** dell'indirizzo di spedizione (per calcolo costo logistico)
- Dati di spedizione e logistica (elencati sotto)

#### Dati di spedizione e logistica degli ordini (DEC-03)

**Finalità:** calcolare il costo logistico (spedizione, imballo, rientro resi) di ogni ordine e sottrarlo dal profitto.

**Campi GraphQL letti** (fonte: `order-data-inventory.ts` righe 186-294):
- `shippingAddress.countryCodeV2` — paese di spedizione
- `requiresShipping` — se l'ordine va spedito (non conservato)
- `displayFulfillmentStatus`, `fulfillments.status` — stato di evasione
- `fulfillments.trackingInfo.number` — codici di tracciamento (**contati, mai conservati**)
- `shippingLines.nodes.title` — opzione di spedizione
- `shippingLines.nodes.deliveryCategory` — categoria di consegna (non conservata)
- `totalWeight` — peso totale
- `lineItems.nodes.quantity`, `lineItems.nodes.currentQuantity` — numero articoli
- `returns.nodes.status`, `returns.nodes.createdAt` — stato e data dei resi
- `metafield.value` (namespace `custom`, key `packaging_category`) — categoria imballo

**Scope richiesti:** `read_orders`, `read_all_orders`, `read_shipping`, `read_returns`

#### Testo pronto per la motivazione (EN)

```
Kerdon reads fulfilment status, tracking numbers (only to count parcels; they are never stored), shipping method, total weight, return status and date, and the shipping country, to calculate each order's shipping, packaging and return cost and subtract it from profit per order and per customer. The results are stored in the merchant's own database.
```

#### Scritture verso Shopify (da dichiarare)

1. **Data di nascita** — riscritta nel metafield del cliente quando il merchant ha il dato e Shopify no (`app/lib/customers/birthdate-writeback.ts`)
2. **Costo per articolo** — scritto su `InventoryItem` dalla tab Prodotti (`app/lib/shopify-api.server.ts` — `inventoryItemUpdate`)

#### Riconoscimento visitatori (da dichiarare anche se non è campo PCD standard)

L'app conia un identificativo pseudonimo del browser, conserva etichetta browser/dispositivo quando trasmesse, primo/ultimo avvistamento, collegamento al cliente Shopify. **Non è dato anonimo** perché ricollegabile alla persona. Si scrive solo con consenso, righe mai collegate a cliente cancellate dopo 90 giorni.

### Come verificare
1. Spuntare **Protected customer data (Level 2)**: sì
2. Finalità: App functionality and analytics; Marketing/Advertising (per clienti con consenso)
3. Spuntare i campi specifici:
   - [ ] **Name** — nome e cognome (`customer.firstName`, `customer.lastName`)
   - [ ] **Email** — anagrafica clienti con consenso
   - [ ] **Phone** — anagrafica clienti con consenso
   - [ ] **Address** — indirizzo predefinito clienti con consenso + **solo paese** spedizione ordine (`shippingAddress.countryCodeV2`)
4. Nella descrizione, nominare anche i dati logistici (copiare il testo EN sopra)
5. Dichiarare le due **scritture verso Shopify**: data di nascita (metafield) e costo articolo (InventoryItem)
6. Dichiarare il **riconoscimento visitatori** (identificativo pseudonimo browser)
7. Webhook: specificare che contengono indirizzi completi, email, telefono ma il corpo **viene scartato alla ricezione**, si tengono solo gli identificativi

### [ ] Fatto
Confermo di aver dichiarato tutti i campi PCD elencati sopra, le scritture e il riconoscimento visitatori.

---

## DASH-03 — Scope OAuth approvati

### Cosa controllare
Gli scope dichiarati nel Partner Dashboard devono coincidere esattamente con `shopify.app.toml` e con quelli concessi al test store.

### Dove nel Partner Dashboard
Partner Dashboard → App **Kerdon** → **API access** → **Scopes** → Manage scopes

### Valori esatti dal repository

**Fonte di verità:** `shopify.app.toml` riga 34

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

**Totale:** 11 scope, tutti obbligatori (`optional_scopes` è vuoto, riga 35).

**Giustificazione per ogni scope:** `docs/scopes.md` righe 23-176

**Scope rimosso:** `write_products` — eliminato il 26-09-2026, nessuna mutation verso prodotti nel codice (solo su `InventoryItem` per il costo).

### Come verificare
1. Nel Partner Dashboard → API access → Scopes, verificare che l'elenco contenga **esattamente** gli 11 scope sopra
2. Verificare che `write_products` **non** compaia (è stato rimosso)
3. Nel test store usato per la submission, andare in Apps → Kerdon → Settings → Uninstall app, cliccare su "View app permissions" e verificare che gli scope concessi corrispondano
4. File `.env.example` e README devono ripetere la riga di `shopify.app.toml` parola per parola

### [ ] Fatto
Confermo che gli scope approvati coincidono con `shopify.app.toml` e con il test store.

---

## DASH-04 — Giustificazione read_all_orders

### Cosa controllare
Lo scope `read_all_orders` deve avere una giustificazione verificabile basata sulla sincronizzazione storica degli ordini.

### Dove nel Partner Dashboard
Partner Dashboard → App **Kerdon** → **API access** → **Scopes** → accanto a `read_all_orders` cliccare su "Provide justification"

### Valore esatto dal repository

**Fonte:** `docs/scopes.md` righe 116-129

#### Giustificazione (EN, per il Partner Dashboard)

```
Kerdon calculates Lifetime Value (LTV) and historical profit for each customer. This requires access to all of a customer's orders, not just recent ones. Without read_all_orders, the app would only see orders from the last 60 days, and the customer's LTV and historical profit would be incomplete and misleading.
```

#### Evidenza nel codice

**Funzione:** accesso allo storico completo degli ordini, inclusi quelli archiviati e oltre i 60 giorni, per calcolo LTV e analisi di profitto storico.

**File che dimostrano l'uso:**
- `app/lib/shopify-api.server.ts` — query GraphQL che richiedono accesso agli ordini archiviati
- `app/lib/workers/processors.server.ts` — bulk sync dello storico ordini completo (riferimenti a "recupero dello storico" righe visibili)
- `app/lib/customers/customers-query.ts` — query che calcolano LTV cliente
- `app/components/Dashboard/ProfitabilityChart.tsx` — visualizzazione LTV vs LTP (Lifetime Profit)

**Scope collegato:** `read_orders` legge gli ordini, `read_all_orders` estende l'accesso oltre i 60 giorni.

### Come verificare
1. Copiare la giustificazione EN nel campo del Partner Dashboard
2. Il revisore può verificare che le query GraphQL in `shopify-api.server.ts` richiedano ordini senza filtro temporale (accesso completo)
3. La funzione di bulk sync (`processOrdersBulk` in `processors.server.ts`) sincronizza lo storico completo

### [ ] Fatto
Confermo di aver inserito la giustificazione per `read_all_orders` basata sul calcolo LTV.

---

## DASH-05 — Merchant must have online store

### Cosa controllare
L'app richiede che il merchant abbia un online store (canale di vendita vetrina).

### Dove nel Partner Dashboard
Partner Dashboard → App **Kerdon** → **Distribution** → **Listing requirements** → "Merchant must have an online store"

### Valore esatto
**Selezionato: SÌ**

### Giustificazione
L'app sincronizza solo prodotti pubblicati sul canale "Online Store" (filtro di idoneità).

**Fonte:** `docs/scopes.md` righe 85-105

**Evidenza nel codice:**
- `app/lib/shopify-api.server.ts` — campo `publishedOnCurrentPublication` nelle query GraphQL dei prodotti
- `app/lib/workers/processors.server.ts` — skip dei prodotti non pubblicati nel bulk sync
- Scope `read_publications` serve proprio a questo controllo

### Come verificare
1. Spuntare la casella "Merchant must have an online store" nel Partner Dashboard
2. Verificare che la giustificazione sia chiara: l'app filtra i prodotti per pubblicazione sul canale Online Store

### [ ] Fatto
Confermo di aver selezionato "Merchant must have online store".

---

## DASH-06 — Theme App Extension (non applicabile)

### Cosa controllare
Verificare se è pubblicata una Theme App Extension insieme all'app embedded.

### Valore esatto
**NON APPLICABILE** — Kerdon non ha nessuna Theme App Extension.

### Giustificazione

**Decisione architetturale:** niente codice nel tema, mai. Il tracciamento passa **solo** dal template server-side Google Tag Manager (sGTM) del merchant.

**Fonte:** memoria utente `project_kerdon_catena_tracciamento.md`:

> **Catena del tracciamento: Kerdon è l'ultimo anello** — niente codice nel tema, mai; solo template sGTM

**Evidenza nel repository:**
```bash
cd /Users/stefanoghisoni/Desktop/Siti web/App Shopify + Supabase/kerdon-dash
ls -la extensions/ 
# Output: No such file or directory
```

La directory `extensions/` non esiste. Il file `shopify.app.toml` non dichiara nessuna estensione di tema (righe 1-150 verificate).

### Come verificare
1. Nel Partner Dashboard, verificare che nella sezione **Extensions** non ci sia nessuna Theme App Extension elencata
2. Nel codice, verificare che `shopify.app.toml` non contenga blocchi `[[extensions]]` di tipo `theme`
3. Se il revisore chiede, rispondere: "Kerdon does not inject any code into the merchant's theme. Tracking is handled exclusively through the merchant's server-side Google Tag Manager container, outside the app's scope."

### [ ] Fatto
Confermo che non esiste nessuna Theme App Extension e che `extensions/` è assente dal repository.

---

## DASH-07 — Privacy URL, Support URL e Terms (pubblici e accessibili)

### Cosa controllare
Privacy policy, support URL ed eventuali Terms of Service devono essere pubblici e non restituire errori HTTP.

### Dove nel Partner Dashboard
Partner Dashboard → App **Kerdon** → **Distribution** → **Manage listing** → sezione "Links"

### Valori esatti dal repository

**Fonte:** `docs/legal/privacy-policy.md` (versione 1.4 del 27-09-2026)

| Tipo | URL | Codice HTTP | Note |
|------|-----|-------------|------|
| **Privacy Policy (EN)** | `https://api.kerdon.io/policies/privacy-policy` | 200 ✅ | Versione 1.4, include dati logistici ordini |
| **Privacy Policy (IT)** | `https://kerdon.io/policies/privacy-policy` | 307 → redirect | Rewrite verso `api.kerdon.io` (fonte: `project_kerdon_sito_e_pagine_info.md`) |
| **Support** | `support@kerdon.io` | Email valida | Indicata in privacy policy riga 8 e DPA |
| **Terms of Service** | Nessuno | 410 su `/policies/terms` | Non richiesto da Shopify, l'app non ne ha |

#### Verifiche curl eseguite

```bash
curl -s -o /dev/null -w "%{http_code}" https://api.kerdon.io/policies/privacy-policy
# Output: 200

curl -s -o /dev/null -w "%{http_code}" https://kerdon.io/policies/privacy-policy
# Output: 307

curl -s -o /dev/null -w "%{http_code}" https://kerdon.io
# Output: 307

curl -s -o /dev/null -w "%{http_code}" https://api.kerdon.io/policies/terms
# Output: 410
```

### Valori da inserire nel Partner Dashboard

- **Privacy policy URL:** `https://api.kerdon.io/policies/privacy-policy`
- **Support email:** `support@kerdon.io` (o pagina di contatto su `https://kerdon.io/contact` se esistente — da verificare quando il sito sarà pubblico)
- **Terms of Service:** lasciare vuoto (opzionale, l'app non ne ha)

### Come verificare
1. Aprire `https://api.kerdon.io/policies/privacy-policy` in un browser: deve caricare la pagina della privacy policy versione 1.4
2. Verificare che il supporto sia raggiungibile (email `support@kerdon.io` valida)
3. Se il revisore chiede i Terms of Service, rispondere che sono opzionali e l'app non li richiede

### [ ] Fatto
Confermo che privacy URL e support sono pubblici e accessibili, nessun errore HTTP.

---

## DASH-08 — Nessuna garanzia di persistenza 365 giorni

### Cosa controllare
Il listing non deve contenere promesse non dimostrabili come "i tuoi dati resteranno per 365 giorni" o garanzie di risultato ("aumenta il margine del 30%").

### Dove nel Partner Dashboard
Partner Dashboard → App **Kerdon** → **Distribution** → **Manage listing** → testi introduzione, dettagli e funzioni

### Valore esatto dal repository

**Fonte:** `/Users/stefanoghisoni/Desktop/Kerdon-App-Store/descrizione-app-store.md`

**Sweep eseguita su T14:** la directory `/Users/stefanoghisoni/Desktop/Kerdon-App-Store/` (sola leggibile, non modificabile) contiene i testi destinati all'App Store. Nessuna promessa di persistenza temporale né garanzia di risultato.

**Verifica manuale della descrizione:**

**Introduzione (EN):**
```
See the real profit behind every order and customer, in your own database.
```
✅ Nessuna promessa temporale, nessuna garanzia di risultato.

**Dettagli (EN):**
```
Kerdon syncs your products, customers and orders into a Supabase database you own, then works out what you actually keep: each line's net revenue minus the cost of the goods sold, after discounts and refunds.

See which customers pay off and which don't, which products are missing a cost, and publish your catalog to Google and Meta without uploading files.

Uninstall and the data stays in your database. No lock-in, no export request.
```
✅ Nessuna promessa di conservazione per X giorni. L'unica promessa è "i dati restano nel tuo database" (verificabile) e "nessun lock-in" (vero: il DB è del merchant).

**Elenco funzioni (EN):**
```
1. Real profit per order, customer and product, after discounts and refunds
2. Data lives in a Supabase database you own — it stays if you uninstall
3. See which customers actually pay off, not just who orders most
4. Flags products with no cost, the ones that would skew your numbers
5. Catalog published to Google Merchant Center and Meta, always current
6. Download or delete your data whenever you want, no emails needed
```
✅ Nessuna percentuale di guadagno, nessun "risparmia X ore", nessuna garanzia temporale.

**Cosa è VIETATO scrivere** (fonte: `descrizione-app-store.md` righe 113-124):
- Percentuali o cifre di guadagno («+30% di margine», «risparmia 10 ore»)
- Prezzi nella descrizione (solo nella sezione prezzi)
- Nomi di app concorrenti
- Marchi Shopify nell'icona
- Elenchi di parole chiave
- Funzioni non presenti (es. tracciamento server-side, fuori dal build)

### Come verificare
1. Rileggere i testi in `descrizione-app-store.md`
2. Verificare che nel Partner Dashboard i testi non contengano:
   - Promesse di persistenza "365 giorni" o simili
   - Garanzie di risultato "+X% margine"
   - Riferimenti a funzioni non implementate (es. tracciamento lato tema)
3. Confrontare con le linee guida Shopify: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices

### [ ] Fatto
Confermo che il listing non contiene promesse non dimostrabili né garanzie di persistenza temporale.

---

## DASH-09 — Istruzioni di review per Shopify

### Cosa controllare
Le istruzioni di review devono includere store di test, credenziali funzionanti e percorsi per testare piani, tracking, spedizioni e GDPR.

### Dove nel Partner Dashboard
Partner Dashboard → App **Kerdon** → **Distribution** → **Submit for review** → "Test instructions" (campo di testo lungo)

### Valore esatto (bozza in EN, con segnaposto per credenziali)

```
# Test Instructions for Kerdon Review

## Test Store Credentials

**Store:** [DA COMPILARE: nome.myshopify.com]
**Email:** [DA COMPILARE: email login]
**Password:** [DA COMPILARE: password]

The store has sample products, customers with marketing consent, and test orders with shipping and return data.

---

## 1. Installation and Initial Sync

1. Install the app from the test store
2. The app will request 11 OAuth scopes (see DASH-03 above for the full list)
3. Approve all scopes
4. The test store already has a Supabase project connected, so you don't need to create any external account. If you need to reconnect it, use these test credentials: [DA COMPILARE: project URL e credenziali Supabase di test, oppure conferma che lo store di test ha gia' Supabase collegato]
5. The app will perform initial sync of products, customers (only those with marketing consent), and orders
6. Wait for sync completion (visible in app dashboard)

---

## 2. Test Plans and Limits

### Basic Plan (Free)
- **Limits:** 20 products, 0 customers (customer sync disabled), no product feeds
- **Test:** With 21 products eligible for sync on the Basic plan, the Dashboard shows the "Product limit reached" banner ("1 product won't be synced because you've reached your plan's limit…") with an "Upgrade to Growth now" button. Products beyond the limit are left out of the sync; nothing is deleted.

### Growth Plan (€29/month)
- **Limits:** 200 products, 250 customers, product feeds enabled
- **Test:** Subscribe to Growth plan from the app's Billing page → verify Shopify billing charge

### Scale Plan (€79/month)
- **Limits:** 1,000 products, 500 customers, product feeds enabled
- **Test:** Upgrade to Scale → verify new limits in app dashboard

### Core Plan (€149/month)
- **Limits:** Unlimited products and customers
- **Test:** Upgrade to Core → no limits shown

**Note:** Order limits do NOT exist on any plan (verified in DASH-01).

---

## 3. Test Tracking and Visitor Recognition

Tracking is not a switch inside the app: it connects the merchant's own server-side endpoint to the app. It is configured from the **tracking card on the app's Dashboard**:

1. Choose the path: a server-side Google Tag Manager container (sGTM) or a Cloudflare Worker.
2. Enter the store's endpoint address.
3. Generate the ingest key (`kin_…`) and copy it into the container or Worker.
4. Press **Verify**: the app checks that the endpoint answers and that the key is accepted.

The test store [DA COMPILARE: indicare se lo store di test ha gia' un container sGTM configurato con la chiave di ingest, oppure scrivere che la verifica del reviewer si ferma al passo 4 "Verify"].

If the container is configured:

5. Visit the online store and accept the cookie banner (analytics and marketing). The endpoint calls `/rest/v1/tracking_id`, which mints a pseudonymous browser identifier (`kerdon_` + 32 random characters) and records it in the `users` table of the merchant's own Supabase project.
6. Place a test order as a logged-in customer. If the cart attribute `_kerdon_external_id` holds an identifier minted by `/rest/v1/tracking_id` **for this store**, the orders webhook links that browser to the customer in the `users` table. Identifiers that were never minted for this store are ignored.
7. Withdraw consent from the banner and load another page: on the next call to the endpoint the cookie expires and the browser's row (and its link to the customer) is deleted from the merchant's database. The 90-day period applies only to the automatic pruning of anonymous rows that were never linked to a customer.

**Note:** Nothing is written to Shopify by this feature. The browser–customer link lives only in the `users` table of the merchant's Supabase project. The only writes the app makes to Shopify are the date-of-birth metafield and the unit cost on InventoryItem (see DASH-02).

---

## 4. Test Shipping and Logistics Cost

1. Create a test order with shipping address in a specific country (e.g., United States)
2. From the app's Settings → Shipping tab, configure shipping zones and rates
3. Mark the order as fulfilled with tracking numbers
4. The app should:
   - Read `shippingAddress.countryCodeV2` (only the country, not full address)
   - Count tracking numbers to determine parcel count (tracking numbers are NOT stored)
   - Calculate logistics cost based on shipping zone and parcel count
   - Subtract logistics cost from order profit
5. Verify in app dashboard that the order shows correct profit after logistics cost

**Scope used:** `read_shipping`, `read_returns`

---

## 5. Test Returns Handling

1. Create a return for an existing order
2. Approve the return (`returns/approve` webhook)
3. The app should:
   - Read return status and date (`returns.nodes.status`, `returns.nodes.createdAt`)
   - Recalculate order profit including return cost
4. Cancel or decline the return → profit should update again
5. Verify that only OPEN and CLOSED returns affect cost calculation

**Scope used:** `read_returns`

---

## 6. Test Product Cost Write-back

1. From app's Products tab, edit the cost of an inventory item
2. Click "Save" → the app writes `cost` to `InventoryItem` on Shopify
3. Verify in Shopify Admin that the cost was updated

**Scope used:** `write_inventory`

---

## 7. Test Customer Birthdate Write-back

1. From app's Customers tab, configure the birthdate metafield source (e.g., `facts.birth_date`)
2. Upload a customer with a birthdate in your database but not in Shopify
3. The app should:
   - Create the metafield definition `facts.birth_date` if it doesn't exist
   - Write the birthdate value from your database to Shopify's customer metafield
4. Verify in Shopify Admin → Customers that the birthdate metafield now has a value

**Scope used:** `write_customers`

**Note:** The app does NOT modify customer name, email, phone, or address. It only writes the birthdate metafield.

---

## 8. Test GDPR Compliance

### Customer Data Request (`customers/data_request`)
1. From Shopify Admin → Settings → Customer privacy, simulate a data request for a test customer
2. The app receives the webhook and prepares an export
3. Export should include: customer details, order rows with logistics data
4. Verify export is deleted after 30 days

### Customer Redaction (`customers/redact`)
1. Simulate a customer redaction request
2. The app should:
   - Mark customer as redacted (`customer_redacted_at`)
   - Zero out: `shopify_customer_id`, `customer_first_name`, `customer_last_name`, `shipping_country_code`
   - Keep: order totals, line items, logistics costs (anonymized order history)
3. Verify that a database trigger prevents re-sync of redacted fields
4. Visitor recognition data for that customer should be deleted

### Shop Redaction (`shop/redact`)
1. Simulate shop redaction (uninstall + 48 hours)
2. The app should delete shop configuration from Kerdon's database (shipping rates, etc.)
3. The merchant's Supabase database is NOT touched (it's theirs)

**Scopes used:** `read_customers`, `read_orders`

---

## 9. Test Historical Orders Sync (`read_all_orders`)

1. The test store should have orders older than 60 days
2. Trigger a full historical sync from the app
3. Verify that ALL orders are synced, not just recent ones
4. Calculate LTV (Lifetime Value) for a customer with old orders
5. Without `read_all_orders`, the LTV would be incomplete

**Justification:** See DASH-04 above.

---

## 10. Smoke Test on a Clean Store

1. Create a brand new Shopify development store
2. Install Kerdon from scratch
3. Connect a new Supabase project
4. Approve all 11 OAuth scopes
5. Add 5 products, 3 customers with consent, 2 test orders
6. Verify initial sync completes successfully
7. Subscribe to Growth plan (€29) → verify Shopify billing charge
8. Enable visitor recognition → verify browser identifier is created
9. Configure shipping zones → verify logistics cost calculation
10. Uninstall the app → verify that Supabase data STAYS (no automatic deletion)

---

## Emergency Developer Contact

**Name:** Stefano Ghisoni  
**Email:** [DA COMPILARE: email personale o stefanoghisoni.adv@gmail.com]  
**Phone:** [DA COMPILARE: se richiesto da Shopify]

This contact is for Shopify's internal use only, not public.

---

## Notes for Reviewer

- **All 11 scopes are mandatory** (no optional scopes)
- **Customer limits (250/500) are displayed but not enforced yet** (planned for future release)
- **No Theme App Extension** — tracking is handled via merchant's sGTM container, not theme code
- **Data ownership:** Merchant's data lives in their own Supabase database, not Kerdon's servers
- **Uninstall behavior:** Data stays in merchant's database (no lock-in)
```

### Segnaposto da compilare

1. `[DA COMPILARE: nome.myshopify.com]` — lo store di test usato per la submission
2. `[DA COMPILARE: email login]` — credenziali di accesso allo store
3. `[DA COMPILARE: password]` — password dello store
4. `[DA COMPILARE: email personale o stefanoghisoni.adv@gmail.com]` — contatto emergenza
5. `[DA COMPILARE: project URL e credenziali Supabase di test, ...]` — il revisore non deve aprire account esterni: o lo store di test ha gia' Supabase collegato, o si forniscono credenziali di un progetto di test
6. `[DA COMPILARE: ... container sGTM ...]` — se lo store di test ha un container sGTM gia' configurato, o se la verifica del tracciamento si ferma a "Verify"
7. `[DA COMPILARE: email del contatto di emergenza]` — DASH-10

**Perché segnaposto:** solo l'utente conosce quale store di test userà e quali credenziali fornire al revisore. Queste informazioni non devono essere committate nel repository.

### Come verificare
1. Copiare il testo sopra nel campo "Test instructions" del Partner Dashboard
2. Sostituire tutti i segnaposto `[DA COMPILARE: ...]` con i valori reali
3. Testare ogni percorso indicato su uno store pulito prima di inviare in revisione

### [ ] Fatto
Confermo di aver scritto le istruzioni di review complete con percorsi per piani, tracking, spedizioni e GDPR.

---

## DASH-10 — Emergency Developer Contact

### Cosa controllare
Configurare un contatto sviluppatore di emergenza per Shopify (solo uso interno, non pubblico).

### Dove nel Partner Dashboard
Partner Dashboard → Settings → **Account** → Emergency contact

### Valore esatto

**Nome:** Stefano Ghisoni  
**Email:** [DA COMPILARE: email del contatto di emergenza]  
**Telefono:** [DA COMPILARE se richiesto da Shopify]

**Fonte:** dati del titolare da `docs/legal/privacy-policy.md` riga 7:

> Kerdon is an application for Shopify stores, operated by Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148, Genoa (GE), Italy, VAT IT02705860993.

### Come verificare
1. Inserire nome e email nel campo Emergency contact
2. Questo contatto è per uso interno di Shopify in caso di problemi critici (sicurezza, violazioni)
3. Non compare nel listing pubblico

### [ ] Fatto
Confermo di aver configurato il contatto sviluppatore di emergenza.

---

## Riepilogo finale prima della submission

Prima di cliccare "Submit for review", verificare:

- [ ] DASH-01: Pricing coincide con `plan-tiers.ts` (Basic/Growth/Scale/Core)
- [ ] DASH-02: Tutti i campi PCD dichiarati (nome, email, telefono, indirizzo, dati logistici)
- [ ] DASH-03: 11 scope esatti da `shopify.app.toml`
- [ ] DASH-04: Giustificazione `read_all_orders` per LTV storico
- [ ] DASH-05: "Merchant must have online store" selezionato
- [ ] DASH-06: Nessuna Theme App Extension (directory `extensions/` assente)
- [ ] DASH-07: Privacy URL `https://api.kerdon.io/policies/privacy-policy` accessibile (200 OK), support `support@kerdon.io` valido
- [ ] DASH-08: Nessuna promessa di persistenza 365 giorni o garanzia di risultato
- [ ] DASH-09: Istruzioni di review complete con percorsi test (segnaposto compilati)
- [ ] DASH-10: Emergency contact configurato

**Smoke test su negozio pulito:** eseguire i 10 passi della sezione "Smoke Test" in DASH-09 prima di inviare.

---

## File sorgente consultati

- `app/lib/billing/plan-tiers.ts` — pricing e limiti
- `shopify.app.toml` — scope OAuth e configurazione app
- `docs/scopes.md` — giustificazioni scope
- `docs/legal/protected-customer-data.md` — inventario campi PCD
- `app/lib/legal/order-data-inventory.ts` — dati logistici ordini
- `docs/legal/privacy-policy.md` — privacy policy versione 1.4
- `/Users/stefanoghisoni/Desktop/Kerdon-App-Store/descrizione-app-store.md` — testi App Store
- `prisma/plan-catalog-sync.test.ts` — test di coerenza listino
- Verifiche curl su `kerdon.io` e `api.kerdon.io`

---

**Ultimo controllo eseguito:** 2026-10-02  
**Autore:** Claude Sonnet 4.5  
**Sessione:** https://claude.ai/code/session_019kMax6s282fAemZSwU4gFo
