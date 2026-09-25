# Shipping Costs Management - Design Specification

**Data**: 2026-09-23  
**Versione**: 1.1 (revisione vincolante in testa — prevale sul resto del documento)

## Revisione 1.2 — costi per opzione di spedizione (2026-09-24, vincolante)

Prevale su 1.1 dove la contraddice.

1. **Costo per opzione, non solo per zona.** In Shopify ogni zona contiene piu' opzioni di spedizione (method definitions: "Standard", "Express", ...). Kerdon importa le opzioni di ogni zona e il merchant scrive il costo reale di ciascuna. L'ordine dice quale opzione ha scelto il cliente (`shippingLines` → `title`): il costo si prende da quella opzione.
2. **Tipi di costo di un'opzione:** `flat` (costo fisso per spedizione), `linear` (EUR/kg), `weight_brackets` (fasce di peso), `value_brackets` (fasce di valore dell'ordine). All'import il tipo si propone dal tipo Shopify: Forfettaria → flat; condizioni sul peso → weight_brackets con le stesse soglie; condizioni sull'importo → value_brackets con le stesse soglie; calcolata dal corriere → linear. I costi importati partono a 0: le cifre di Shopify sono cio' che paga il cliente, non il costo. Il merchant puo' cambiare il tipo.
3. **Opzioni con lo stesso nome** nella stessa zona (fasce create in Shopify come tariffe separate con condizioni diverse) diventano UNA opzione con piu' fasce.
4. **Abbinamento ordine → opzione:** zona dal paese (regole 1.1), poi opzione per nome, confronto senza maiuscole/minuscole e spazi ai bordi. Nessuna opzione che combacia → si usa la tariffa generica della zona (quella di 1.1), che resta come ripiego. Niente tariffa generica → spedizione 0.
5. **Valore dell'ordine** per `value_brackets` = `orders.total_price`.
6. **Re-import:** aggiorna nomi/soglie proposte solo per opzioni nuove; le opzioni gia' presenti conservano tipo e costi scritti dal merchant. Opzioni sparite da Shopify restano (servono agli ordini storici).
7. **Colonna nuova sugli ordini (schema merchant v13):** `shipping_method TEXT` = `title` della prima shipping line.
8. Ogni salvataggio e ogni re-import accodano il ricalcolo (`enqueueLogisticsRecompute`).

## Revisione 1.1 — correzioni dopo la verifica sul codice (2026-09-23)

Queste regole **sostituiscono** le parti del documento che le contraddicono.

1. **Costo logistico salvato sull'ordine, non calcolato al volo.** Il profitto si calcola in SQL sul database del merchant (`app/lib/customers/net-contribution.ts`, frammenti usati da `customers-query.ts`); le tariffe stanno sul DB owner, e le due basi non si possono unire in una query. Quindi: colonna `logistics_cost NUMERIC(10,2)` su `orders` (DB merchant), calcolata in TypeScript da una funzione pura al momento della scrittura dell'ordine, e **ricalcolata in background** su tutti gli ordini quando il merchant salva zone/tariffe/packaging. Niente cache LRU.
2. **Una volta per ordine.** Le query del profitto uniscono `orders` a `order_lines`: il costo logistico va sottratto una sola volta per ordine, mai una volta per riga. Il profitto per prodotto (`top-products.ts`) resta senza costo logistico: e' un costo dell'ordine, non del prodotto.
3. **Solo ordini spediti.** Spedizione e packaging si applicano solo se l'ordine risulta spedito (codice di tracciamento presente, oppure stato Shopify FULFILLED/PARTIALLY_FULFILLED). Il costo di rientro si applica se l'ordine ha un reso.
4. **API Shopify.** Zone: `deliveryProfiles → profileLocationGroups → locationGroupZones → zone { name countries { code { countryCode restOfWorld } } }` (scope `read_shipping`). Resi: connessione `returns` dell'ordine (scope `read_returns`), non `refunds`: un rimborso non e' un pacco rientrato. Peso: `Order.totalWeight` (grammi). Paese: `shippingAddress.countryCodeV2`. Tracking: `fulfillments { trackingInfo { number } }`. Gli scope nuovi richiedono `shopify app deploy`.
5. **Peso mancante.** Se `totalWeight` e' 0/assente si usa `peso di default per articolo × numero di articoli`; se manca anche quello, il costo spedizione e' 0 e l'ordine conta come "senza peso" per l'avviso informativo in dashboard.
6. **Zona "Resto del mondo".** Un paese non elencato in nessuna zona cade nella zona con `restOfWorld`, se esiste.
7. **Colonne ordini (schema merchant v12):** `fulfillment_status TEXT`, `shipping_country_code TEXT`, `total_weight_grams INTEGER`, `item_count INTEGER`, `returned_at TIMESTAMP`, `packaging_category TEXT`, `logistics_cost NUMERIC(10,2)`.
8. **Tabelle owner:** migrazione Prisma in `prisma/migrations/<timestamp>_shipping_costs/` con RLS abilitata su ogni tabella nuova (come `product_feeds`); `shipping_zones` ha anche `rest_of_world BOOLEAN`.
9. **Navigazione:** voce "Spedizioni" nella `NavMenu` di `app/root.tsx`, dopo Clienti, solo a configurazione completata. **Testi** in `app/lib/i18n/it.ts` + `en.ts`, mai stringhe fisse nei componenti.

**Stato**: Approved

## Contesto e Motivazione

Il calcolo del profitto attualmente sottrae solo i costi prodotto dal revenue. I costi logistici (spedizione, packaging, rientri) non sono considerati, rendendo il margine calcolato irrealistico per merchant con costi di spedizione significativi.

Questa feature aggiunge la gestione completa dei costi logistici:
- Tariffe spedizione per zona geografica (lineari o a fasce peso)
- Costi packaging per categoria imballo
- Costi rientri/resi
- Integrazione nel calcolo profitto
- Input per modello predittivo LTP (Lifetime Profit)

## Obiettivi

1. **Configurazione flessibile**: merchant definisce tariffe per zona, packaging, resi
2. **Sync automatico**: zone ereditate da Shopify, dati ordini arricchiti con fulfillment/peso/paese
3. **Calcolo accurato**: profitto = revenue - product_cost - shipping_cost
4. **Gestione graceful**: peso mancante, zone non configurate → fallback senza bloccare
5. **UX chiara**: sezione dedicata `/spedizioni`, alert contestuali, validazione

## Approccio Architetturale

**Approccio scelto**: B - Bilanciato Feature-Complete

- 3 tabelle normalizzate (shipping_zones, shipping_rates, packaging_config)
- Tariffe lineari E a fasce (merchant sceglie per zona)
- Packaging custom con fallback regole peso
- Peso default configurabile
- Costo rientri forfait
- Alert info dismissibile per peso mancante

**Alternative scartate**:
- A (MVP JSON blob): troppo limitato, richiede refactor futuro
- C (Full-featured): overengineering, feature non richieste (storico, CSV import, report)

---

## Architettura Sistema

### Diagramma Integrazione

```
┌─────────────────────────────────────────────────────────────┐
│ SHOPIFY                                                      │
│  └─ GraphQL API                                             │
│      ├─ Orders (+ fulfillment, shipping, weight)            │
│      └─ ShippingZones (profili spedizione merchant)         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ SYNC LAYER (app/lib/sync/)                                  │
│  ├─ orderNodeFields() → +5 campi GraphQL                    │
│  ├─ syncShippingZones() → legge zone Shopify (una tantum)  │
│  └─ mapOrderWithAllLines() → popola nuove colonne          │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         ▼                           ▼
┌──────────────────┐        ┌───────────────────┐
│ DB MERCHANT      │        │ DB OWNER          │
│ (Supabase)       │        │ (Postgres)        │
│                  │        │                   │
│ orders           │        │ shipping_zones    │
│  +fulfillment    │        │ shipping_rates    │
│  +shipping_ctry  │        │ packaging_config  │
│  +total_weight   │        │                   │
│  +returned_at    │        │                   │
│  +packaging_cat  │        │                   │
└────────┬─────────┘        └─────────┬─────────┘
         │                            │
         └──────────┬─────────────────┘
                    ▼
         ┌────────────────────────┐
         │ CALCOLO PROFITTO       │
         │ (net-contribution.ts)  │
         │                        │
         │ revenue                │
         │ - product_cost         │
         │ - shipping_cost ◄──NEW │
         │ = profit               │
         └────────────────────────┘
                    │
                    ▼
         ┌────────────────────────┐
         │ UI                     │
         │ /spedizioni ◄──────NEW │
         │ /dashboard (alert)     │
         │ /customers (profitto)  │
         └────────────────────────┘
```

### Punti Chiave

- **DB owner** tiene configurazione (zone, tariffe, packaging) — una per shop
- **DB merchant** tiene dati operazionali (5 colonne nuove su orders) — via migrazione schema v12
- **Sync zone** una tantum al primo accesso `/spedizioni` + refresh manuale
- **Calcolo costi** integrato in `net-contribution.ts` (esistente)
- **Nuova sezione** `/spedizioni` di primo livello in navigazione

---

## Schema Database

### DB Owner (Postgres) - 3 Nuove Tabelle

#### `shipping_zones`

Zone di spedizione importate da Shopify.

```sql
CREATE TABLE shipping_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,           -- "Italia", "UE", "Resto del mondo"
  countries TEXT[] NOT NULL,         -- ['IT'] o ['FR','DE','BE',...]
  rate_type TEXT NOT NULL,           -- 'linear' | 'brackets'
  synced_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(shop_id, zone_name)
);
CREATE INDEX idx_shipping_zones_shop ON shipping_zones(shop_id);
```

**Campi**:
- `zone_name`: nome zona definito in Shopify
- `countries`: array codici ISO paese (ereditati da Shopify)
- `rate_type`: 'linear' (€/kg) o 'brackets' (fasce peso)

#### `shipping_rates`

Tariffe per zona. Una riga se linear, N righe se brackets.

```sql
CREATE TABLE shipping_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id UUID NOT NULL REFERENCES shipping_zones ON DELETE CASCADE,
  weight_from NUMERIC(10,3),         -- NULL se linear, altrimenti soglia min kg
  weight_to NUMERIC(10,3),           -- NULL se linear, altrimenti soglia max kg
  cost_per_kg NUMERIC(10,2),         -- se linear: €/kg; se brackets: costo fisso fascia
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_shipping_rates_zone ON shipping_rates(zone_id);
```

**Esempi**:

Zona linear (1 riga):
```
zone_id | weight_from | weight_to | cost_per_kg
--------|-------------|-----------|------------
uuid-IT | NULL        | NULL      | 2.50
```

Zona brackets (3 righe):
```
zone_id | weight_from | weight_to | cost_per_kg
--------|-------------|-----------|------------
uuid-EU | 0           | 1         | 5.00
uuid-EU | 1           | 5         | 8.00
uuid-EU | 5           | NULL      | 15.00
```

#### `packaging_config`

Configurazione packaging e fallback.

```sql
CREATE TABLE packaging_config (
  shop_id TEXT PRIMARY KEY,
  categories JSONB NOT NULL,         -- [{name: "Busta", cost: 1.50}, ...]
  fallback_rules JSONB NOT NULL,     -- [{weight_max: 1, category: "Busta"}, ...]
  default_weight_per_item NUMERIC(10,3), -- peso default se mancante (kg/articolo)
  return_cost NUMERIC(10,2),         -- costo forfait rientro
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Struttura JSONB**:

`categories`:
```json
[
  {"name": "Busta", "cost": 1.50},
  {"name": "Scatola S", "cost": 2.50},
  {"name": "Scatola L", "cost": 4.00}
]
```

`fallback_rules`:
```json
[
  {"weight_max": 1, "category": "Busta"},
  {"weight_max": 5, "category": "Scatola S"},
  {"weight_max": null, "category": "Scatola L"}
]
```

### DB Merchant (Supabase) - 5 Nuove Colonne

Migrazione schema versione 12 aggiunge colonne a tabella `orders`:

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_country_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_weight NUMERIC(10,3);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS returned_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS packaging_category TEXT;
```

**Logica popolamento** (in `mapOrderWithAllLines()`):

- `fulfillment_status`: se ha `trackingNumber` → 'fulfilled', altrimenti da `displayFulfillmentStatus`
- `shipping_country_code`: da `shippingAddress.countryCodeV2`
- `total_weight`: somma `lineItem.variant.weight` × `quantity`; se mancante usa `default_weight_per_item × total_quantity`
- `returned_at`: da `refunds[0].createdAt` se presente
- `packaging_category`: da metafield `custom.packaging_category`, altrimenti applica `fallback_rules` su peso

---

## Sync Dati Shopify

### Sync Shipping Zones

**Quando**: 
- Primo accesso a `/spedizioni` (lazy init)
- Click button "Aggiorna zone da Shopify"

**Query GraphQL**:
```graphql
query {
  shop {
    shippingZones {
      nodes {
        id
        name
        countries {
          code { countryCode }
        }
      }
    }
  }
}
```

**Implementazione**: `app/lib/shipping/sync-zones.server.ts`

```typescript
export async function syncShippingZones(shopId: string): Promise<SyncResult> {
  const zones = await shopifyGraphQL(shopId, ZONES_QUERY);
  
  let added = 0, updated = 0;
  
  for (const zone of zones) {
    const result = await prisma.shippingZones.upsert({
      where: { 
        shopId_zoneName: { shopId, zoneName: zone.name } 
      },
      create: { 
        shopId, 
        zoneName: zone.name, 
        countries: zone.countries.map(c => c.code.countryCode),
        rateType: 'linear' // default, merchant può cambiare
      },
      update: { 
        countries: zone.countries.map(c => c.code.countryCode),
        syncedAt: new Date()
      }
    });
    
    result.created ? added++ : updated++;
  }
  
  return { added, updated };
}
```

**Merge intelligente**:
- Zona nuova → insert con `rateType: 'linear'`, nessuna tariffa (costo 0)
- Zona esistente → aggiorna solo `countries` e `syncedAt` (tariffe invariate)
- Zona rimossa in Shopify → resta in DB (merchant può aver configurato tariffe storiche)

### Sync Order Data

**Modifiche a `shopify-api.server.ts`**:

#### Estensione GraphQL Query

Funzione `orderNodeFields()` (riga ~262):

```typescript
function orderNodeFields(lineItemsFirst: number): string {
  return `
    id name createdAt updatedAt cancelledAt
    displayFinancialStatus
    displayFulfillmentStatus
    fulfillments { trackingInfo { number } }
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    customer { id firstName lastName }
    shippingAddress { countryCodeV2 }
    totalWeight
    refunds { createdAt }
    metafield(namespace: "custom", key: "packaging_category") { value }
    lineItems(first: ${lineItemsFirst}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title quantity currentQuantity
        product { id }
        variant { 
          id 
          weight 
          weightUnit 
        }
        priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
        discountedUnitPriceSet { shopMoney { amount } }
        originalUnitPriceSet { shopMoney { amount } }
        totalDiscountSet { shopMoney { amount } }
      }
    }
  `;
}
```

**Campi nuovi**:
- `displayFulfillmentStatus`
- `fulfillments.trackingInfo.number`
- `shippingAddress.countryCodeV2`
- `totalWeight`
- `refunds.createdAt`
- `metafield(namespace: "custom", key: "packaging_category")`
- `variant.weight` e `variant.weightUnit` (per calcolo peso totale)

#### Mapping a Righe DB

Funzione `mapOrderWithAllLines()` (riga ~1392):

```typescript
function mapOrderWithAllLines(
  order: GqlOrder, 
  config: PackagingConfig | null
): OrderRow {
  const orderRow: OrderRow = {
    // ... campi esistenti ...
    
    // Fulfillment status
    fulfillment_status: determineF fulfillmentStatus(order),
    
    // Shipping country
    shipping_country_code: order.shippingAddress?.countryCodeV2 || null,
    
    // Total weight
    total_weight: calculateTotalWeight(order.lineItems, config?.default_weight_per_item),
    
    // Returned
    returned_at: order.refunds?.[0]?.createdAt 
      ? new Date(order.refunds[0].createdAt) 
      : null,
    
    // Packaging
    packaging_category: determinePackagingCategory(
      order.metafield?.value,
      calculateTotalWeight(order.lineItems, config?.default_weight_per_item),
      config?.fallback_rules
    )
  };
  
  return orderRow;
}

function determineFulfillmentStatus(order: GqlOrder): string | null {
  // Se ha tracking number → considerato spedito
  const hasTracking = order.fulfillments?.some(f => f.trackingInfo?.number);
  if (hasTracking) return 'fulfilled';
  
  return order.displayFulfillmentStatus || null;
}

function calculateTotalWeight(
  lineItems: GqlLineItem[], 
  defaultPerItem?: number
): number | null {
  let total = 0;
  let hasMissing = false;
  
  for (const item of lineItems) {
    const itemWeight = item.variant?.weight;
    
    if (itemWeight != null) {
      // Converti a kg se necessario
      const weightKg = item.variant.weightUnit === 'GRAMS' 
        ? itemWeight / 1000 
        : itemWeight;
      total += weightKg * item.quantity;
    } else {
      hasMissing = true;
      if (defaultPerItem) {
        total += defaultPerItem * item.quantity;
      }
    }
  }
  
  // Se tutti mancanti e nessun default → NULL
  if (hasMissing && !defaultPerItem) return null;
  
  return total;
}

function determinePackagingCategory(
  metafieldValue: string | undefined,
  totalWeight: number | null,
  fallbackRules: FallbackRule[] | undefined
): string | null {
  // 1. Prima prova metafield Shopify
  if (metafieldValue) return metafieldValue;
  
  // 2. Applica fallback rules su peso
  if (totalWeight && fallbackRules) {
    for (const rule of fallbackRules) {
      if (rule.weight_max === null || totalWeight <= rule.weight_max) {
        return rule.category;
      }
    }
  }
  
  // 3. Nessun match → NULL (costo packaging = 0)
  return null;
}
```

---

## User Interface

### Navigazione

**Route**: `/spedizioni`  
**Livello**: Primo (allo stesso livello di Dashboard, Prodotti, Clienti, Impostazioni)

**Aggiunta in** `app/components/Navigation.tsx`:
```tsx
const navItems = [
  { label: 'Dashboard', url: '/' },
  { label: 'Prodotti', url: '/products' },
  { label: 'Clienti', url: '/customers' },
  { label: 'Spedizioni', url: '/spedizioni' }, // ◄── NEW
  { label: 'Impostazioni', url: '/settings/supabase' }
];
```

### Layout Principale

**File**: `app/routes/spedizioni.tsx`

```tsx
export default function SpedizioniPage() {
  const { zones, packaging, stats } = useLoaderData<typeof loader>();
  const [editingZone, setEditingZone] = useState<Zone | null>(null);
  
  return (
    <Page 
      title="Costi di Spedizione"
      primaryAction={
        <Button onClick={syncZones}>Aggiorna zone da Shopify</Button>
      }
    >
      {!zones.length && <EmptyState />}
      
      {stats.ordersWithoutWeight > 0 && (
        <WeightMissingBanner count={stats.ordersWithoutWeight} />
      )}
      
      <Layout>
        <Layout.Section>
          <ShippingZonesTable 
            zones={zones}
            onEditZone={setEditingZone}
          />
        </Layout.Section>
        
        <Layout.Section secondary>
          <PackagingCard config={packaging} />
        </Layout.Section>
      </Layout>
      
      {editingZone && (
        <EditZoneModal 
          zone={editingZone}
          onClose={() => setEditingZone(null)}
        />
      )}
    </Page>
  );
}
```

### Componenti

#### `ShippingZonesTable`

Overview tabellare di tutte le zone.

```tsx
<DataTable
  columnContentTypes={['text', 'text', 'text', 'numeric', 'text']}
  headings={['Zona', 'Paesi', 'Tipo tariffa', 'Costo indicativo', 'Azioni']}
  rows={zones.map(zone => [
    zone.name,
    zone.countries.slice(0, 3).join(', ') + (zone.countries.length > 3 ? '...' : ''),
    zone.rateType === 'linear' ? 'Lineare (€/kg)' : 'Fasce peso',
    formatIndicativeCost(zone),
    <Button onClick={() => onEditZone(zone)}>Modifica</Button>
  ])}
/>
```

**Costo indicativo**:
- Linear: "€2.50/kg"
- Brackets: "€5.00 - €15.00" (min/max fasce)
- Non configurato: "—"

#### `EditZoneModal`

Modal per configurare tariffa singola zona.

```tsx
<Modal
  open={!!zone}
  onClose={onClose}
  title={`Tariffa spedizione: ${zone.name}`}
  primaryAction={{ content: 'Salva', onAction: handleSave }}
>
  <Modal.Section>
    <FormLayout>
      {/* Info zona */}
      <TextContainer>
        <Text as="p" variant="bodyMd">
          Paesi: {zone.countries.join(', ')}
        </Text>
      </TextContainer>
      
      {/* Tipo tariffa */}
      <ChoiceList
        title="Tipo tariffa"
        choices={[
          { label: 'Lineare (€ per kg)', value: 'linear' },
          { label: 'Fasce di peso', value: 'brackets' }
        ]}
        selected={[rateType]}
        onChange={([value]) => setRateType(value)}
      />
      
      {/* Configurazione linear */}
      {rateType === 'linear' && (
        <TextField
          label="Costo per kg (€)"
          type="number"
          value={costPerKg}
          onChange={setCostPerKg}
          suffix="€/kg"
          min="0"
          step="0.01"
        />
      )}
      
      {/* Configurazione brackets */}
      {rateType === 'brackets' && (
        <BracketsEditor 
          brackets={brackets}
          onChange={setBrackets}
        />
      )}
    </FormLayout>
  </Modal.Section>
</Modal>
```

#### `BracketsEditor`

Lista editabile fasce peso.

```tsx
<BlockStack gap="400">
  <Text as="h3" variant="headingSm">Fasce di peso</Text>
  
  {brackets.map((bracket, idx) => (
    <InlineStack key={idx} gap="200" align="space-between">
      <TextField
        label="Da (kg)"
        type="number"
        value={bracket.weight_from}
        disabled
      />
      <TextField
        label="A (kg)"
        type="number"
        value={bracket.weight_to || '∞'}
        onChange={(val) => updateBracket(idx, 'weight_to', val)}
      />
      <TextField
        label="Costo (€)"
        type="number"
        value={bracket.cost}
        onChange={(val) => updateBracket(idx, 'cost', val)}
        suffix="€"
      />
      <Button 
        icon={DeleteIcon} 
        onClick={() => removeBracket(idx)}
        disabled={brackets.length === 1}
      />
    </InlineStack>
  ))}
  
  <Button onClick={addBracket}>Aggiungi fascia</Button>
  
  {validationError && (
    <InlineError message={validationError} />
  )}
</BlockStack>
```

**Validazione**:
- Fasce non sovrapposte
- Copertura continua (nessun gap)
- Prima fascia parte da 0
- Ultima fascia termina a NULL (infinito)

#### `PackagingCard`

Configurazione categorie packaging e fallback.

```tsx
<Card>
  <BlockStack gap="400">
    <Text as="h2" variant="headingMd">Packaging e rientri</Text>
    
    {/* Categorie packaging */}
    <FormLayout>
      <Text as="h3" variant="headingSm">Categorie imballo</Text>
      {categories.map((cat, idx) => (
        <InlineStack key={idx} gap="200">
          <TextField
            label="Nome"
            value={cat.name}
            onChange={(val) => updateCategory(idx, 'name', val)}
          />
          <TextField
            label="Costo (€)"
            type="number"
            value={cat.cost}
            onChange={(val) => updateCategory(idx, 'cost', val)}
            suffix="€"
          />
          <Button 
            icon={DeleteIcon} 
            onClick={() => removeCategory(idx)}
          />
        </InlineStack>
      ))}
      <Button onClick={addCategory}>Aggiungi categoria</Button>
    </FormLayout>
    
    {/* Regole fallback */}
    <FormLayout>
      <Text as="h3" variant="headingSm">Regole fallback (per peso)</Text>
      <Text as="p" variant="bodyMd" tone="subdued">
        Se Shopify non fornisce la categoria, applica queste regole in base al peso totale
      </Text>
      {fallbackRules.map((rule, idx) => (
        <InlineStack key={idx} gap="200">
          <TextField
            label="Peso max (kg)"
            type="number"
            value={rule.weight_max || '∞'}
            onChange={(val) => updateRule(idx, 'weight_max', val)}
          />
          <Select
            label="Categoria"
            options={categories.map(c => ({ label: c.name, value: c.name }))}
            value={rule.category}
            onChange={(val) => updateRule(idx, 'category', val)}
          />
        </InlineStack>
      ))}
    </FormLayout>
    
    {/* Peso default */}
    <TextField
      label="Peso default per articolo (kg)"
      type="number"
      value={defaultWeightPerItem}
      onChange={setDefaultWeightPerItem}
      helpText="Usato quando il prodotto non ha peso configurato in Shopify"
      suffix="kg/articolo"
      min="0"
      step="0.01"
    />
    
    {/* Costo rientro */}
    <TextField
      label="Costo rientro/reso (€)"
      type="number"
      value={returnCost}
      onChange={setReturnCost}
      helpText="Costo aggiuntivo quando un ordine viene restituito"
      suffix="€"
      min="0"
      step="0.01"
    />
  </BlockStack>
</Card>
```

### Alert Dashboard

**WeightMissingBanner** in `app/routes/_index.tsx`:

```tsx
{stats.ordersWithoutWeight > 0 && !alertDismissed && (
  <Banner 
    tone="info"
    onDismiss={handleDismiss}
  >
    <InlineStack gap="200" align="space-between">
      <Text as="p">
        {stats.ordersWithoutWeight} ordini senza peso configurato. 
        I costi di spedizione potrebbero essere imprecisi.
      </Text>
      <Link url="/spedizioni">Configura peso di default</Link>
    </InlineStack>
  </Banner>
)}
```

**Storage dismissal**: tabella `shipping_alert_dismissals` sul DB owner

---

## Calcolo Costi

### Funzione Principale

**File**: `app/lib/shipping/calculate-cost.server.ts`

```typescript
export interface ShippingCostBreakdown {
  shipping: number;
  packaging: number;
  return: number;
  total: number;
}

export async function calculateShippingCost(
  shopId: string,
  order: {
    shipping_country_code: string | null;
    total_weight: number | null;
    packaging_category: string | null;
    returned_at: Date | null;
  }
): Promise<ShippingCostBreakdown> {
  const config = await getShippingConfig(shopId); // cached LRU, TTL 5min
  
  if (!config) {
    return { shipping: 0, packaging: 0, return: 0, total: 0 };
  }
  
  let shipping = 0;
  let packaging = 0;
  let returnCost = 0;
  
  // 1. Costo spedizione (peso × zona)
  if (order.shipping_country_code && order.total_weight) {
    const zone = findZoneByCountry(config.zones, order.shipping_country_code);
    if (zone) {
      shipping = zone.rateType === 'linear'
        ? calculateLinearCost(zone, order.total_weight)
        : calculateBracketCost(zone, order.total_weight);
    }
  }
  
  // 2. Costo packaging
  if (order.packaging_category) {
    const cat = config.packaging.categories.find(
      c => c.name === order.packaging_category
    );
    if (cat) packaging = cat.cost;
  }
  
  // 3. Costo rientro
  if (order.returned_at && config.packaging.return_cost) {
    returnCost = config.packaging.return_cost;
  }
  
  return {
    shipping,
    packaging,
    return: returnCost,
    total: shipping + packaging + returnCost
  };
}

function calculateLinearCost(zone: Zone, weight: number): number {
  return zone.rates[0].cost_per_kg * weight;
}

function calculateBracketCost(zone: Zone, weight: number): number {
  const bracket = zone.rates.find(r => 
    weight >= (r.weight_from ?? 0) && 
    (r.weight_to === null || weight < r.weight_to)
  );
  return bracket?.cost_per_kg ?? 0;
}

function findZoneByCountry(zones: Zone[], countryCode: string): Zone | null {
  return zones.find(z => z.countries.includes(countryCode)) || null;
}
```

### Integrazione Net Contribution

**Modifica**: `app/lib/customers/net-contribution.ts`

```typescript
export interface NetContribution {
  revenue: number;
  productCost: number;
  shippingCost: number; // ◄── NEW
  profit: number;
  margin: number;
}

export async function calculateNetContribution(
  shopId: string,
  customerId: string,
  orders: OrderWithLines[]
): Promise<NetContribution> {
  let totalRevenue = 0;
  let totalProductCost = 0;
  let totalShippingCost = 0; // ◄── NEW
  
  for (const order of orders) {
    // Skip ordini annullati
    if (order.cancelled_at) continue;
    
    totalRevenue += order.total_price;
    
    // Costo prodotti
    for (const line of order.lines) {
      totalProductCost += (line.unit_cost_at_sale ?? 0) * line.quantity;
    }
    
    // ◄── NEW: Costo spedizione
    const shippingCost = await calculateShippingCost(shopId, {
      shipping_country_code: order.shipping_country_code,
      total_weight: order.total_weight,
      packaging_category: order.packaging_category,
      returned_at: order.returned_at
    });
    totalShippingCost += shippingCost.total;
  }
  
  const profit = totalRevenue - totalProductCost - totalShippingCost;
  
  return {
    revenue: totalRevenue,
    productCost: totalProductCost,
    shippingCost: totalShippingCost,
    profit,
    margin: totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0
  };
}
```

### Caching Strategy

**Config shipping** (zone + tariffe + packaging):
- LRU cache in-memory
- TTL: 5 minuti
- Key: `shipping_config:${shopId}`
- Invalidazione: su save configurazione

**Costo per ordine**:
- Calcolato al volo (no materializzazione)
- Ordini cambiano raramente dopo creazione
- Ricalcolo automatico se merchant modifica tariffe

---

## Gestione Errori e Edge Cases

### 1. Peso Mancante

**Scenario**: Merchant non ha configurato peso prodotti in Shopify

**Gestione**:
1. **Sync**: se `variant.weight` è NULL, usa `default_weight_per_item × quantity`
2. **Alert Dashboard**: Banner info (dismissibile) con conteggio ordini senza peso
3. **Fallback graceful**: se anche default mancante → `total_weight = NULL`, costo spedizione = 0
4. **Stats**: contatore `ordersWithoutWeight` nel loader dashboard

**Dismissal**: tabella `shipping_alert_dismissals`
```sql
CREATE TABLE shipping_alert_dismissals (
  shop_id TEXT PRIMARY KEY,
  dismissed_at TIMESTAMP DEFAULT NOW()
);
```

### 2. Zone Cambiate in Shopify

**Scenario**: Merchant modifica zone in Shopify dopo aver configurato tariffe

**Gestione**:
1. Button "Aggiorna zone" in `/spedizioni` ricarica da Shopify
2. **Merge intelligente**:
   - Zona rimossa → tariffe restano (storico), nessun flag archived (merchant può eliminarle manualmente)
   - Zona nuova → aggiunta con `rate_type: 'linear'`, nessuna tariffa (costo 0)
   - Paesi cambiati → aggiornamento lista `countries`, tariffe invariate
3. **Notifica**: Toast "2 zone aggiornate da Shopify" dopo sync

### 3. Packaging Non Riconosciuto

**Scenario**: Ordine ha `packaging_category = "XL"` ma categoria eliminata dal merchant

**Gestione**:
- Fallback a regole peso (se peso presente)
- Se fallback non matcha → costo packaging = 0
- Log warning (non errore bloccante): `console.warn('[shipping] packaging category not found:', category)`

### 4. Paese Non in Zona

**Scenario**: Ordine spedito in paese non coperto da nessuna zona

**Gestione**:
- Costo spedizione = 0 (non blocca profitto)
- Stat in `/spedizioni`: Card "Ordini senza copertura"
  - Conteggio: "12 ordini in paesi non coperti"
  - Lista paesi: "XY (5 ordini), ZW (7 ordini)"
  - Suggerimento: "Aggiungi questi paesi alle tue zone per calcolare costi accurati"

### 5. Tariffe Non Configurate

**Scenario**: Merchant visita `/spedizioni` ma non configura nessuna tariffa

**Gestione**:
- Calcolo profitto continua a funzionare (costi = 0)
- Empty state in UI:
  ```tsx
  <EmptyState
    heading="Nessuna tariffa configurata"
    action={{ content: 'Aggiungi prima zona', onAction: syncZones }}
    image="..."
  >
    <p>Configura le tariffe di spedizione per calcolare costi accurati nel profitto.</p>
  </EmptyState>
  ```
- Feature è **opt-in**: finché non configuri, nessun impatto su calcoli esistenti

### 6. Migrazione Schema Fallisce

**Scenario**: Merchant non ha granted permission su tabella `orders`

**Gestione**:
- Migrazione v12 wrappata in check esistenza tabella:
  ```sql
  DO $$
  BEGIN
    IF to_regclass('public.orders') IS NULL THEN
      RETURN;
    END IF;
    
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status TEXT;
    -- ... altre colonne
  END $$;
  ```
- Sync salta ordini se colonne mancanti
- Alert merchant: "Permesso lettura ordini richiesto per costi spedizione" (link a `/settings/supabase`)

### 7. Calcolo Peso Fallisce

**Scenario**: `lineItem.variant` è NULL (prodotto eliminato)

**Gestione**:
- Skip quel line item nel calcolo peso totale
- Se tutti i variant sono NULL e nessun default configurato → `total_weight = NULL`
- Costo spedizione = 0 per quell'ordine
- Log: `console.warn('[shipping] variant missing for line item:', lineItem.id)`

---

## Testing

### Unit Tests

#### `calculate-cost.server.test.ts`

```typescript
describe('calculateShippingCost', () => {
  beforeEach(async () => {
    // Setup config: zona IT linear €2/kg, packaging Box €3, return €5
    await setupTestConfig(shopId, {
      zones: [{ name: 'Italia', countries: ['IT'], rateType: 'linear', rates: [{ cost_per_kg: 2 }] }],
      packaging: { categories: [{ name: 'Box', cost: 3 }], return_cost: 5 }
    });
  });
  
  it('tariffa lineare: 3kg × €2/kg = €6', async () => {
    const cost = await calculateShippingCost(shopId, {
      shipping_country_code: 'IT',
      total_weight: 3,
      packaging_category: null,
      returned_at: null
    });
    expect(cost).toEqual({ shipping: 6, packaging: 0, return: 0, total: 6 });
  });
  
  it('tariffa a fasce: 4kg cade in fascia 1-5kg = €8', async () => {
    await setupTestConfig(shopId, {
      zones: [{
        name: 'UE',
        countries: ['FR', 'DE'],
        rateType: 'brackets',
        rates: [
          { weight_from: 0, weight_to: 1, cost_per_kg: 5 },
          { weight_from: 1, weight_to: 5, cost_per_kg: 8 },
          { weight_from: 5, weight_to: null, cost_per_kg: 15 }
        ]
      }]
    });
    
    const cost = await calculateShippingCost(shopId, {
      shipping_country_code: 'FR',
      total_weight: 4,
      packaging_category: null,
      returned_at: null
    });
    expect(cost).toEqual({ shipping: 8, packaging: 0, return: 0, total: 8 });
  });
  
  it('packaging + spedizione + rientro: somma tutti i costi', async () => {
    const cost = await calculateShippingCost(shopId, {
      shipping_country_code: 'IT',
      total_weight: 2,           // €4 (linear €2/kg)
      packaging_category: 'Box', // €3
      returned_at: new Date()    // €5
    });
    expect(cost).toEqual({ shipping: 4, packaging: 3, return: 5, total: 12 });
  });
  
  it('paese non in zona: costo 0, non errore', async () => {
    const cost = await calculateShippingCost(shopId, {
      shipping_country_code: 'ZZ', // non esiste
      total_weight: 5,
      packaging_category: null,
      returned_at: null
    });
    expect(cost).toEqual({ shipping: 0, packaging: 0, return: 0, total: 0 });
  });
  
  it('peso NULL: costo 0', async () => {
    const cost = await calculateShippingCost(shopId, {
      shipping_country_code: 'IT',
      total_weight: null,
      packaging_category: null,
      returned_at: null
    });
    expect(cost).toEqual({ shipping: 0, packaging: 0, return: 0, total: 0 });
  });
});
```

#### `packaging-fallback.test.ts`

```typescript
describe('determinePackagingCategory', () => {
  const fallbackRules = [
    { weight_max: 1, category: 'Busta' },
    { weight_max: 5, category: 'Box S' },
    { weight_max: null, category: 'Box L' }
  ];
  
  it('metafield presente: usa quello', () => {
    expect(determinePackagingCategory('Custom Box', 10, fallbackRules))
      .toBe('Custom Box');
  });
  
  it('applica regole: 0.8kg → Busta', () => {
    expect(determinePackagingCategory(undefined, 0.8, fallbackRules))
      .toBe('Busta');
  });
  
  it('applica regole: 3kg → Box S', () => {
    expect(determinePackagingCategory(undefined, 3, fallbackRules))
      .toBe('Box S');
  });
  
  it('applica regole: 10kg → Box L (catch-all)', () => {
    expect(determinePackagingCategory(undefined, 10, fallbackRules))
      .toBe('Box L');
  });
  
  it('nessun peso e nessun metafield: NULL', () => {
    expect(determinePackagingCategory(undefined, null, fallbackRules))
      .toBeNull();
  });
  
  it('peso presente ma nessuna regola: NULL', () => {
    expect(determinePackagingCategory(undefined, 5, []))
      .toBeNull();
  });
});
```

#### `calculate-total-weight.test.ts`

```typescript
describe('calculateTotalWeight', () => {
  it('somma pesi variant: (2kg × 1) + (0.5kg × 3) = 3.5kg', () => {
    const items = [
      { variant: { weight: 2, weightUnit: 'KILOGRAMS' }, quantity: 1 },
      { variant: { weight: 500, weightUnit: 'GRAMS' }, quantity: 3 }
    ];
    expect(calculateTotalWeight(items, undefined)).toBe(3.5);
  });
  
  it('peso mancante con default: (NULL × 2) + (1kg × 1) = 1.4kg (default 0.2kg)', () => {
    const items = [
      { variant: { weight: null }, quantity: 2 },
      { variant: { weight: 1, weightUnit: 'KILOGRAMS' }, quantity: 1 }
    ];
    expect(calculateTotalWeight(items, 0.2)).toBe(1.4);
  });
  
  it('tutti pesi mancanti senza default: NULL', () => {
    const items = [
      { variant: { weight: null }, quantity: 2 },
      { variant: { weight: null }, quantity: 1 }
    ];
    expect(calculateTotalWeight(items, undefined)).toBeNull();
  });
  
  it('conversione grammi: 1500g × 2 = 3kg', () => {
    const items = [
      { variant: { weight: 1500, weightUnit: 'GRAMS' }, quantity: 2 }
    ];
    expect(calculateTotalWeight(items, undefined)).toBe(3);
  });
});
```

### Integration Tests

#### `sync-zones.server.test.ts`

```typescript
describe('syncShippingZones', () => {
  it('zona nuova: insert con rate_type linear di default', async () => {
    mockShopifyAPI([
      { name: 'Italia', countries: [{ code: { countryCode: 'IT' } }] }
    ]);
    
    const result = await syncShippingZones(shopId);
    
    expect(result).toEqual({ added: 1, updated: 0 });
    const zone = await prisma.shippingZones.findFirst({ where: { shopId } });
    expect(zone).toMatchObject({
      zoneName: 'Italia',
      countries: ['IT'],
      rateType: 'linear'
    });
  });
  
  it('zona esistente: update solo paesi + syncedAt', async () => {
    // Setup: zona già presente con tariffe configurate
    await prisma.shippingZones.create({
      data: {
        shopId,
        zoneName: 'UE',
        countries: ['FR', 'DE'],
        rateType: 'brackets'
      }
    });
    await prisma.shippingRates.create({
      data: { zoneId: zone.id, weight_from: 0, weight_to: 5, cost_per_kg: 10 }
    });
    
    // Shopify restituisce paesi aggiornati
    mockShopifyAPI([
      { name: 'UE', countries: [{ code: { countryCode: 'FR' } }, { code: { countryCode: 'BE' } }] }
    ]);
    
    const result = await syncShippingZones(shopId);
    
    expect(result).toEqual({ added: 0, updated: 1 });
    const updated = await prisma.shippingZones.findFirst({ where: { shopId } });
    expect(updated.countries).toEqual(['FR', 'BE']); // paesi aggiornati
    expect(updated.rateType).toBe('brackets'); // invariato
    
    const rate = await prisma.shippingRates.findFirst({ where: { zoneId: updated.id } });
    expect(rate.cost_per_kg).toBe(10); // tariffe invariate
  });
});
```

#### `net-contribution.test.ts`

```typescript
describe('calculateNetContribution con shipping costs', () => {
  it('integra costi spedizione nel profitto', async () => {
    // Setup: zona IT linear €2/kg, packaging Box €3
    await setupTestConfig(shopId, {
      zones: [{ name: 'Italia', countries: ['IT'], rateType: 'linear', rates: [{ cost_per_kg: 2 }] }],
      packaging: { categories: [{ name: 'Box', cost: 3 }] }
    });
    
    // Ordine: €100 revenue, €40 product cost, 2kg peso, packaging Box
    const orders = [{
      total_price: 100,
      cancelled_at: null,
      shipping_country_code: 'IT',
      total_weight: 2,
      packaging_category: 'Box',
      returned_at: null,
      lines: [{ unit_cost_at_sale: 20, quantity: 2 }] // €40 product cost
    }];
    
    const contrib = await calculateNetContribution(shopId, customerId, orders);
    
    expect(contrib).toEqual({
      revenue: 100,
      productCost: 40,
      shippingCost: 7,  // (2kg × €2) + €3 packaging = €7
      profit: 53,       // €100 - €40 - €7 = €53
      margin: 53        // 53%
    });
  });
  
  it('ordine con reso: aggiunge costo rientro', async () => {
    await setupTestConfig(shopId, {
      zones: [{ name: 'Italia', countries: ['IT'], rateType: 'linear', rates: [{ cost_per_kg: 2 }] }],
      packaging: { return_cost: 5 }
    });
    
    const orders = [{
      total_price: 50,
      shipping_country_code: 'IT',
      total_weight: 1,
      packaging_category: null,
      returned_at: new Date(), // ◄── reso
      lines: [{ unit_cost_at_sale: 10, quantity: 1 }]
    }];
    
    const contrib = await calculateNetContribution(shopId, customerId, orders);
    
    expect(contrib.shippingCost).toBe(7); // €2 shipping + €5 return
    expect(contrib.profit).toBe(33);      // €50 - €10 - €7
  });
});
```

### E2E Tests (Playwright)

#### `shipping-flow.spec.ts`

```typescript
test.describe('Shipping costs flow', () => {
  test('configurazione completa e verifica profitto', async ({ page }) => {
    // 1. Login
    await page.goto('/');
    await page.click('text=Login');
    
    // 2. Naviga /spedizioni
    await page.click('nav >> text=Spedizioni');
    await expect(page).toHaveURL('/spedizioni');
    
    // 3. Sync zone da Shopify
    await page.click('text=Aggiorna zone da Shopify');
    await expect(page.locator('text=2 zone aggiunte')).toBeVisible();
    
    // 4. Verifica tabella popolata
    await expect(page.locator('table >> text=Italia')).toBeVisible();
    await expect(page.locator('table >> text=UE')).toBeVisible();
    
    // 5. Configura tariffa zona Italia
    await page.click('table >> text=Italia >> .. >> button:has-text("Modifica")');
    await expect(page.locator('role=dialog >> text=Tariffa spedizione: Italia')).toBeVisible();
    
    // 6. Imposta linear €3/kg
    await page.click('text=Lineare (€ per kg)');
    await page.fill('input[label="Costo per kg"]', '3');
    await page.click('button:has-text("Salva")');
    
    // 7. Verifica toast successo
    await expect(page.locator('text=Tariffa salvata')).toBeVisible();
    
    // 8. Configura packaging
    await page.fill('input[label="Nome"] >> nth=0', 'Busta');
    await page.fill('input[label="Costo"] >> nth=0', '2');
    await page.click('button:has-text("Salva configurazione")');
    
    // 9. Naviga /customers
    await page.click('nav >> text=Clienti');
    
    // 10. Apri dettaglio cliente con ordini
    await page.click('table >> text=Mario Rossi');
    
    // 11. Verifica profitto aggiornato (include shipping cost)
    await expect(page.locator('text=Profitto: €53.00')).toBeVisible();
    await expect(page.locator('text=Costi spedizione: €7.00')).toBeVisible();
  });
  
  test('alert peso mancante → configura default', async ({ page }) => {
    await page.goto('/');
    
    // 1. Verifica alert presente
    await expect(page.locator('text=12 ordini senza peso')).toBeVisible();
    
    // 2. Click link
    await page.click('text=Configura peso di default');
    await expect(page).toHaveURL('/spedizioni');
    
    // 3. Imposta default
    await page.fill('input[label="Peso default per articolo"]', '0.5');
    await page.click('button:has-text("Salva")');
    
    // 4. Torna dashboard
    await page.click('nav >> text=Dashboard');
    
    // 5. Alert non più visibile
    await expect(page.locator('text=ordini senza peso')).not.toBeVisible();
  });
});
```

### Manual Testing Checklist

Prima del merge:

- [ ] Importa zone da negozio Shopify reale (con 3+ zone configurate)
- [ ] Configura mix: 1 zona lineare, 1 zona a fasce, 1 zona senza tariffa
- [ ] Crea ordine test con tracking number → verifica `fulfillment_status = 'fulfilled'`
- [ ] Crea ordine senza peso sui prodotti → verifica fallback a `default_weight_per_item`
- [ ] Simula webhook refund → verifica `returned_at` popolato + costo rientro applicato
- [ ] Modifica tariffa esistente → verifica profitto cliente ricalcolato
- [ ] Elimina categoria packaging usata in ordini → verifica fallback peso senza errori
- [ ] Merchant senza permesso orders → verifica migrazione skip graceful
- [ ] Ordine in paese non coperto → verifica costo = 0, stat "paesi non coperti" aggiornata

---

## Deployment e Rollout

### Checklist Pre-Deploy

1. **Migrations**:
   - [ ] Eseguire SQL manuale su DB owner (tabelle `shipping_zones`, `shipping_rates`, `packaging_config`)
   - [ ] Bump `LATEST_SCHEMA_VERSION = 12` in `merchant-migrations.ts`
   - [ ] Testare migrazione su DB test merchant (verifica colonne aggiunte correttamente)

2. **Feature Flag** (opzionale):
   - [ ] Aggiungere flag `shipping_costs_enabled` in `features.ts`
   - [ ] Nascondere link navigazione `/spedizioni` se flag off
   - [ ] Calcolo costi sempre safe (ritorna 0 se feature off)

3. **Monitoring**:
   - [ ] Log errors calcolo costi → Sentry
   - [ ] Metric: `shipping_cost_calculation_duration_ms`
   - [ ] Metric: `orders_without_weight_count`

### Rollout Plan

**Fase 1 - Soft Launch** (settimana 1):
- Deploy su production
- Feature visibile solo a merchant beta tester (3-5 shop)
- Monitorare: errori calcolo, performance, feedback UX

**Fase 2 - Gradual Rollout** (settimana 2-3):
- Apertura a 25% merchant (random sample)
- Email announcement: "Nuova feature costi spedizione"
- Support team briefing + FAQ

**Fase 3 - Full Release** (settimana 4):
- 100% merchant
- Blog post + tutorial video
- In-app spotlight in dashboard

### Rollback Plan

Se problemi critici (crash calcolo profitto, performance degradation):

1. **Immediato**: Feature flag OFF → link nascosto, calcolo costi ritorna 0
2. **Entro 24h**: Hotfix deploy se bug identificato
3. **Fallback**: Revert migrazione schema (solo se DB corruption)

---

## Note Implementazione

### Priorità File da Creare/Modificare

**Alta priorità** (blocca feature):
1. `app/lib/shipping/calculate-cost.server.ts` - calcolo costi
2. `app/lib/shipping/sync-zones.server.ts` - sync zone Shopify
3. `app/routes/spedizioni.tsx` - UI principale
4. Modifiche `shopify-api.server.ts` - estensione GraphQL query
5. Modifiche `net-contribution.ts` - integrazione profitto
6. Schema DB owner - 3 tabelle nuove
7. Migrazione v12 - 5 colonne orders

**Media priorità** (migliora UX):
8. `app/components/Shipping/ShippingZonesTable.tsx`
9. `app/components/Shipping/EditZoneModal.tsx`
10. `app/components/Shipping/PackagingCard.tsx`
11. Alert dashboard peso mancante
12. Stats "paesi non coperti"

**Bassa priorità** (nice-to-have):
13. Storico modifiche tariffe (audit log)
14. Export CSV configurazione
15. Simulatore costi pre-save

### Performance Considerations

- **Cache config**: LRU in-memory, 100 shop max, TTL 5min
- **Batch calcolo**: `calculateShippingCost` chiamata una volta per ordine in loop `calculateNetContribution` → no N+1
- **Index DB**: già presenti su `shop_id` (shipping_zones), `zone_id` (shipping_rates)
- **GraphQL**: `totalWeight` field già calcolato da Shopify → no calcolo lato client

### Dependencies

**Nuove**:
- Nessuna (usa solo stack esistente: Remix, Prisma, Shopify API)

**Modifiche a schema Prisma**:
```prisma
model ShippingZone {
  id        String   @id @default(uuid())
  shopId    String   @map("shop_id")
  zoneName  String   @map("zone_name")
  countries String[]
  rateType  String   @map("rate_type")
  syncedAt  DateTime @default(now()) @map("synced_at")
  
  rates ShippingRate[]
  
  @@unique([shopId, zoneName], map: "shipping_zones_shop_id_zone_name_key")
  @@index([shopId], map: "idx_shipping_zones_shop")
  @@map("shipping_zones")
}

model ShippingRate {
  id         String   @id @default(uuid())
  zoneId     String   @map("zone_id")
  weightFrom Decimal? @map("weight_from") @db.Decimal(10, 3)
  weightTo   Decimal? @map("weight_to") @db.Decimal(10, 3)
  costPerKg  Decimal  @map("cost_per_kg") @db.Decimal(10, 2)
  createdAt  DateTime @default(now()) @map("created_at")
  
  zone ShippingZone @relation(fields: [zoneId], references: [id], onDelete: Cascade)
  
  @@index([zoneId], map: "idx_shipping_rates_zone")
  @@map("shipping_rates")
}

model PackagingConfig {
  shopId              String   @id @map("shop_id")
  categories          Json
  fallbackRules       Json     @map("fallback_rules")
  defaultWeightPerItem Decimal? @map("default_weight_per_item") @db.Decimal(10, 3)
  returnCost          Decimal? @map("return_cost") @db.Decimal(10, 2)
  updatedAt           DateTime @default(now()) @map("updated_at")
  
  @@map("packaging_config")
}
```

---

## Relazione con LTP Predittivo

Questa feature è **input necessario** per il modello predittivo Lifetime Profit (LTP):

- **LTP attuale**: usa solo `revenue - product_cost` (parziale)
- **LTP futuro**: userà `revenue - product_cost - shipping_cost` (completo)

Il modello BG/NBD + Gamma-Gamma richiede **profitto reale per transazione**. Senza costi spedizione, sovrastima il LTP di merchant con alta incidenza logistica (es. prodotti pesanti, spedizioni internazionali).

**Timeline**:
1. ✅ Questa spec: costi spedizione (prerequisito)
2. ⏳ Prossima: modello LTP predittivo (usa shipping_cost come input)

---

## Appendice: Glossario

- **Zona**: raggruppamento paesi per tariffe spedizione (es. "UE" = Francia + Germania + Belgio)
- **Tariffa lineare**: costo proporzionale al peso (€/kg)
- **Tariffa a fasce**: costo fisso per intervallo peso (0-1kg = €5, 1-5kg = €8, etc.)
- **Packaging category**: tipo imballo (Busta, Scatola S, Scatola L, etc.)
- **Fallback rules**: regole automatiche peso → packaging quando Shopify non fornisce categoria
- **Peso default**: valore usato quando prodotto non ha peso configurato
- **Costo rientro**: forfait applicato quando ordine viene restituito
- **Net contribution**: profitto = revenue - product_cost - shipping_cost

---

**Fine Specifica**
