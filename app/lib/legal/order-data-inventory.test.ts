// app/lib/legal/order-data-inventory.test.ts
//
// Il contratto fra tre cose che devono dire lo stesso, e per un pezzo non
// l'hanno detto:
//
//  (a) i campi che l'app chiede davvero a Shopify sugli ordini — le query
//      catturate mentre il client le manda, compresi i completamenti di
//      spedizioni, resi e righe e il recupero dello storico;
//  (b) le colonne della tabella `orders` nel database del merchant;
//  (c) l'inventario in `order-data-inventory.ts`, e da li' i documenti legali.
//
// Se uno dei tre si muove da solo, qui qualcosa fallisce.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('~/shopify.server', () => ({ unauthenticated: { admin: vi.fn() } }));

import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { ORDERS_COLUMN_NAMES } from '~/lib/supabase-schema';
import { ANONYMOUS_ORDER } from '~/lib/gdpr/customer-record.server';
import { FULFILLMENTS_FIRST } from '~/lib/shipping/order-logistics-facts';
import {
  INVENTARIO_ORDINI,
  VOCI_LOGISTICHE,
  campiGraphqlDichiarati,
  colonneAzzerateAllaCancellazione,
  colonneDichiarate,
} from './order-data-inventory';

// --- Lettura delle query ------------------------------------------------------

/**
 * I campi foglia di una query GraphQL, come percorsi puntati.
 *
 * Un lettore minimo, sufficiente alle query di questo client: salta la testata
 * (`query Nome($x: T)`), gli argomenti fra parentesi e i frammenti in linea
 * (`... on Order`), che non aggiungono un livello al percorso.
 */
function campiFoglia(query: string): string[] {
  const token: string[] = query.match(/\.\.\.|[A-Za-z_][A-Za-z0-9_]*|[{}()]|\$[A-Za-z0-9_]+|[^\s]/g) ?? [];
  const inizio = token.indexOf('{');
  const fuori: string[] = [];
  const pila: string[] = [];
  let ultimo: string | null = null;

  for (let i = inizio + 1; i < token.length; i++) {
    const t = token[i];
    if (t === '(') {
      let profondita = 1;
      while (profondita > 0 && ++i < token.length) {
        if (token[i] === '(') profondita++;
        if (token[i] === ')') profondita--;
      }
      continue;
    }
    if (t === '...') {
      // `... on Tipo {`: il frammento non e' un campo.
      i += 2;
      pila.push('');
      ultimo = null;
      continue;
    }
    if (t === '{') {
      pila.push(ultimo ?? '');
      ultimo = null;
      continue;
    }
    if (t === '}') {
      if (ultimo) fuori.push([...pila, ultimo].filter(Boolean).join('.'));
      ultimo = null;
      pila.pop();
      continue;
    }
    if (/^[A-Za-z_]/.test(t)) {
      if (ultimo) fuori.push([...pila, ultimo].filter(Boolean).join('.'));
      ultimo = t;
    }
  }
  return fuori;
}

/** Dal percorso nella query al percorso a partire dall'ordine. */
function dallOrdine(percorso: string): string | null {
  for (const radice of ['orders.nodes.', 'order.', 'nodes.', 'node.']) {
    if (percorso.startsWith(radice)) return percorso.slice(radice.length);
  }
  // `orders.pageInfo.*` e' la paginazione dell'elenco, non un campo d'ordine.
  return null;
}

function ok(data: unknown) {
  return {
    ok: true,
    headers: new Headers({ 'X-Shopify-API-Version': '2026-07' }),
    json: async () => ({ data }),
  };
}

/** Un ordine che costringe il client a fare tutti i giri: righe, spedizioni e resi oltre la prima pagina. */
const ordineLungo = () => ({
  id: 'gid://shopify/Order/4242',
  name: '#4242',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-10T00:00:00Z',
  cancelledAt: null,
  displayFinancialStatus: 'PAID',
  currentTotalPriceSet: { shopMoney: { amount: '120.00', currencyCode: 'EUR' } },
  customer: { id: 'gid://shopify/Customer/7', firstName: 'Ada', lastName: 'Rossi' },
  displayFulfillmentStatus: 'FULFILLED',
  requiresShipping: true,
  shippingAddress: { countryCodeV2: 'IT' },
  totalWeight: '3000',
  metafield: { value: 'Scatola M' },
  fulfillments: Array.from({ length: FULFILLMENTS_FIRST }, () => ({
    status: 'SUCCESS',
    trackingInfo: [{ number: 'BRT1' }],
  })),
  returns: {
    pageInfo: { hasNextPage: true, endCursor: 'r1' },
    nodes: [{ status: 'CLOSED', createdAt: '2026-08-07T00:00:00Z' }],
  },
  shippingLines: { nodes: [{ title: 'Standard', deliveryCategory: 'shipping' }] },
  lineItems: {
    pageInfo: { hasNextPage: true, endCursor: 'l1' },
    nodes: [],
  },
});

/** Risponde a ogni query in base a cosa chiede, e ne tiene il testo. */
function shopifyFinto(query: string): unknown {
  if (/query DrainConnection/.test(query)) {
    const campo = /(lineItems|returns)\(first/.exec(query)?.[1] ?? 'lineItems';
    return ok({ node: { [campo]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
  }
  if (/query OrderFulfillments/.test(query)) return ok({ node: { fulfillments: [] } });
  if (/query OrderShippingFacts/.test(query)) return ok({ nodes: [ordineLungo()] });
  if (/query Orders\(/.test(query)) {
    return ok({ orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ordineLungo()] } });
  }
  if (/query Order\(/.test(query)) return ok({ order: ordineLungo() });
  throw new Error(`query inattesa nel test: ${query.slice(0, 80)}`);
}

let query: string[] = [];

beforeEach(() => {
  query = [];
  // Il client racconta nei log quel che fa (costo delle query, versione
  // dell'API): qui interessa solo cosa chiede.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  global.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const testo = JSON.parse(init?.body ?? '{}').query as string;
    query.push(testo);
    return shopifyFinto(testo);
  }) as unknown as typeof fetch;
});

/** Tutti i campi d'ordine chiesti da ogni strada che legge ordini. */
async function campiChiesti(): Promise<string[]> {
  const client = new ShopifyAPIClient('test.myshopify.com', 'token');
  await client.getOrders({ limit: 1 });
  await client.getOrderById(4242);
  await client.getOrderShippingFacts(['4242']);

  // Le strade devono esserci passate tutte, o il confronto sotto e' su meno
  // di quel che l'app chiede davvero.
  for (const nome of ['Orders(', 'Order(', 'OrderShippingFacts', 'OrderFulfillments', 'DrainConnection']) {
    expect(query.some((q) => q.includes(`query ${nome}`)), nome).toBe(true);
  }

  const campi = query
    .flatMap(campiFoglia)
    .map(dallOrdine)
    .filter((c): c is string => c !== null);
  return [...new Set(campi)].sort();
}

// --- Il contratto -------------------------------------------------------------

describe('il lettore di query', () => {
  it('ricava i percorsi foglia, saltando argomenti e frammenti', () => {
    expect(
      campiFoglia('query X($id: ID!) { node(id: $id) { ... on Order { a b { c(first: 2) { d } } } } }'),
    ).toEqual(['node.a', 'node.b.c.d']);
  });
});

describe('(a) le query degli ordini e (c) l inventario', () => {
  it('ogni campo che l app chiede a Shopify sugli ordini e dichiarato, e niente di dichiarato manca', async () => {
    const chiesti = await campiChiesti();
    const dichiarati = campiGraphqlDichiarati().sort();

    // Chiesto e non dichiarato: un trattamento che i documenti non raccontano.
    expect(chiesti.filter((c) => !dichiarati.includes(c)), 'campi chiesti ma non dichiarati').toEqual([]);
    // Dichiarato e non chiesto: una promessa per un dato che non trattiamo piu'.
    expect(dichiarati.filter((c) => !chiesti.includes(c)), 'campi dichiarati ma non chiesti').toEqual([]);
  });

  it('i campi di spedizione chiesti sono esattamente quelli delle voci logistiche', async () => {
    const chiesti = await campiChiesti();
    const logistici = [
      'requiresShipping',
      'displayFulfillmentStatus',
      'totalWeight',
      'metafield.value',
    ];
    const prefissi = ['shippingAddress.', 'fulfillments.', 'returns.nodes.', 'shippingLines.'];
    const diSpedizione = chiesti.filter((c) => logistici.includes(c) || prefissi.some((p) => c.startsWith(p)));
    const dichiarati = new Set(VOCI_LOGISTICHE.flatMap((v) => v.graphql));

    expect(diSpedizione.filter((c) => !dichiarati.has(c))).toEqual([]);
  });
});

describe('(b) le colonne di orders e (c) l inventario', () => {
  it('ogni colonna della tabella e dichiarata, e ogni colonna dichiarata esiste', () => {
    const dichiarate = colonneDichiarate().sort();
    const vere = [...ORDERS_COLUMN_NAMES].sort();

    expect(vere.filter((c) => !dichiarate.includes(c)), 'colonne non dichiarate').toEqual([]);
    expect(dichiarate.filter((c) => !vere.includes(c)), 'colonne dichiarate che non esistono').toEqual([]);
  });

  it('una voce conservata ha una colonna, una non conservata no', () => {
    for (const voce of INVENTARIO_ORDINI) {
      if (voce.allaCancellazione === 'non_conservato') expect(voce.colonne, voce.id).toEqual([]);
    }
    // I codici di tracciamento non si scrivono da nessuna parte: e' la
    // promessa che l'informativa fa per nome.
    const tracking = INVENTARIO_ORDINI.find((v) => v.id === 'tracking')!;
    expect(tracking.allaCancellazione).toBe('non_conservato');
    expect(ORDERS_COLUMN_NAMES.some((c) => /tracking/i.test(c))).toBe(false);
  });

  it('dell indirizzo di spedizione si chiede e si conserva il solo paese', async () => {
    const chiesti = await campiChiesti();
    expect(chiesti.filter((c) => c.startsWith('shippingAddress.'))).toEqual(['shippingAddress.countryCodeV2']);
    expect(ORDERS_COLUMN_NAMES.filter((c) => /address|city|zip|postcode|street/i.test(c))).toEqual([]);
  });
});

describe('la cancellazione e l inventario', () => {
  it('azzera esattamente le colonne che l inventario dichiara azzerate', () => {
    expect(Object.keys(ANONYMOUS_ORDER).sort()).toEqual(colonneAzzerateAllaCancellazione().sort());
  });
});

// --- I documenti --------------------------------------------------------------

const CARTELLA = join(process.cwd(), 'docs', 'legal');
const leggi = (nome: string) => readFileSync(join(CARTELLA, nome), 'utf-8');

/** Le righe di tabella che cominciano con un'etichetta. */
function rigaDiTabella(testo: string, etichetta: string): string | undefined {
  return testo.split('\n').find((riga) => riga.trim().startsWith(`| ${etichetta} |`));
}

describe('(c) l inventario e i documenti legali', () => {
  const documenti = {
    en: { 'privacy-policy.md': leggi('privacy-policy.md'), 'dpa.md': leggi('dpa.md') },
    it: {
      'privacy-policy.it.md': leggi('privacy-policy.it.md'),
      'dpa.it.md': leggi('dpa.it.md'),
      'protected-customer-data.md': leggi('protected-customer-data.md'),
    },
  } as const;
  const html = leggi('privacy-policy.html');

  it.each(VOCI_LOGISTICHE.map((v) => [v.id, v] as const))(
    '%s compare in ogni documento, con la sua etichetta',
    (_id, voce) => {
      for (const [nome, testo] of Object.entries(documenti.en)) {
        expect(testo, `${nome}: manca «${voce.etichetta.en}»`).toContain(voce.etichetta.en);
      }
      for (const [nome, testo] of Object.entries(documenti.it)) {
        expect(testo, `${nome}: manca «${voce.etichetta.it}»`).toContain(voce.etichetta.it);
      }
      expect(html, `privacy-policy.html: manca «${voce.etichetta.en}»`).toContain(voce.etichetta.en);
    },
  );

  it.each(VOCI_LOGISTICHE.map((v) => [v.id, v] as const))(
    '%s: le tabelle dell informativa e della dichiarazione dicono dove finisce',
    (_id, voce) => {
      const tabelle: Array<[string, string, string, RegExp]> = [
        ['privacy-policy.md', documenti.en['privacy-policy.md'], voce.etichetta.en, /not stored/i],
        ['privacy-policy.it.md', documenti.it['privacy-policy.it.md'], voce.etichetta.it, /non (viene )?conservat/i],
        [
          'protected-customer-data.md',
          documenti.it['protected-customer-data.md'],
          voce.etichetta.it,
          /non (viene )?conservat/i,
        ],
      ];

      for (const [nome, testo, etichetta, nonConservato] of tabelle) {
        const riga = rigaDiTabella(testo, etichetta);
        expect(riga, `${nome}: nessuna riga di tabella per «${etichetta}»`).toBeDefined();
        if (voce.colonne.length === 0) {
          expect(riga, `${nome}: «${etichetta}» deve dirsi non conservato`).toMatch(nonConservato);
        } else {
          for (const colonna of voce.colonne) {
            expect(riga, `${nome}: «${etichetta}» non nomina la colonna ${colonna}`).toContain(`\`${colonna}\``);
          }
        }
      }
    },
  );

  it('nessun documento nega piu il trattamento dei dati di spedizione', () => {
    const negazioni = [
      /no shipping data/i,
      /does not process[^.]*shipping data/i,
      /Nor does it process \*\*shipping data\*\*/i,
      /nessun dato di spedizione/i,
      /non tratta nemmeno \*\*dati di spedizione\*\*/i,
      /dati di spedizione \(nessun corriere/i,
    ];
    const tutti = { ...documenti.en, ...documenti.it, 'privacy-policy.html': html };
    for (const [nome, testo] of Object.entries(tutti)) {
      for (const negazione of negazioni) {
        expect(testo, `${nome}: ${negazione}`).not.toMatch(negazione);
      }
    }
  });
});
