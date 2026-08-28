import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQueryRows } from '~/lib/supabase-management.server';
import { soldVariantsSQL } from './sold-without-cost';

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
 *
 * Questa e' l'UNICA cosa che si chiede al database del merchant: che cosa e'
 * stato venduto. Se ci sia un costo oppure no lo dice Shopify — vedere
 * `sold-without-cost.ts` per il perche'.
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

  try {
    const token = await getValidAccessToken(shop.id);

    // La query non si scrive qui: e' la definizione di "prodotto incluso in
    // ordini", ed e' condivisa con il conteggio dell'avviso. Due definizioni
    // scritte in due posti sono due definizioni, ed e' esattamente cosi' che
    // l'avviso e l'elenco erano arrivati a dire numeri diversi.
    const rows = await runQueryRows<{
      shopify_variant_id: string | number | null;
      first_name: string | null;
      last_name: string | null;
    }>(token, ref, soldVariantsSQL(opts.customerId ?? null));

    const ids = new Set(
      rows
        .map((row) => Number(row.shopify_variant_id))
        .filter((id) => Number.isFinite(id) && id > 0),
    );

    const named = rows.find((row) => row.first_name || row.last_name) ?? null;
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
