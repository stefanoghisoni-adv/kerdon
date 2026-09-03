import type { ProblemVariant } from './product-readiness';

// Sottostringa case-insensitive su piu' campi in OR. productId e price sono
// confrontati come TESTO: cercare "123" trova sia l'id 1234 sia il prezzo 12.30.
// E' voluto — la ricerca serve a scremare, non a filtrare in modo esatto.
export function filterProblemVariants(
  rows: ProblemVariant[],
  query: string,
): ProblemVariant[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;

  return rows.filter((r) =>
    [
      r.productTitle,
      r.variantTitle,
      r.sku ?? '',
      String(r.productId),
      r.price ?? '',
    ].some((field) => field.toLowerCase().includes(q)),
  );
}
