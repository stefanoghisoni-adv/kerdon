/**
 * Il file che Meta scarica.
 *
 * Due formati perche' Meta ne legge due e i merchant ne conoscono uno: chi ha
 * gia' lavorato con Google Merchant Center riconosce l'XML, chi apre i file con
 * un foglio di calcolo vuole il CSV. Il contenuto e' lo stesso.
 */

import type { MetaItem } from './meta';

/**
 * L'ordine delle colonne del CSV, che e' anche l'ordine dei tag nell'XML.
 *
 * Prima i campi obbligatori: aprendo il file con un foglio di calcolo si vede
 * subito se il catalogo ha quello che serve, senza scorrere a destra.
 */
const FIELDS: (keyof MetaItem)[] = [
  'id',
  'item_group_id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'sale_price',
  'link',
  'image_link',
  'brand',
  'gtin',
  'mpn',
  'product_type',
  'quantity_to_sell_on_facebook',
];

/**
 * I cinque caratteri che in XML non possono restare se stessi.
 *
 * Le descrizioni dei prodotti arrivano da un editor di testo ricco: contengono
 * `&` e `<` di continuo, e uno solo non convertito rende illeggibile il file
 * intero, non la riga.
 */
function xmlEscape(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // I caratteri di controllo non sono validi in XML 1.0 nemmeno se
      // convertiti: vanno tolti, o il parser di Meta si ferma li' e con lui il
      // resto del file. Tab, a capo e ritorno a capo restano: sono legali.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  );
}

/** RSS 2.0 con lo spazio dei nomi di Google: e' il formato che Meta documenta. */
export function toXml(items: MetaItem[], opts: { title: string; link: string }): string {
  const rows = items.map((item) => {
    const tags = FIELDS.filter((field) => item[field] !== undefined)
      .map((field) => `      <g:${field}>${xmlEscape(String(item[field]))}</g:${field}>`)
      .join('\n');
    return `    <item>\n${tags}\n    </item>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '  <channel>',
    `    <title>${xmlEscape(opts.title)}</title>`,
    `    <link>${xmlEscape(opts.link)}</link>`,
    '    <description>Product catalogue</description>',
    ...rows,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

/**
 * Una cella CSV.
 *
 * Le virgolette si raddoppiano e la cella si racchiude appena contiene una
 * virgola, una virgoletta o un a capo — le descrizioni dei prodotti li
 * contengono quasi sempre tutti e tre.
 */
function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Il BOM in testa al CSV.
 *
 * A Meta non serve, ma il merchant il file lo apre per controllarlo, e senza
 * questi tre byte un foglio di calcolo legge il file come se non fosse UTF-8:
 * gli accenti si rompono e il catalogo sembra guasto quando invece e' giusto.
 */
const BOM = '\uFEFF';

export function toCsv(items: MetaItem[]): string {
  const header = FIELDS.join(',');
  const rows = items.map((item) =>
    FIELDS.map((field) => csvCell(item[field] === undefined ? '' : String(item[field]))).join(','),
  );
  return BOM + [header, ...rows].join('\r\n') + '\r\n';
}
