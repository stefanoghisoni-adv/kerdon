import type { ShopifyProduct } from '~/types/shopify';
import { collectProblemVariants, type ProblemVariant } from './product-readiness';

/**
 * "Prodotti inclusi in ordini, senza costo": una domanda sola, una risposta
 * sola.
 *
 * Prima erano due strade separate e davano numeri diversi. L'avviso in
 * dashboard chiedeva al database del merchant quali varianti vendute NON
 * avessero una riga in `products`; l'elenco chiedeva a Shopify quali varianti
 * non avessero il cost_per_item. Sembrano la stessa domanda e non lo sono:
 * `products` contiene solo le righe idonee — e per giunta tagliate al tetto del
 * piano — quindi "non c'e' la riga" vuol dire tante cose che non sono "manca il
 * costo": prodotto oltre il tetto, prodotto creato dopo l'ultima corsa,
 * prodotto cancellato da Shopify mesi fa. Tutti finivano nell'avviso, e nessuno
 * di loro poteva comparire nell'elenco.
 *
 * Da qui in poi il costo lo dice Shopify — che ne e' la fonte — sia all'avviso
 * sia all'elenco, e il database del merchant risponde alla sola domanda a cui
 * puo' rispondere: che cosa e' stato venduto.
 */

/**
 * Le varianti vendute, secondo la definizione che l'avviso annuncia al
 * merchant: righe d'ordine di ordini non annullati.
 *
 * Un ordine rimborsato resta una vendita — e' la stessa regola di `countsAsSale`
 * e delle interrogazioni della tab Clienti: il rimborso azzera l'incasso, non il
 * fatto che quel prodotto sia uscito. Annullato invece non e' mai stato una
 * vendita.
 *
 * L'SQL sta qui, in un posto solo, perche' e' esattamente cio' che le due
 * strade devono avere in comune: se un giorno la definizione cambia, cambia per
 * entrambe o per nessuna.
 */
export function soldVariantsSQL(customerId: number | null): string {
  // L'id arriva dalla URL e finisce interpolato nella query: si accetta solo un
  // intero positivo, qualunque altra cosa vale come "nessun cliente".
  const forCustomer =
    customerId != null && Number.isSafeInteger(customerId) && customerId > 0;

  // Il nome del cliente si legge solo quando si sta restringendo a lui: altrove
  // sono due colonne costanti che servono solo a tenere la stessa forma di riga.
  const names = forCustomer
    ? `MAX(o.customer_first_name) AS first_name,
                MAX(o.customer_last_name)  AS last_name`
    : `NULL AS first_name, NULL AS last_name`;

  return `SELECT DISTINCT l.shopify_variant_id,
                ${names}
         FROM order_lines l
         JOIN orders o ON o.shopify_order_id = l.shopify_order_id
         WHERE l.shopify_variant_id IS NOT NULL
           AND o.cancelled_at IS NULL${
             forCustomer ? `\n           AND o.shopify_customer_id = ${customerId}` : ''
           }${forCustomer ? `\n         GROUP BY l.shopify_variant_id` : ''}`;
}

/**
 * L'elenco: fra le varianti senza costo, quelle gia' vendute.
 *
 * `soldIds` a null significa "non lo so" — database non collegato o lettura non
 * riuscita — e allora la pagina mostra tutto, perche' nascondere righe che non
 * si e' potuto verificare farebbe credere che non ci sia niente da sistemare.
 */
export function selectSoldProblemVariants(
  rows: ProblemVariant[],
  soldIds: Set<number> | null,
): ProblemVariant[] {
  if (!soldIds) return rows;
  return rows.filter((row) => soldIds.has(row.variantId));
}

/**
 * L'avviso: quante sono quelle righe. Non "quante potrebbero essere" — e'
 * letteralmente la lunghezza dell'elenco che il merchant trovera' premendo
 * "Risolvi problemi", perche' la calcola la stessa funzione.
 *
 * Qui pero' `soldIds` a null vale zero e non "tutte": l'avviso parla di prodotti
 * VENDUTI, e se non si e' potuto sapere che cosa sia stato venduto non c'e'
 * niente da annunciare. Dire un numero comprendendo anche i prodotti che nessuno
 * ha mai comprato sarebbe un allarme piu' grosso del problema.
 */
export function countSoldProblemVariants(
  rows: ProblemVariant[],
  soldIds: Set<number> | null,
): number {
  if (!soldIds) return 0;
  return selectSoldProblemVariants(rows, soldIds).length;
}

/**
 * Comodita' per chi ha il catalogo intero in mano invece delle sole righe con
 * problemi: la stessa catena, in un passaggio solo.
 */
export function countSoldWithoutCostInCatalog(
  products: ShopifyProduct[],
  soldIds: Set<number> | null,
): number {
  return countSoldProblemVariants(collectProblemVariants(products), soldIds);
}

/**
 * Le varianti vendute che nel catalogo non si trovano piu'.
 *
 * Sono la sola ragione per cui l'avviso e l'elenco possono ancora non
 * coincidere, adesso che li calcola la stessa funzione: se una riga d'ordine
 * punta a una variante che Shopify non restituisce piu', quella vendita esiste
 * ma non c'e' niente da mostrare ne' da correggere.
 *
 * Non vuol dire "prodotto cancellato". Il caso piu' comune e' l'opposto: il
 * prodotto c'e' ancora, ma e' stato modificato. Cambiando le opzioni di un
 * prodotto Shopify non rinomina le varianti — le rifa', con id nuovi — e gli
 * ordini vecchi continuano a puntare a quelli di prima, che non esistono piu'.
 *
 * Si contano per poterlo dire al merchant invece di lasciargli un numero che
 * non torna: e' una differenza che non puo' chiudere, e non saperlo e' peggio.
 */
export function soldVariantsMissingFromCatalog(
  products: ShopifyProduct[],
  soldIds: Set<number> | null,
): number {
  if (!soldIds) return 0;

  const inCatalog = new Set<number>();
  for (const product of products) {
    for (const variant of product.variants) {
      if (variant.id != null) inCatalog.add(variant.id);
    }
  }

  let missing = 0;
  for (const id of soldIds) if (!inCatalog.has(id)) missing++;
  return missing;
}
