// app/lib/supabase/identifiers.ts
// Nomi di tabella e schema che finiscono dentro il DDL, e il solo posto dove si
// decide se possono entrarci.
//
// Il motivo per cui esiste: `tableNameProducts` e `tableNameCustomers` sono
// campi configurabili, e finivano interpolati nel DDL cosi' com'erano —
// `DROP TABLE IF EXISTS "${products}"`. Un nome con dentro un doppio apice
// chiude la stringa e quello che segue e' SQL eseguito col token OAuth del
// merchant, cioe' con i permessi piu' alti che l'app abbia sul suo progetto.
// Non e' un'ipotesi da manuale: quel valore arriva da un form e nessuno lo
// guardava.
//
// Da qui in poi la regola e' una sola: un identificatore o passa questa
// funzione, o non entra in nessuna query. Il rifiuto arriva PRIMA che il DDL
// venga costruito, non mentre lo si esegue — a meta' di un DROP non c'e' piu'
// niente da salvare.

/**
 * Un nome che non puo' entrare in una query.
 *
 * Ha un tipo suo perche' il chiamante deve poterlo distinguere da un guasto di
 * rete: un nome malformato non si ritenta, si rifiuta.
 */
export class InvalidIdentifierError extends Error {
  constructor(readonly identifier: string, reason: string) {
    super(`identificatore non valido (${reason})`);
    this.name = 'InvalidIdentifierError';
  }
}

/**
 * Il limite di Postgres: NAMEDATALEN - 1. Oltre, il server TRONCA in silenzio
 * invece di rifiutare — ed e' il caso peggiore, perche' un nome troncato punta
 * a una tabella diversa da quella che si credeva di nominare.
 */
const MAX_LENGTH = 63;

/**
 * Solo ASCII, e volutamente piu' stretto di cio' che Postgres accetterebbe fra
 * virgolette (fra virgolette accetta quasi tutto, spazi e accenti compresi).
 *
 * Restringere qui non toglie niente a nessuno: sono i nomi delle tabelle che
 * l'app crea, e le tabelle dell'app si chiamano `products` e `customers`. In
 * cambio tiene fuori l'intera categoria dei nomi che si assomigliano senza
 * essere lo stesso nome — la "а" cirillica di `prоducts`, uno spazio in coda,
 * un carattere invisibile — che su una DROP vuol dire cancellare una tabella
 * mentre si crede di cancellarne un'altra.
 */
const SAFE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Perche' un nome e' stato rifiutato, o `null` se e' buono. */
export function identifierRejection(name: unknown): string | null {
  if (typeof name !== 'string') return 'non e\' una stringa';
  if (name.length === 0) return 'vuoto';
  if (name.length > MAX_LENGTH) return `piu\' lungo di ${MAX_LENGTH} caratteri`;
  // Il conto in caratteri non basta: Postgres tronca a 63 BYTE, e un nome di
  // sessanta caratteri accentati ne occupa il doppio.
  if (Buffer.byteLength(name, 'utf8') > MAX_LENGTH) return `piu' lungo di ${MAX_LENGTH} byte`;
  if (!SAFE.test(name)) return 'caratteri non ammessi';
  return null;
}

export function isSafeIdentifier(name: unknown): name is string {
  return identifierRejection(name) === null;
}

/**
 * Il nome pronto da mettere in una query, fra doppi apici.
 *
 * Il raddoppio dei doppi apici c'e' anche se `SAFE` li ha gia' esclusi, e non
 * e' un doppione inutile: e' cio' che rende questa funzione corretta DA SOLA,
 * senza dipendere dal fatto che qualcuno prima abbia validato. Se un giorno la
 * regola si allargasse, la citazione reggerebbe lo stesso.
 *
 * Le virgolette non sono opzionali: senza, Postgres normalizza a minuscolo e
 * una tabella creata `Products` non verrebbe piu' trovata.
 */
export function quoteIdentifier(name: string): string {
  const rejection = identifierRejection(name);
  if (rejection) throw new InvalidIdentifierError(String(name), rejection);
  return `"${name.replace(/"/g, '""')}"`;
}

/** `"schema"."tabella"`: entrambi i pezzi passano dallo stesso controllo. */
export function quoteQualifiedName(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/**
 * Lo stesso nome come VALORE, per le interrogazioni a `information_schema`.
 *
 * Li' il nome della tabella non e' un identificatore ma una stringa da
 * confrontare, e le due cose si citano in modo diverso: apice singolo
 * raddoppiato, non doppio apice. Confonderle e' il modo classico di scrivere
 * una verifica che sembra funzionare e non confronta niente.
 */
export function quoteLiteral(value: string): string {
  const rejection = identifierRejection(value);
  if (rejection) throw new InvalidIdentifierError(String(value), rejection);
  return `'${value.replace(/'/g, "''")}'`;
}
