// app/lib/customers/conflict-rows.ts
//
// Funzioni pure per gestire i conflitti nella tabella Clienti.

/**
 * Tipo per il conflitto grezzo da listConflicts.
 */
export interface RawConflict {
  customerId: number;
  field: string;
  ours: string | null;
  theirs: string;
  provider: string;
}

/**
 * Tipo per i dati base del cliente.
 */
export interface CustomerData {
  customerId: number;
  firstName: string | null;
  email: string | null;
}

/**
 * Tipo per una riga nella vista conflitti.
 */
export interface ConflictRow {
  customerId: number;
  firstName: string | null;
  email: string | null;
  ours: string | null;
  theirs: string;
  provider: string;
}

/**
 * Parsing del parametro ?view= dall'URL.
 *
 * @param params URLSearchParams dalla query string
 * @returns 'all' | 'conflicts'
 */
export function parseViewParam(params: URLSearchParams): 'all' | 'conflicts' {
  const view = params.get('view');
  return view === 'conflicts' ? 'conflicts' : 'all';
}

/**
 * Vista effettiva: la vista conflitti si mostra solo se richiesta E ci sono conflitti.
 * Altrimenti, si mostra «Tutti» per evitare dead-end.
 *
 * @param params URLSearchParams dalla query string
 * @param openConflictsCount Numero di conflitti aperti
 * @returns 'all' | 'conflicts'
 */
export function effectiveView(
  params: URLSearchParams,
  openConflictsCount: number,
): 'all' | 'conflicts' {
  const requested = parseViewParam(params);
  return requested === 'conflicts' && openConflictsCount > 0 ? 'conflicts' : 'all';
}

/**
 * Unisce i conflitti con i dati dei clienti presenti nella lista corrente.
 * Se un cliente con conflitto non è nella lista (fuori dal periodo scelto),
 * la riga mostra comunque il conflitto ma con firstName ed email null.
 *
 * @param conflicts I conflitti aperti (da listConflicts)
 * @param customers I clienti nella vista corrente (già filtrati dal periodo)
 * @returns Array di righe pronte per la tabella
 */
export function conflictRows(
  conflicts: RawConflict[],
  customers: CustomerData[],
): ConflictRow[] {
  if (conflicts.length === 0) return [];

  // Mappa customerId → dati cliente per lookup veloce
  const customerMap = new Map(
    customers.map((c) => [c.customerId, c]),
  );

  return conflicts.map((conflict) => {
    const customer = customerMap.get(conflict.customerId);
    return {
      customerId: conflict.customerId,
      firstName: customer?.firstName ?? null,
      email: customer?.email ?? null,
      ours: conflict.ours,
      theirs: conflict.theirs,
      provider: conflict.provider,
    };
  });
}
