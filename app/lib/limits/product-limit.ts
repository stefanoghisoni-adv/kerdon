// Applicazione del limite di prodotti per piano durante la sincronizzazione.
// I piani definiscono `maxProducts` (Basic 20, Growth 200, Scale 1.000,
// Core/Lifetime = null → illimitato; il listino sta in
// app/lib/billing/plan-tiers.ts). La sync non deve popolare più prodotti di
// quanti il piano consenta. Vale solo per la sync dei prodotti: gli ordini si
// sincronizzano sempre tutti, e i feed di catalogo non hanno un tetto loro.

/**
 * Ritorna il sottoinsieme di `products` da processare in questa pagina in modo
 * che il totale cumulativo processato non superi `limit`.
 *
 * @param products   prodotti della pagina corrente
 * @param alreadyTaken prodotti già processati nelle pagine precedenti
 * @param limit      tetto massimo del piano; `null`/`undefined` = illimitato
 */
export function limitProducts<T>(
  products: T[],
  alreadyTaken: number,
  limit: number | null | undefined,
): T[] {
  if (limit == null) return products;
  const remaining = Math.max(0, limit - alreadyTaken);
  return products.slice(0, remaining);
}

/**
 * True se, avendo già processato `alreadyTaken` prodotti, il limite del piano
 * è stato raggiunto (quindi si può interrompere la paginazione).
 */
export function isProductLimitReached(
  alreadyTaken: number,
  limit: number | null | undefined,
): boolean {
  if (limit == null) return false;
  return alreadyTaken >= limit;
}
