import { parse } from 'tldts';

/**
 * Il nome dell'endpoint, letto con la Public Suffix List.
 *
 * PERCHE' LA LISTA PUBBLICA E NON UN ELENCO NOSTRO. La domanda e' "questi due
 * nomi sono lo stesso sito?", ed e' la stessa che si fanno i browser quando
 * decidono se un cookie e' first-party. La risposta dipende da dove sta il
 * confine registrabile: `co.uk`, ma anche `github.io` o `vercel.app`, dove
 * ogni sottodominio e' di qualcuno di diverso. Un elenco scritto a mano ne
 * copre una manciata e sbaglia sugli altri — e lo sbaglio pericoloso e' dire
 * "stesso sito" a `negozio.github.io` e `altro.github.io`, che sono due persone.
 * La lista la tengono aggiornata altri, e `tldts` la porta con se'.
 *
 * I DOMINI PRIVATI DELLA LISTA CONTANO COME SUFFISSI (`allowPrivateDomains`):
 * e' proprio la sezione dove stanno `github.io` e simili, ed e' come la leggono
 * i browser.
 */
const PSL = { allowPrivateDomains: true } as const;

/**
 * Il dominio registrabile: cio' che rende un cookie first-party.
 *
 * `null` quando non ce n'e' uno — un IP, `localhost`, un suffisso da solo come
 * `github.io`: nomi su cui nessun negozio puo' avere un cookie suo.
 */
export function registrableDomain(host: string): string | null {
  const parsed = parse(host.toLowerCase().replace(/\.$/, ''), PSL);
  if (parsed.isIp) return null;
  return parsed.domain;
}

/**
 * Un nome che sta su internet, con un suffisso che la lista conosce.
 *
 * Fuori: gli indirizzi numerici (un endpoint first-party ha un nome per
 * definizione), `localhost`, e i nomi di rete locale (`.local`, `.internal`,
 * `.lan`), che la lista non conosce perche' non sono di nessuno su internet.
 *
 * Il nome da solo non basta a dire dove porta: quello lo controlla la chiamata,
 * sull'indirizzo a cui il nome si risolve.
 */
export function isPublicName(host: string): boolean {
  const parsed = parse(host.toLowerCase().replace(/\.$/, ''), PSL);
  if (parsed.isIp) return false;
  if (!parsed.domain) return false;
  return parsed.isIcann === true || parsed.isPrivate === true;
}
