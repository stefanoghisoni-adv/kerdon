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
export async function loadSoldVariantIds(shopDomain: string): Promise<Set<number> | null> {
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
  if (!shop || !ref || !shop.supabaseConfig?.connectionVerifiedAt) return null;

  try {
    const token = await getValidAccessToken(shop.id);
    const rows = await runQueryRows<{ shopify_variant_id: string | number | null }>(
      token,
      ref,
      `SELECT DISTINCT shopify_variant_id
       FROM order_lines
       WHERE shopify_variant_id IS NOT NULL`,
    );

    return new Set(
      rows
        .map((row) => Number(row.shopify_variant_id))
        .filter((id) => Number.isFinite(id) && id > 0),
    );
  } catch (error) {
    // Il filtro e' un di piu': se la lettura fallisce la pagina deve comunque
    // mostrare l'elenco completo, non un errore.
    console.warn(
      '[products.issues] non ho potuto leggere le varianti vendute:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    return null;
  }
}
