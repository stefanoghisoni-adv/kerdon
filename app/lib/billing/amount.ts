/**
 * Confrontare due importi.
 *
 * Sembra una riga e invece e' un modulo, perche' gli importi che al ritorno da
 * Shopify vanno messi uno accanto all'altro arrivano in tre forme diverse: un
 * `number` dallo state firmato, una stringa da GraphQL, un `Decimal` dalla riga
 * dell'addebito. Metterli d'accordo passando per la virgola mobile e' il modo
 * classico di sbagliare — `29.9 - 29.9` non fa sempre zero, e il confronto "a
 * meno di mezzo centesimo" che stava qui prima dichiarava uguali due cifre
 * diverse ogni volta che la tolleranza era piu' larga della differenza.
 *
 * Qui gli importi diventano centesimi interi (`bigint`) e si confrontano per
 * uguaglianza esatta. Non c'e' nessuna tolleranza: due prezzi che differiscono
 * di un centesimo sono due prezzi diversi, e questa e' la riga a cui si guarda
 * quando un merchant chiede conto di quanto ha pagato.
 */

/** Quanti centesimi ci sono in un'unita'. Le valute che usiamo hanno due cifre. */
const CENTESIMI = 100n;

/**
 * L'importo in centesimi, o null se quel valore non e' un importo.
 *
 * Accetta tutto cio' che sa scriversi come cifra decimale: il `number` dello
 * state, la stringa di Shopify, il `Decimal` di Prisma (che si converte da se'
 * con `toString`). Null — e non zero — quando non si riesce a leggere: zero
 * sarebbe un importo, e "non lo so" non deve poter passare per "gratis".
 */
export function minorUnits(
  value: string | number | { toString(): string } | null | undefined,
): bigint | null {
  if (value == null) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  const raw = (typeof value === 'string' ? value : String(value)).trim();
  // Solo la notazione decimale piana: la notazione esponenziale che JavaScript
  // produce sui numeri enormi non e' un prezzo, ed e' meglio dichiararla
  // illeggibile che interpretarla a caso.
  const parti = /^(-?)(\d+)(?:\.(\d*))?$/.exec(raw);
  if (!parti) return null;

  const [, segno, interi, decimali = ''] = parti;
  const centesimi = (decimali + '00').slice(0, 2);
  const oltre = decimali.slice(2);

  let totale = BigInt(interi) * CENTESIMI + BigInt(centesimi);
  // Arrotondamento al centesimo, meta' verso l'alto: le terze cifre decimali
  // arrivano dalle conversioni di valuta di Shopify, non dai nostri listini,
  // e troncarle farebbe risultare diverso un importo che diverso non e'.
  if (oltre && Number(oltre[0]) >= 5) totale += 1n;

  return segno === '-' ? -totale : totale;
}

/**
 * I due importi sono lo stesso importo.
 *
 * Un valore illeggibile non e' mai uguale a niente, nemmeno a un altro valore
 * illeggibile: se non si sa quanto sono, non si sa nemmeno se coincidono.
 */
export function sameAmount(
  a: string | number | { toString(): string } | null | undefined,
  b: string | number | { toString(): string } | null | undefined,
): boolean {
  const left = minorUnits(a);
  const right = minorUnits(b);
  return left !== null && right !== null && left === right;
}

/**
 * Il primo importo non supera il secondo.
 *
 * Serve a una domanda sola: il prezzo che il merchant paga puo' stare sotto il
 * listino (e' quello che fa uno sconto riservato) ma non sopra. Un valore
 * illeggibile risponde false, che qui vuol dire "questo controllo non l'ha
 * passato" — l'esito prudente.
 */
export function notAbove(
  a: string | number | { toString(): string } | null | undefined,
  b: string | number | { toString(): string } | null | undefined,
): boolean {
  const left = minorUnits(a);
  const right = minorUnits(b);
  return left !== null && right !== null && left <= right;
}
