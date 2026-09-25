# Spedizioni per opzione — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Il costo di spedizione si calcola sull'opzione di spedizione scelta dal cliente (Standard, Express, ...), importata da Shopify con la sua struttura (fisso, peso, importo, corriere); la tariffa di zona resta come ripiego.

**Architecture:** Due tabelle owner nuove (`shipping_options`, `shipping_option_rates`) sotto `shipping_zones`. L'import legge le method definitions dei delivery profiles e raggruppa per nome. L'ordine salva `shipping_method` (schema merchant v13). La funzione pura `computeLogisticsCost` sceglie opzione → ripiego zona. Ricalcolo, scrittura ordini e UI si adeguano.

**Tech Stack:** Remix 2, Polaris, Prisma (owner), Supabase merchant via helper esistenti, Shopify Admin GraphQL, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-shipping-costs-design.md` — **Revisione 1.2** (in testa) vincolante, poi 1.1.

## Global Constraints

- Polaris only, nessuno `style` inline, tema chiaro.
- Testi solo in `app/lib/i18n/it.ts` + `en.ts` (stesse chiavi), `useT()`; copy solo benefici per il merchant, niente dettagli interni.
- Commenti in italiano, spiegano il perché.
- Ogni tabella owner nuova: RLS; `prisma/owner-bootstrap.sql` e `prisma/migrations/0_init/migration.sql` restano byte-identici e allineati allo schema (test `prisma/owner-bootstrap.test.ts`, `prisma/migrations.test.ts`).
- `shopId` = `shops.id` owner.
- Costi importati da Shopify partono a 0 (sono prezzi al cliente, non costi).
- Ogni salvataggio e re-import chiama `enqueueLogisticsRecompute(shopId)` solo dopo il successo.
- Scrittura ordini e ricalcolo devono dare lo stesso `logistics_cost` per lo stesso ordine (stessa funzione, stessi input).
- Commit con righe finali:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01MigH8uz8xyMEYxEymL3mjq`
- Comandi: `npx vitest run <path>`, `npx tsc --noEmit`, suite completa `npx vitest run` (baseline 3121/3121), `npm run test:e2e -- spedizioni.spec.ts` (baseline 21).

## Modelli per task

| Task | Contenuto | Modello |
|---|---|---|
| 1 | Tabelle owner + tipi | sonnet |
| 2 | Calcolo per opzione (puro) | sonnet |
| 3 | Import opzioni da Shopify | opus |
| 4 | Ordini: `shipping_method` v13, scrittura e ricalcolo | opus |
| 5 | UI: zone → opzioni, modale costi per tipo | sonnet |
| 6 | E2E azioni | sonnet |
| 7 | Pagina a tutta larghezza, tabella categorie di imballo (importate o create) | opus |
| 8 | Layout: due card in alto, prezzi a metà sotto con la card dei default accanto | sonnet |
| 9 | Ricalcolo immediato al salvataggio + recupero dell'opzione sugli ordini storici | opus |

---

### Task 1: Tabelle owner e tipi

**Files:** Modify `prisma/schema.prisma`, `prisma/owner-bootstrap.sql`, `prisma/migrations/0_init/migration.sql`, `app/lib/shipping/types.ts`, `app/lib/shipping/load-config.server.ts` (+ test); Create `prisma/migrations/20260924100000_shipping_options/migration.sql`.

**Produces:**

```prisma
model ShippingOption {
  id          String               @id @default(uuid())
  zoneId      String               @map("zone_id")
  name        String
  costType    String               @default("flat") @map("cost_type")
  shopifyKind String?              @map("shopify_kind")
  createdAt   DateTime             @default(now()) @map("created_at")
  zone        ShippingZone         @relation(fields: [zoneId], references: [id], onDelete: Cascade)
  rates       ShippingOptionRate[]

  @@unique([zoneId, name])
  @@index([zoneId])
  @@map("shipping_options")
}

model ShippingOptionRate {
  id       String         @id @default(uuid())
  optionId String         @map("option_id")
  rangeFrom Decimal?      @map("range_from") @db.Decimal(12, 3)
  rangeTo   Decimal?      @map("range_to") @db.Decimal(12, 3)
  cost     Decimal        @db.Decimal(10, 2)
  option   ShippingOption @relation(fields: [optionId], references: [id], onDelete: Cascade)

  @@index([optionId])
  @@map("shipping_option_rates")
}
```
(+ `options ShippingOption[]` su `ShippingZone`.) `rangeFrom/rangeTo` sono kg per `weight_brackets`, EUR per `value_brackets`, null per `flat`/`linear` (una sola riga, `cost` = EUR o EUR/kg).

```ts
// aggiunte a app/lib/shipping/types.ts
export type OptionCostType = 'flat' | 'linear' | 'weight_brackets' | 'value_brackets';
export interface OptionBracket { from: number | null; to: number | null; cost: number }
export interface ShippingOptionConfig { name: string; costType: OptionCostType; brackets: OptionBracket[] }
// ZoneConfig: + options: ShippingOptionConfig[]
// OrderLogisticsInput: + shipping_method: string | null; + total_price: number | null
```

- [ ] Modelli Prisma + migrazione idempotente con RLS (stile `20260923120000_shipping_costs`) + stesse tabelle in bootstrap e 0_init (byte-identici).
- [ ] Tipi; `loadLogisticsConfig` carica anche le opzioni di ogni zona (Decimal → number, `costType` sconosciuto → scartato con warning) e la variante stretta usata dal ricalcolo fa lo stesso. Test.
- [ ] Aggiorna le fixture/i test che costruiscono `ZoneConfig` o `OrderLogisticsInput` (aggiungi `options: []`, `shipping_method: null`, `total_price: null`) senza cambiarne il significato.
- [ ] `npx prisma generate`, `npx vitest run prisma app/lib/shipping`, tsc, suite completa. Commit `feat(spedizioni): opzioni di spedizione nelle tabelle di configurazione`.

---

### Task 2: Calcolo per opzione

**Files:** Modify `app/lib/shipping/logistics-cost.ts`, `app/lib/shipping/logistics-cost.test.ts`.

**Produces:** `findOption(zone: ZoneConfig, method: string | null): ShippingOptionConfig | null`; `computeLogisticsCost` invariato nella firma.

- [ ] **Test prima** (aggiungi alla suite esistente; fixture zona IT con `options`):

```ts
const zonaConOpzioni = {
  zoneName: 'Italia', countries: ['IT'], restOfWorld: false, rateType: 'linear' as const,
  rates: [{ weightFromKg: null, weightToKg: null, cost: 2 }],
  options: [
    { name: 'Standard', costType: 'flat' as const, brackets: [{ from: null, to: null, cost: 4.9 }] },
    { name: 'Express', costType: 'weight_brackets' as const, brackets: [
      { from: 0, to: 2, cost: 9 }, { from: 2, to: null, cost: 14 } ] },
    { name: 'Gratis sopra 50', costType: 'value_brackets' as const, brackets: [
      { from: 0, to: 50, cost: 6 }, { from: 50, to: null, cost: 6.5 } ] },
    { name: 'Corriere', costType: 'linear' as const, brackets: [{ from: null, to: null, cost: 1.5 }] },
  ],
};
// casi:
// 'Standard' → shipping 4.9 anche con peso null
// ' express ' (spazi/maiuscole) 3 kg → 14
// 'Gratis sopra 50' con total_price 80 → 6.5; con total_price null → 0
// 'Corriere' 2 kg → 3
// 'Sconosciuta' → ripiego sulla tariffa di zona: 3 kg × 2 = 6
// shipping_method null → ripiego sulla zona
// opzione weight_brackets senza peso → 0 (non NaN)
// ordine non spedito con opzione → 0
// paese null con opzione → 0 (regola 1.1: niente indirizzo, niente spedizione)
```

- [ ] Implementazione: dopo `findZone`, `findOption(zone, order.shipping_method)`; se c'è, il costo viene dall'opzione (flat: `cost`; linear: `cost × kg` se peso noto, altrimenti 0; weight_brackets: fascia `[from, to)` sul peso; value_brackets: fascia `[from, to)` su `total_price`); altrimenti il calcolo di zona attuale. Packaging e resi invariati. Arrotondamento al centesimo come oggi.
- [ ] `npx vitest run app/lib/shipping`, tsc. Commit `feat(spedizioni): il costo segue l'opzione scelta dal cliente`.

---

### Task 3: Import delle opzioni da Shopify

**Files:** Modify `app/lib/shipping/sync-zones.server.ts` (+ test).

Requisiti:
1. La query delle zone chiede anche le method definitions di ogni zona: nome, attiva, rate provider (tariffa fissa con prezzo, oppure partecipante/corriere) e condizioni (campo peso totale o prezzo totale, operatore, valore con unità). **Verifica i nomi esatti dei campi sulla versione Admin API del progetto** (strumenti shopify-dev se disponibili) e annota le deviazioni.
2. Raggruppa per (zona, nome): tipo proposto = `value_brackets` se ha condizioni sul prezzo, `weight_brackets` se sul peso (converti in kg), `linear` se corriere/calcolata, altrimenti `flat`. Fasce con le soglie delle condizioni (min/max → from/to), costi a 0; `shopifyKind` salva il tipo Shopify originale.
3. Upsert su `(zoneId, name)`: opzione nuova → creata con tipo e fasce proposte; opzione esistente → **non toccare** tipo e fasce (li ha scritti il merchant). Opzioni sparite restano. Metodi disattivati si importano comunque (possono esserci ordini storici).
4. Risultato del sync esteso con il numero di opzioni aggiunte; resta compatibile col chiamante in `app/routes/spedizioni.tsx`.
5. Test con risposte finte: forfettaria, peso con due fasce stesso nome, importo, corriere, re-import che non sovrascrive i costi.

- [ ] TDD → tsc → suite completa → commit `feat(spedizioni): importa le opzioni di spedizione di ogni zona`.

---

### Task 4: Ordini — `shipping_method`, scrittura e ricalcolo

**Files:** `app/lib/supabase-schema.ts` (`ORDERS_COLUMNS` + `shipping_method TEXT`), `app/lib/supabase/merchant-migrations.ts` (`LATEST_SCHEMA_VERSION` 12 → 13), `app/lib/shopify-api.server.ts` (`orderNodeFields`: `shippingLines(first: 1) { nodes { title } }` — verifica la forma sulla versione API), mapping verso `ShopifyOrder`, `app/lib/customers/order-rows.ts`, `app/lib/shipping/recompute.server.ts` (+ test).

Requisiti:
1. `shipping_method` = `title` della prima shipping line, null se assente.
2. Scrittura ordine e ricalcolo passano a `computeLogisticsCost` anche `shipping_method` e `total_price` (numero). La SELECT del ricalcolo legge le due colonne.
3. Stesso ordine → stesso `logistics_cost` sui due percorsi: aggiungi un test che lo verifica sullo stesso input.
4. Schema v13 non ancora applicato: il ricalcolo tratta la colonna mancante come fa oggi con le tabelle assenti (nessun errore rumoroso).

- [ ] TDD → `npx vitest run app/lib/customers app/lib/shipping app/lib/workers app/lib/webhooks` → tsc → suite completa → commit `feat(spedizioni): l'ordine ricorda l'opzione di spedizione scelta`.

---

### Task 5: UI — zone e opzioni

**Files:** `app/routes/spedizioni.tsx`, `app/components/Shipping/*`, i18n IT/EN.

Requisiti:
1. Loader: zone con opzioni e fasce. La tabella mostra per ogni zona le sue opzioni (nome, tipo di costo, costo indicativo), più la riga "Tariffa generica della zona" per il ripiego esistente. Stato vuoto invariato.
2. Modale opzione: tipo di costo (Fisso per spedizione / Al kg / Fasce di peso / Fasce di valore dell'ordine), campi coerenti, editor fasce riusato con etichette kg o EUR secondo il tipo. Validazione lato server con le stesse regole di `validateBrackets` (fasce contigue da 0, solo l'ultima illimitata, costi ≥ 0, JSON malformato → errore tipizzato). Ownership: l'opzione deve appartenere a una zona del negozio.
3. Intent `save-option-cost`: transazione Prisma (tipo + fasce), poi `enqueueLogisticsRecompute`. Esito tramite `feedbackFromActionData` come gli altri intent; la modale si chiude solo al successo.
4. Testo d'aiuto nella modale: le fasce arrivano da Shopify, i costi vanno inseriti perché Shopify conosce il prezzo al cliente, non quanto spendi tu.
5. Test unitari delle parti pure (validazione, formattazione costo indicativo, feedback).

- [ ] TDD sulle parti pure → implementazione → tsc → suite completa → commit `feat(spedizioni): costi per opzione nella pagina Spedizioni`.

---

### Task 6: E2E

**Files:** `e2e/tests/spedizioni.spec.ts`, `e2e/server/main.ts` se serve.

Scenari reali sulle azioni (niente skip): `save-option-cost` flat valido; fasce di valore contigue valide; fasce non contigue rifiutate; opzione di un altro negozio rifiutata; JSON malformato → errore tipizzato. I 21 esistenti restano verdi.

- [ ] Scrivi → `npm run test:e2e -- spedizioni.spec.ts` verde → suite completa → commit `test(spedizioni): scenari end-to-end dei costi per opzione`.

---

### Task 7: Pagina a tutta larghezza e tabella delle categorie di imballo

**Files:** `app/routes/spedizioni.tsx`, `app/components/Shipping/*` (PackagingCard si divide), eventuale `app/lib/shipping/sync-packages.server.ts` (+ test), i18n IT/EN.

Requisiti (richiesta dell'utente del 2026-09-24):
1. La pagina Spedizioni usa tutta la larghezza, come la dashboard (stessa impostazione di `Page` usata da `app/routes/_index.tsx`), non la larghezza stretta dei cataloghi.
2. Le categorie di imballo diventano una **tabella a se'** sotto le zone: righe in sola lettura (nome, costo, origine: "Da Shopify" / "Creata da te"), azioni Modifica ed Elimina che aprono una modale; pulsante "Aggiungi categoria". Una categoria salvata non deve piu' sembrare un campo appena aggiunto.
3. Le regole per peso diventano anch'esse una tabella con Modifica/Elimina/Aggiungi; peso di default per articolo e costo dei resi restano campi in una card con il loro Salva.
4. **Importate:** verifica sulla versione Admin API del progetto se i pacchi configurati dal merchant in Shopify (Impostazioni → Spedizione → Pacchi) sono leggibili via GraphQL. Se si', "Importa da Shopify" li porta come categorie (nome e dimensioni/peso a titolo informativo, costo 0 da compilare), senza sovrascrivere le categorie esistenti con lo stesso nome; serve un campo origine sulle categorie (nel JSON di `PackagingConfig.categories`, con valore di default "creata" per le esistenti, letto in modo difensivo da `load-config.server.ts`). Se non sono leggibili, niente import: solo categorie create, e lo dici nel report.
5. Eliminare una categoria usata da una regola resta bloccato con messaggio (comportamento attuale). Ogni salvataggio accoda il ricalcolo. Toast solo con `shopify.toast` (App Bridge), mai il `Toast` di Polaris.
6. Test unitari delle parti pure; E2E delle nuove azioni (aggiungi, modifica, elimina categoria; import se presente).

- [ ] TDD sulle parti pure → implementazione → tsc → suite completa → e2e spedizioni → commit `feat(spedizioni): pagina a tutta larghezza e tabella delle categorie di imballo`.

---

### Task 8: Layout della pagina (richiesta utente del 2026-09-25)

**Files:** `app/routes/spedizioni.tsx`, componenti in `app/components/Shipping/`.

Disposizione scelta dall'utente (opzione A):
```
┌──────────────────────┬──────────────────────┐
│ Categorie di imballo │ Regole per peso      │
└──────────────────────┴──────────────────────┘
┌──────────────────────┬──────────────────────┐
│ Prezzi di spedizione │ Peso di default      │
│ (zone e opzioni)     │ e costo dei resi     │
│                      └──────────────────────┘
│                      │
└──────────────────────┘
```
- Pagina a tutta larghezza (resta). Riga 1: `InlineGrid columns={{ xs: 1, md: 2 }}` con le due card; riga 2: stessa griglia, a sinistra la tabella zone/opzioni, a destra la card dei default allineata in alto (non stirata all'altezza della tabella).
- Su mobile tutto in colonna, nell'ordine: prezzi, categorie, regole, default.
- Solo layout: nessuna logica cambia. Polaris only, niente `style`. Verifica con tsc, suite completa ed e2e spedizioni.
- Commit `feat(spedizioni): impaginazione a due colonne della pagina Spedizioni`.

---

### Task 9: Ricalcolo immediato e opzione sugli ordini storici (richiesta utente del 2026-09-25)

**Files:** `app/lib/shipping/recompute.server.ts`, `app/lib/shipping/recompute-enqueue.server.ts`, `app/routes/spedizioni.tsx`, `app/lib/shopify-api.server.ts` (query leggera), coda/worker esistenti, test.

Requisiti:
1. **Ricalcolo nel salvataggio.** Ogni intent che cambia la configurazione (tariffe di zona, costo opzione, categorie, regole, default, import zone) esegue il ricalcolo dentro la richiesta, con un budget di tempo (es. 15 s) riusando la stessa funzione del job a pagine. Se finisce: risposta di successo e i numeri di Dashboard e Clienti sono già aggiornati al caricamento successivo. Se il budget scade: si accoda la continuazione dal cursore (meccanismo gia' esistente) e il toast dice che l'aggiornamento dei numeri si completa a breve. Un errore del ricalcolo non fa fallire il salvataggio (la configurazione e' salva): si ripiega sull'accodamento.
2. **Opzione sugli ordini storici.** Gli ordini salvati prima dello schema v13 hanno `shipping_method` NULL, quindi le opzioni non li raggiungono. Aggiungi un job di coda "recupero opzione" che: legge dal DB merchant gli ordini con `shipping_method IS NULL` a pagine; chiede a Shopify solo `shippingLines(first:1){nodes{title}}` per quegli id (query `nodes(ids:[...])`, a lotti rispettando il limite di costo); scrive `shipping_method`; alla fine accoda il ricalcolo. Si accoda: al primo import delle zone e quando lo schema merchant passa a v13. Idempotente, dedup per negozio, niente riscritture di ordini già valorizzati. Ordini senza shipping line → valore sentinella che eviti di ricontrollarli per sempre (es. stringa vuota), trattato come "nessuna opzione".
3. Dopo un salvataggio, il loader della dashboard non deve servire numeri vecchi dalla cache: se esiste una cache dei numeri (vedi `app/routes/_index.tsx` ~268, ~877), invalidala per il negozio al termine del ricalcolo.
4. Test: salvataggio che ricalcola dentro il budget (nessun job accodato); budget superato → continuazione accodata; errore del ricalcolo → salvataggio riuscito e job accodato; recupero opzione a lotti, ordini gia' valorizzati intatti, sentinella per ordini senza shipping line; invalidazione cache.
- Commit `feat(spedizioni): i numeri si aggiornano appena salvi un prezzo`.

## Dopo l'esecuzione (utente)

1. Migrazione owner `20260924100000_shipping_options` su Live e Test.
2. Merge → deploy; aprire l'app (schema merchant v13 automatico); "Importa zone" per portare le opzioni; inserire i costi.
