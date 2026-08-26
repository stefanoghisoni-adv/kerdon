/**
 * La region da consigliare a questo negozio.
 *
 * Il criterio e' la distanza: piu' il database e' vicino a chi lo interroga,
 * meno tempo passa fra la domanda e la risposta — e qui a interrogarlo sono il
 * negozio e gli strumenti di tracciamento, che stanno dove sta il negozio.
 *
 * L'unica idea di "dove" che l'app ha e' il fuso orario che Shopify dichiara
 * per il negozio. Non e' una posizione precisa, ma per scegliere fra Irlanda,
 * Virginia e Singapore e' abbastanza: un negozio su Europe/Rome non va servito
 * dall'Ohio.
 *
 * Il suggerimento resta un suggerimento: la tendina le mostra tutte, e chi ha
 * ragioni sue — un obbligo di residenza dei dati, un'infrastruttura altrove —
 * sceglie quello che vuole.
 */

/** Region di ripiego: la piu' vicina al maggior numero di negozi che serviamo. */
export const DEFAULT_REGION = 'eu-west-1';

/**
 * Da area del fuso a region, dalla piu' specifica alla piu' generale.
 *
 * L'ordine conta: `Europe/Moscow` deve incontrare la sua riga prima di quella
 * che manda tutta `Europe/` in Irlanda.
 */
const BY_ZONE: Array<[RegExp, string]> = [
  // Europa continentale a est: Francoforte e' piu' vicina di Dublino.
  [/^Europe\/(Moscow|Kiev|Kyiv|Helsinki|Athens|Bucharest|Sofia|Riga|Tallinn|Vilnius|Warsaw|Istanbul)/i, 'eu-central-1'],
  [/^Europe\/(London|Dublin|Lisbon)/i, 'eu-west-1'],
  [/^Europe\/Paris/i, 'eu-west-3'],
  [/^Europe\//i, 'eu-central-1'],
  [/^(Atlantic|Africa)\//i, 'eu-west-1'],

  // Nord America: la costa ovest ha la sua, il resto guarda a est.
  [/^America\/(Los_Angeles|Vancouver|Tijuana|Phoenix|Denver|Edmonton|Boise)/i, 'us-west-1'],
  [/^America\/(Toronto|Montreal|Winnipeg|Halifax|St_Johns|Regina)/i, 'ca-central-1'],
  [/^America\/(Sao_Paulo|Argentina|Santiago|Bogota|Lima|Montevideo|Asuncion|La_Paz|Caracas)/i, 'sa-east-1'],
  [/^(America|US|Canada)\//i, 'us-east-1'],
  [/^Pacific\/(Honolulu|Midway|Pago_Pago)/i, 'us-west-1'],

  // Asia e Oceania.
  [/^Asia\/(Tokyo|Seoul|Osaka)/i, 'ap-northeast-1'],
  [/^Asia\/(Kolkata|Calcutta|Karachi|Colombo|Dhaka|Kathmandu)/i, 'ap-south-1'],
  [/^Asia\/(Dubai|Qatar|Riyadh|Tehran|Baghdad|Jerusalem|Kuwait|Muscat)/i, 'eu-central-1'],
  [/^Asia\//i, 'ap-southeast-1'],
  [/^(Australia|Pacific)\//i, 'ap-southeast-1'],
  [/^Indian\//i, 'ap-south-1'],
];

/**
 * La region consigliata, scelta fra quelle davvero disponibili.
 *
 * Le region che Supabase offre cambiano nel tempo: se quella suggerita non e'
 * fra le disponibili si ripiega, invece di consigliare qualcosa che poi non si
 * puo' scegliere. E se nemmeno il ripiego c'e', si prende la prima dell'elenco.
 */
export function suggestRegion(
  timeZone: string | null | undefined,
  available: Array<{ id: string }>,
): string | null {
  if (available.length === 0) return null;

  const has = (id: string) => available.some((region) => region.id === id);
  const zone = (timeZone ?? '').trim();

  const guess = zone ? BY_ZONE.find(([pattern]) => pattern.test(zone))?.[1] : null;

  if (guess && has(guess)) return guess;
  if (has(DEFAULT_REGION)) return DEFAULT_REGION;
  return available[0].id;
}
