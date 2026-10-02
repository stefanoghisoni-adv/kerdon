// Il tetto del piano e' salito? Per quali entita'?
//
// Le sync periodiche sono incrementali: rileggono solo cio' che e' cambiato su
// Shopify. Quando il tetto prodotti o clienti sale, i record rimasti fuori dal
// tetto vecchio non sono cambiati, quindi nessun delta li porterebbe: serve una
// passata completa. Qui si decide SE serve e per COSA; chi la accoda sta in
// app/lib/billing/cap-catch-up.server.ts.
//
// Modulo puro: nessun import, cosi' la decisione si prova in un istante.

/** I soli campi del piano che decidono quanti record si sincronizzano. */
export interface CapPlan {
  /** null = nessun tetto. */
  maxProducts: number | null;
  /** null = nessun tetto. Conta solo se `customersSyncEnabled`. */
  maxCustomers: number | null;
  customersSyncEnabled: boolean;
}

/** Quali tetti sono saliti passando da un piano all'altro. */
export interface RaisedCaps {
  products: boolean;
  customers: boolean;
}

// Illimitato come infinito, per poterlo confrontare.
function limit(value: number | null): number {
  return value == null ? Number.POSITIVE_INFINITY : value;
}

// Il tetto prodotti come lo applica la sync: un piano che non si trova nel
// listino non ha tetto (e' il ripiego di chi legge `plan?.maxProducts ?? null`).
function productCap(plan: CapPlan | null): number {
  return limit(plan?.maxProducts ?? null);
}

// Il tetto clienti come lo applica la sync: zero se il piano non li include,
// e un piano sconosciuto non li include.
function customerCap(plan: CapPlan | null): number {
  if (!plan?.customersSyncEnabled) return 0;
  return limit(plan.maxCustomers);
}

/**
 * Confronta i tetti effettivi del piano di prima e di quello di adesso.
 *
 * Solo una salita conta: scendendo, o restando sullo stesso piano (la stessa
 * notifica arrivata due volte), non c'e' niente di nuovo da far entrare.
 * Passare da "clienti non inclusi" a "inclusi" e da un tetto finito a
 * illimitato sono salite.
 */
export function raisedCaps(previous: CapPlan | null, next: CapPlan | null): RaisedCaps {
  return {
    products: productCap(next) > productCap(previous),
    customers: customerCap(next) > customerCap(previous),
  };
}
