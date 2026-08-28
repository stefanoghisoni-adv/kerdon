/**
 * La ricerca fra i clienti gia' caricati.
 *
 * Sta in un modulo a se' e non dentro il componente perche' e' l'unico pezzo
 * della tab che si puo' sbagliare in silenzio: una riga che non compare quando
 * dovrebbe non sembra un guasto, sembra un cliente che non c'e'.
 *
 * Si cerca su quattro campi, due dei quali in tabella non si vedono. Non e' una
 * stranezza: il nome e' proprio la cosa di cui non si e' sicuri — un cognome
 * scritto a meta', due omonimi, una mail personale al posto di quella
 * aziendale — mentre l'email e il telefono si hanno esatti, perche' arrivano da
 * altrove: un messaggio, una fattura, una telefonata.
 */

export interface SearchableCustomer {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
}

/** Solo le cifre: e' la forma in cui i telefoni stanno nel database. */
function digits(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

function contains(haystack: string | null | undefined, needle: string): boolean {
  return (haystack ?? '').toLowerCase().includes(needle);
}

/**
 * La riga risponde a quello che si sta cercando?
 *
 * Il confronto e' per contenuto e non per inizio: chi cerca "rossi" deve
 * trovare anche "De Rossi", e chi cerca un pezzo di dominio deve trovare tutti
 * quelli che ce l'hanno.
 *
 * Nome e cognome si confrontano anche uniti, perche' e' cosi' che si scrive un
 * nome quando lo si cerca: "mario rossi" e' una stringa sola per chi la digita,
 * mentre in tabella sono due colonne.
 *
 * Il telefono ha un giro suo: nel database sta in sole cifre, mentre chi cerca
 * lo copia com'e' scritto altrove, con il prefisso e gli spazi. Confrontare le
 * due forme cosi' come sono non troverebbe mai niente, quindi si riducono
 * entrambe a cifre. Una ricerca senza cifre dentro non tocca affatto il
 * telefono: "39" non deve tirar su ogni numero italiano quando chi scrive sta
 * cercando un nome.
 */
export function matchesCustomerSearch(
  row: SearchableCustomer,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ');
  if (
    contains(row.firstName, needle) ||
    contains(row.lastName, needle) ||
    contains(fullName, needle) ||
    contains(row.email, needle)
  ) {
    return true;
  }

  const wantedDigits = digits(needle);
  return wantedDigits.length > 0 && digits(row.phone ?? '').includes(wantedDigits);
}
