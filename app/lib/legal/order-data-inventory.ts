// app/lib/legal/order-data-inventory.ts
//
// L'inventario dei dati degli ordini: cosa l'app legge da Shopify, dove lo
// scrive, e cosa ne fa una richiesta di cancellazione.
//
// PERCHE' ESISTE. L'informativa, il DPA e la dichiarazione dei dati cliente
// protetti dicevano che l'app non tratta dati di spedizione, mentre il codice
// leggeva paese, spedizioni, tracking e resi e ne scriveva i fatti sull'ordine.
// Nessuno aveva mentito: il codice era cresciuto e i documenti no. Questo file
// e' il punto in cui le due cose si incontrano, e `order-data-inventory.test.ts`
// le tiene insieme:
//
//  - ogni campo che le query degli ordini chiedono a Shopify deve comparire qui
//    (e niente qui deve mancare dalle query);
//  - ogni colonna della tabella `orders` del merchant deve comparire qui (e
//    viceversa);
//  - le colonne che la cancellazione azzera devono essere esattamente quelle
//    che qui dicono `azzerato`;
//  - ogni voce logistica deve comparire, con la sua etichetta, nei documenti
//    legali — informativa (IT, EN, HTML), DPA (IT, EN) e dichiarazione PCD.
//
// Se il test fallisce dopo una modifica al codice, la correzione non e' il test:
// e' dichiarare il campo nuovo qui E nei documenti, alzando la versione
// dell'informativa.

/** Cosa succede a una voce quando un cliente chiede la cancellazione. */
export type AllaCancellazione =
  /** La colonna viene svuotata sugli ordini della persona. */
  | 'azzerato'
  /**
   * Resta sull'ordine, che dopo l'azzeramento non riporta piu' a nessuno: e'
   * un fatto della vendita o del pacco, non della persona.
   */
  | 'resta'
  /** Non viene mai scritto: non c'e' niente da cancellare. */
  | 'non_conservato';

/**
 * Il tipo di dato protetto secondo Shopify.
 *
 * `livello1` e' il dato cliente protetto in generale (tutto cio' che sta su un
 * ordine lo e'); `nome` e `indirizzo` sono i campi di livello 2 che vanno
 * chiesti uno per uno nella Partner Dashboard. `null` = metadati tecnici
 * (paginazione, chiavi interne).
 */
export type TipoPcd = 'livello1' | 'nome' | 'indirizzo' | null;

export interface VoceDatiOrdine {
  id: string;
  /** L'etichetta con cui la voce compare nei documenti, parola per parola. */
  etichetta: { it: string; en: string };
  /**
   * I campi GraphQL, come percorsi a partire dall'ordine
   * (`shippingAddress.countryCodeV2`, `returns.nodes.status`).
   */
  graphql: readonly string[];
  /** Le colonne della tabella `orders` nel database del merchant. Vuoto = non conservato li'. */
  colonne: readonly string[];
  pcd: TipoPcd;
  allaCancellazione: AllaCancellazione;
  /** Una voce dei dati di spedizione e logistica (DEC-03). */
  logistica: boolean;
}

export const INVENTARIO_ORDINI: readonly VoceDatiOrdine[] = [
  // --- L'ordine in se' -------------------------------------------------------
  {
    id: 'identificativo_ordine',
    etichetta: { it: 'Identificativo e numero d\'ordine', en: 'Order ID and number' },
    graphql: ['id', 'name'],
    colonne: ['shopify_order_id', 'order_number'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: false,
  },
  {
    id: 'date_ordine',
    etichetta: { it: 'Date dell\'ordine', en: 'Order dates' },
    graphql: ['createdAt', 'updatedAt', 'cancelledAt'],
    colonne: ['placed_at', 'updated_at', 'cancelled_at'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: false,
  },
  {
    id: 'importi',
    etichetta: { it: 'Totale, valuta e stato del pagamento', en: 'Total, currency and financial status' },
    graphql: [
      'displayFinancialStatus',
      'currentTotalPriceSet.shopMoney.amount',
      'currentTotalPriceSet.shopMoney.currencyCode',
    ],
    colonne: ['financial_status', 'total_price', 'currency'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: false,
  },
  {
    id: 'cliente_identificativo',
    etichetta: { it: 'Identificativo del cliente', en: 'Customer ID' },
    graphql: ['customer.id'],
    colonne: ['shopify_customer_id'],
    pcd: 'livello1',
    allaCancellazione: 'azzerato',
    logistica: false,
  },
  {
    id: 'cliente_nome',
    etichetta: { it: 'Nome e cognome del cliente', en: 'Customer first and last name' },
    graphql: ['customer.firstName', 'customer.lastName'],
    colonne: ['customer_first_name', 'customer_last_name'],
    pcd: 'nome',
    allaCancellazione: 'azzerato',
    logistica: false,
  },
  {
    // Le righe finiscono in `order_lines`, non in `orders`: pendono dall'ordine
    // e non hanno riferimenti alla persona.
    id: 'righe',
    etichetta: { it: 'Righe dell\'ordine', en: 'Order lines' },
    graphql: [
      'lineItems.nodes.id',
      'lineItems.nodes.title',
      'lineItems.nodes.quantity',
      'lineItems.nodes.currentQuantity',
      'lineItems.nodes.product.id',
      'lineItems.nodes.variant.id',
      'lineItems.nodes.priceAfterAllDiscountsBeforeTaxesSet.shopMoney.amount',
      'lineItems.nodes.priceAfterAllDiscountsBeforeTaxesSet.shopMoney.currencyCode',
      'lineItems.nodes.discountedUnitPriceSet.shopMoney.amount',
      'lineItems.nodes.originalUnitPriceSet.shopMoney.amount',
      'lineItems.nodes.totalDiscountSet.shopMoney.amount',
    ],
    colonne: [],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: false,
  },
  {
    id: 'tecnico',
    etichetta: { it: 'Metadati tecnici', en: 'Technical metadata' },
    graphql: [
      'lineItems.pageInfo.hasNextPage',
      'lineItems.pageInfo.endCursor',
      'returns.pageInfo.hasNextPage',
      'returns.pageInfo.endCursor',
    ],
    colonne: ['id', 'synced_at'],
    pcd: null,
    allaCancellazione: 'resta',
    logistica: false,
  },

  // --- Spedizione e logistica (DEC-03) --------------------------------------
  {
    id: 'paese_spedizione',
    etichetta: { it: 'Paese di spedizione', en: 'Shipping country' },
    graphql: ['shippingAddress.countryCodeV2'],
    colonne: ['shipping_country_code'],
    pcd: 'indirizzo',
    allaCancellazione: 'azzerato',
    logistica: true,
  },
  {
    id: 'da_spedire',
    etichetta: { it: 'Se l\'ordine va spedito', en: 'Whether the order needs shipping' },
    graphql: ['requiresShipping'],
    colonne: [],
    pcd: 'livello1',
    allaCancellazione: 'non_conservato',
    logistica: true,
  },
  {
    id: 'stato_evasione',
    etichetta: { it: 'Stato di evasione', en: 'Fulfilment status' },
    graphql: ['displayFulfillmentStatus', 'fulfillments.status'],
    colonne: ['fulfillment_status'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: true,
  },
  {
    id: 'tracking',
    etichetta: { it: 'Codici di tracciamento', en: 'Tracking numbers' },
    graphql: ['fulfillments.trackingInfo.number'],
    colonne: [],
    pcd: 'livello1',
    allaCancellazione: 'non_conservato',
    logistica: true,
  },
  {
    id: 'colli',
    etichetta: { it: 'Numero di colli', en: 'Parcel count' },
    graphql: ['fulfillments.status', 'fulfillments.trackingInfo.number'],
    colonne: ['package_count'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: true,
  },
  {
    id: 'opzione_spedizione',
    etichetta: { it: 'Opzione di spedizione', en: 'Shipping method' },
    graphql: ['shippingLines.nodes.title'],
    colonne: ['shipping_method'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: true,
  },
  {
    id: 'categoria_consegna',
    etichetta: { it: 'Categoria di consegna', en: 'Delivery category' },
    graphql: ['shippingLines.nodes.deliveryCategory'],
    colonne: [],
    pcd: 'livello1',
    allaCancellazione: 'non_conservato',
    logistica: true,
  },
  {
    id: 'peso',
    etichetta: { it: 'Peso totale', en: 'Total weight' },
    graphql: ['totalWeight'],
    colonne: ['total_weight_grams'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: true,
  },
  {
    id: 'articoli',
    etichetta: { it: 'Numero di articoli', en: 'Item count' },
    graphql: ['lineItems.nodes.quantity', 'lineItems.nodes.currentQuantity'],
    colonne: ['item_count'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: true,
  },
  {
    id: 'resi',
    etichetta: { it: 'Resi', en: 'Returns' },
    graphql: ['returns.nodes.status', 'returns.nodes.createdAt'],
    colonne: ['returned_at'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: true,
  },
  {
    id: 'imballo',
    etichetta: { it: 'Categoria di imballo', en: 'Packaging category' },
    graphql: ['metafield.value'],
    colonne: ['packaging_category'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: true,
  },
  {
    // Calcolato dall'app, non letto: nessun campo GraphQL suo.
    id: 'costo_logistico',
    etichetta: { it: 'Costo logistico', en: 'Logistics cost' },
    graphql: [],
    colonne: ['logistics_cost', 'logistics_facts_version'],
    pcd: 'livello1',
    allaCancellazione: 'resta',
    logistica: true,
  },
];

/** Le voci di spedizione e logistica, quelle che i documenti devono elencare una per una. */
export const VOCI_LOGISTICHE: readonly VoceDatiOrdine[] = INVENTARIO_ORDINI.filter((v) => v.logistica);

/** Tutte le colonne di `orders` che l'inventario dichiara. */
export function colonneDichiarate(): string[] {
  return [...new Set(INVENTARIO_ORDINI.flatMap((v) => v.colonne))];
}

/** Tutti i campi GraphQL che l'inventario dichiara. */
export function campiGraphqlDichiarati(): string[] {
  return [...new Set(INVENTARIO_ORDINI.flatMap((v) => v.graphql))];
}

/** Le colonne che una cancellazione deve svuotare sugli ordini della persona. */
export function colonneAzzerateAllaCancellazione(): string[] {
  return INVENTARIO_ORDINI.filter((v) => v.allaCancellazione === 'azzerato').flatMap((v) => v.colonne);
}
