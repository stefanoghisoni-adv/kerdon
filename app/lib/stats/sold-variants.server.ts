import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQueryRows } from '~/lib/supabase-management.server';

/**
 * Le varianti che qualcuno ha gia' comprato.
 *
 * Serve a rispondere a una domanda precisa: fra i prodotti a cui manca il
 * costo, quali stanno gia' falsando un profitto? Un prodotto senza costo che
 * nessuno ha mai ordinato non sporca nessun numero — va sistemato prima o poi,
 * ma non e' urgente. Uno che compare in venti ordini sta rendendo parziale il
 * profitto di venti clienti adesso.
 *
 * Da qui il filtro "solo venduti" nella tab dei problemi: chi ci arriva da un
 * cliente con l'avviso vuole vedere i prodotti che riguardano lui, non il
 * catalogo intero.
 */
export interface SoldVariants {
  /** Le varianti gia' comprate. null = non si e' potuto sapere. */
  ids: Set<number> | null;
  /**
   * Nome del cliente, quando si e' chiesto di restringere a lui.
   *
   * Si legge qui e non dalla URL: il nome finisce dentro un'etichetta a schermo,
   * e prenderlo dall'indirizzo vorrebbe dire mostrare quello che ci scrive chi
   * apre la pagina. Null se quel cliente non ha ordini — e allora l'etichetta
   * non si mostra affatto, invece di dire "cliente senza nome".
   */
  customerName: string | null;
}

export async function loadSoldVariantIds(
  shopDomain: string,
  opts: { customerId?: number | null } = {},
): Promise<SoldVariants> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: {
      id: true,
      supabaseConfig: { select: { supabaseProjectRef: true, connectionVerifiedAt: true } },
    },
  });

  const ref = shop?.supabaseConfig?.supabaseProjectRef;
  // Senza database collegato non si sa cosa sia stato venduto. null e non un
  // insieme vuoto: "non lo so" e "nessuno" portano a schermate diverse — con
  // un insieme vuoto il filtro nasconderebbe tutto e sembrerebbe che non ci sia
  // niente da sistemare.
  if (!shop || !ref || !shop.supabaseConfig?.connectionVerifiedAt) {
    return { ids: null, customerName: null };
  }

  // L'id arriva dalla URL: si accetta solo un intero positivo, e finisce nella
  // query come numero e non come testo. Un valore diverso vale come "nessun
  // cliente" e la pagina mostra tutto.
  const customerId =
    opts.customerId != null && Number.isSafeInteger(opts.customerId) && opts.customerId > 0
      ? opts.customerId
      : null;

  try {
    const token = await getValidAccessToken(shop.id);

    // Restringendo a un cliente si passa dagli ordini: sono le sue righe che
    // interessano, non tutte quelle del negozio.
    const sql = customerId
      ? `SELECT DISTINCT l.shopify_variant_id,
                MAX(o.customer_first_name) AS first_name,
                MAX(o.customer_last_name)  AS last_name
         FROM order_lines l
         JOIN orders o ON o.shopify_order_id = l.shopify_order_id
         WHERE l.shopify_variant_id IS NOT NULL
           AND o.shopify_customer_id = ${customerId}
         GROUP BY l.shopify_variant_id`
      : `SELECT DISTINCT shopify_variant_id, NULL AS first_name, NULL AS last_name
         FROM order_lines
         WHERE shopify_variant_id IS NOT NULL`;

    const rows = await runQueryRows<{
      shopify_variant_id: string | number | null;
      first_name: string | null;
      last_name: string | null;
    }>(token, ref, sql);

    const ids = new Set(
      rows
        .map((row) => Number(row.shopify_variant_id))
        .filter((id) => Number.isFinite(id) && id > 0),
    );

    const named = customerId ? rows.find((row) => row.first_name || row.last_name) : null;
    const customerName = named
      ? [named.first_name, named.last_name].filter(Boolean).join(' ') || null
      : null;

    return { ids, customerName };
  } catch (error) {
    // Il filtro e' un di piu': se la lettura fallisce la pagina deve comunque
    // mostrare l'elenco completo, non un errore.
    console.warn(
      '[products.issues] non ho potuto leggere le varianti vendute:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    return { ids: null, customerName: null };
  }
}

/**
 * Quanti prodotti venduti non hanno un costo.
 *
 * Sono quelli che stanno falsando il profitto adesso: compaiono in ordini non
 * annullati, e di loro non si sa quanto siano costati. Il profitto di quegli
 * ordini e' calcolato sulle sole righe che un costo ce l'hanno, quindi risulta
 * piu' alto del vero — e non c'e' niente a schermo che lo dica, se non lo si
 * dice qui.
 *
 * La domanda si fa al database del merchant e non a Shopify: una passata sul
 * catalogo intero, a ogni apertura della dashboard, costerebbe secondi. Questa
 * e' una riga di conteggio.
 *
 * `products` contiene solo i prodotti idonei, cioe' quelli con un costo: una
 * variante senza costo non ha nemmeno la riga. Per questo la join e' esterna e
 * il conto prende sia le righe assenti sia quelle con il costo vuoto.
 */
export async function countSoldWithoutCost(shopDomain: string): Promise<number> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: {
      id: true,
      supabaseConfig: { select: { supabaseProjectRef: true, connectionVerifiedAt: true } },
    },
  });

  const ref = shop?.supabaseConfig?.supabaseProjectRef;
  if (!shop || !ref || !shop.supabaseConfig?.connectionVerifiedAt) return 0;

  try {
    const token = await getValidAccessToken(shop.id);
    const rows = await runQueryRows<{ total: string | number | null }>(
      token,
      ref,
      `SELECT COUNT(DISTINCT l.shopify_variant_id) AS total
       FROM order_lines l
       JOIN orders o ON o.shopify_order_id = l.shopify_order_id
       LEFT JOIN products p ON p.shopify_variant_id = l.shopify_variant_id
       WHERE l.shopify_variant_id IS NOT NULL
         AND o.cancelled_at IS NULL
         AND p.cost_per_item IS NULL`,
    );

    const total = Number(rows[0]?.total ?? 0);
    return Number.isFinite(total) && total > 0 ? total : 0;
  } catch (error) {
    // Zero e non un errore: l'avviso e' un di piu', e una dashboard che non si
    // apre perche' non si e' potuto contare un avviso e' molto peggio.
    console.warn(
      '[dashboard] non ho potuto contare i prodotti venduti senza costo:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    return 0;
  }
}
