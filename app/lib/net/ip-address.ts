/**
 * Quali indirizzi IP stanno davvero su internet.
 *
 * PERCHE' SERVE. Quando il nostro server chiama un indirizzo scelto da altri,
 * il nome si puo' scegliere in modo che punti dove vuole chi lo sceglie: a una
 * macchina della nostra rete, al servizio dei metadati del cloud che risponde
 * con le credenziali, al server stesso. Il filtro sul nome non basta, perche' un
 * nome qualsiasi puo' risolversi in `10.0.0.5`. Il filtro vero va fatto
 * sull'indirizzo a cui ci si collega, ed e' questo.
 *
 * L'IPv6 SI GIUDICA PER ESCLUSIONE AL CONTRARIO: e' globale solo cio' che sta
 * nel blocco dei globali (2000::/3) e non in uno dei suoi buchi. Elencare i
 * blocchi cattivi uno per uno lascerebbe passare quelli che nessuno ha ancora
 * pensato di elencare; elencare i buoni sbaglia, se sbaglia, dalla parte di un
 * rifiuto di troppo.
 *
 * GLI IPv4 TRAVESTITI DA IPv6 si guardano dentro: `::ffff:10.0.0.1`, il NAT64
 * `64:ff9b::10.0.0.1` e il 6to4 `2002:0a00:0001::` portano tutti a un indirizzo
 * privato, e un controllo che li lascia passare perche' "sono IPv6" non
 * controlla niente.
 *
 * Nessuna dipendenza da Node: sono conti su numeri, e restano verificabili da
 * soli.
 */

/** [rete, lunghezza del prefisso] — tutti i blocchi IPv4 che non sono internet. */
const NON_GLOBAL_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "questa rete"
  ['10.0.0.0', 8], // privati RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, metadati del cloud compresi
  ['172.16.0.0', 12], // privati RFC 1918
  ['192.0.0.0', 24], // assegnazioni di protocollo IETF
  ['192.0.2.0', 24], // documentazione
  ['192.88.99.0', 24], // relay 6to4, dismesso
  ['192.168.0.0', 16], // privati RFC 1918
  ['198.18.0.0', 15], // banchi di prova
  ['198.51.100.0', 24], // documentazione
  ['203.0.113.0', 24], // documentazione
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // riservati, broadcast compreso
];

function parseV4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    // Niente zeri iniziali: `010` per qualcuno e' dieci e per qualcun altro
    // otto, e su un'ambiguita' del genere non si decide dove collegarsi.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

function inV4Block(ip: number, [net, bits]: [string, number]): boolean {
  const base = parseV4(net)!;
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(base / size);
}

function isGlobalV4(ip: number): boolean {
  return !NON_GLOBAL_V4.some((block) => inV4Block(ip, block));
}

/** Le otto parti da 16 bit di un IPv6, o `null` se non e' un IPv6. */
function parseV6(value: string): number[] | null {
  if (!value.includes(':')) return null;

  let text = value;
  // Un IPv4 in coda (`::ffff:1.2.3.4`) vale due gruppi: lo si riscrive cosi' e
  // da li' in avanti e' un IPv6 come gli altri.
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseV4(last);
    if (v4 === null) return null;
    const hi = Math.floor(v4 / 65536).toString(16);
    const lo = (v4 % 65536).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const group = (s: string) => (s === '' ? [] : s.split(':'));
  const head = group(halves[0]);
  const rest = halves.length === 2 ? group(halves[1]) : [];
  for (const g of [...head, ...rest]) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
  }
  const hex = (list: string[]) => list.map((g) => parseInt(g, 16));

  const total = head.length + rest.length;
  if (halves.length === 1) return total === 8 ? hex(head) : null;
  // `::` sta per almeno un gruppo di zeri.
  if (total > 7) return null;
  return [...hex(head), ...new Array<number>(8 - total).fill(0), ...hex(rest)];
}

function embeddedV4(hi: number, lo: number): number {
  return hi * 65536 + lo;
}

function isGlobalV6(g: number[]): boolean {
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);

  // IPv4 mappato (::ffff:0:0/96): conta l'IPv4 che c'e' dentro.
  if (allZeroUpTo(5) && g[5] === 0xffff) return isGlobalV4(embeddedV4(g[6], g[7]));
  // NAT64 noto (64:ff9b::/96): idem, e' un IPv4 tradotto.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isGlobalV4(embeddedV4(g[6], g[7]));
  }
  // 6to4 (2002::/16): l'IPv4 sta nei gruppi 1 e 2.
  if (g[0] === 0x2002) return isGlobalV4(embeddedV4(g[1], g[2]));

  // Fuori da 2000::/3 non c'e' niente di globale: ::, ::1, fc00::/7, fe80::/10,
  // ff00::/8, 64:ff9b:1::/48, 100::/64, gli IPv4-compatibili.
  if ((g[0] & 0xe000) !== 0x2000) return false;

  // I buchi dentro 2000::/3.
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23, Teredo compreso
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentazione
  if ((g[0] & 0xfff0) === 0x3ff0) return false; // 3fff::/20, documentazione

  return true;
}

function strip(value: string): string {
  let text = value.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // La zona (`fe80::1%eth0`) dice da che scheda uscire, non dove si arriva.
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  return text;
}

/** E' scritto come un indirizzo IP, IPv4 o IPv6? */
export function isIpLiteral(value: string): boolean {
  const text = strip(value);
  return parseV4(text) !== null || parseV6(text) !== null;
}

/**
 * L'indirizzo sta su internet pubblico?
 *
 * `false` anche per tutto cio' che non si riesce a leggere come indirizzo: chi
 * chiede se ci si puo' collegare a qualcosa che non capisce riceve un no.
 */
export function isGlobalAddress(value: string): boolean {
  const text = strip(value);
  const v4 = parseV4(text);
  if (v4 !== null) return isGlobalV4(v4);
  const v6 = parseV6(text);
  if (v6 !== null) return isGlobalV6(v6);
  return false;
}
