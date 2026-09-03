/**
 * Le pagine di una tabella, e l'intervallo di righe che se ne vede.
 *
 * Sta qui e non accanto a una delle due tabelle perche' a usarlo sono in due —
 * i clienti e i prodotti non idonei — e due copie della stessa aritmetica sono
 * due cose da tenere allineate: basta cambiare il numero di righe per pagina in
 * un posto solo e le due tab smettono di corrispondersi senza che nessuno se ne
 * accorga.
 */

/**
 * Quante righe stanno in una pagina.
 *
 * Cinquanta e non venti: l'elenco si scorre per cercare qualcosa, e a venti
 * righe si passava piu' tempo a cambiare pagina che a leggere. E' lo stesso
 * numero per tutte le tabelle dell'app — un elenco che ne mostra venti e uno
 * che ne mostra cinquanta fanno sembrare piu' corto quello che non lo e'.
 */
export const PER_PAGE = 50;

/** Quante pagine servono per `total` righe. Nessuna riga, nessuna pagina. */
export function pageCount(total: number, perPage: number): number {
  if (total <= 0 || perPage <= 0) return 0;
  return Math.ceil(total / perPage);
}

/** Le righe della pagina chiesta. Oltre l'ultima resta vuota. */
export function pageSlice<T>(rows: T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return rows.slice(start, start + perPage);
}

/** Da quale riga a quale riga: `1-50`, `51-73`. */
export interface VisibleRange {
  from: number;
  to: number;
}

/**
 * L'intervallo visibile, contato sulle righe che restano dopo filtri e ricerca.
 *
 * `total` e' quello che si vede, non quello che si ha: con una ricerca che ne
 * lascia dodici l'etichetta dice `1-12`, perche' e' quello che il merchant ha
 * davanti. Contare sul totale grezzo direbbe `1-50` sopra una tabella di dodici
 * righe.
 *
 * La pagina viene riportata dentro i limiti invece di essere creduta sulla
 * parola: fra il momento in cui una riga sparisce dall'elenco e quello in cui
 * la pagina si arretra passa un render, e in quel render il conto sarebbe
 * `51-50`.
 *
 * `null` quando non c'e' niente da mostrare: un intervallo `0-0` sotto una
 * tabella vuota e' un numero che non vuol dire niente.
 */
export function visibleRange(
  total: number,
  page: number,
  perPage: number,
): VisibleRange | null {
  const pages = pageCount(total, perPage);
  if (pages === 0) return null;

  const current = Math.min(Math.max(Math.trunc(page), 1), pages);
  return {
    from: (current - 1) * perPage + 1,
    to: Math.min(current * perPage, total),
  };
}
