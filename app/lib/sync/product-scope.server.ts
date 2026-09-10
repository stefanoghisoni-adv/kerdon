// app/lib/sync/product-scope.server.ts
//
// Dove l'ambito vive fra una corsa e l'altra.
//
// LA REGOLA CHE QUESTO FILE ESISTE PER FAR RISPETTARE. Una risorsa che esce
// dall'ambito viene MARCATA, mai cancellata. Il caso che questo esclude e'
// preciso e prima era possibile: il merchant passava a un piano piu' piccolo,
// la corsa successiva impaginava fino al tetto nuovo e poi spazzava via tutto
// il resto — dati raccolti in mesi, tolti da una query sola, mentre la pagina
// dei piani prometteva che cambiando piano non si perde niente.
//
// PERCHE' IL REGISTRO SI RISCRIVE INTERO A OGNI CORSA COMPLETA. Perche' e' li'
// che si conosce l'unica cosa da cui l'ambito si puo' dedurre senza indovinare:
// l'elenco completo dei prodotti su Shopify. Una corsa incrementale vede solo
// quel che e' cambiato, quindi puo' aggiungere e aggiornare ma non ridecidere.
//
// PERCHE' NON SI SCRIVE UNA RIGA PER OGNI PRODOTTO DEL NEGOZIO. Perche' un
// prodotto che non e' mai entrato nell'ambito non ha righe da proteggere e non
// ha niente di fermo da dichiarare: e' semplicemente non sincronizzato, e lo
// dice gia' l'avviso del tetto raggiunto. Il registro tiene solo i prodotti di
// cui teniamo dei dati, quindi resta grande quanto il catalogo sincronizzato e
// non quanto il catalogo.

import { prisma } from '~/db.server';
import {
  scopeCounts,
  type ProductScopeReason,
  type ScopeCandidate,
  type ScopeCounts,
} from './product-scope';

/** Una riga del registro come la legge la corsa. */
export interface StoredScopeEntry {
  productId: number;
  sourceCreatedAt: Date | null;
  inScope: boolean;
  reason: ProductScopeReason;
  firstScopedAt: Date;
  lastInScopeAt: Date | null;
}

/**
 * Il registro di un negozio, indicizzato per id di prodotto.
 *
 * Una mappa e non un elenco perche' chi lo usa fa sempre la stessa domanda —
 * "questo prodotto e' dentro?" — una volta per prodotto della pagina, e su un
 * elenco sarebbe una scansione a ogni prodotto.
 */
export async function loadProductScope(
  shopId: string,
): Promise<Map<number, StoredScopeEntry>> {
  const righe = await prisma.productScopeEntry.findMany({
    where: { shopId },
    select: {
      shopifyProductId: true,
      sourceCreatedAt: true,
      inScope: true,
      reason: true,
      firstScopedAt: true,
      lastInScopeAt: true,
    },
  });

  const registro = new Map<number, StoredScopeEntry>();
  for (const riga of righe) {
    const id = Number(riga.shopifyProductId);
    // Un id che non e' un numero non e' un prodotto di Shopify: saltarlo e'
    // meglio che portarsi dietro un NaN che poi finirebbe in una graduatoria.
    if (!Number.isFinite(id)) continue;
    registro.set(id, {
      productId: id,
      sourceCreatedAt: riga.sourceCreatedAt,
      inScope: riga.inScope,
      reason: riga.reason === 'plan_quota' ? 'plan_quota' : 'in_scope',
      firstScopedAt: riga.firstScopedAt,
      lastInScopeAt: riga.lastInScopeAt,
    });
  }
  return registro;
}

/** I candidati come li vuole la graduatoria, ricavati dal registro. */
export function scopeCandidatesOf(
  registro: Map<number, StoredScopeEntry>,
): ScopeCandidate[] {
  return [...registro.values()].map((entry) => ({
    productId: entry.productId,
    createdAt: entry.sourceCreatedAt ? entry.sourceCreatedAt.toISOString() : null,
  }));
}

/** Cosa la corsa ha deciso per un prodotto. */
export interface ScopeWrite {
  productId: number;
  createdAt?: string | null;
  inScope: boolean;
  reason: ProductScopeReason;
  /**
   * Vero se in questa corsa la risorsa e' stata davvero riscritta: solo allora
   * `last_in_scope_at` avanza. Una risorsa dentro l'ambito ma non toccata (il
   * delta non l'ha riportata) non e' stata aggiornata, e dire il contrario
   * falserebbe proprio il numero che l'interfaccia mostra per non spacciare per
   * fresco un dato vecchio.
   */
  written: boolean;
}

/**
 * Scrive nel registro l'esito di una corsa.
 *
 * Un upsert per risorsa e non una cancellazione seguita da un inserimento: fra
 * le due ci sarebbe un istante in cui il negozio non ha niente di fermo, e in
 * quell'istante l'interfaccia direbbe che va tutto bene.
 *
 * `firstScopedAt` si scrive solo alla creazione: e' da quando il merchant ha
 * quei dati, e riscriverla a ogni corsa la ridurrebbe a una copia di
 * `lastCheckedAt`.
 */
export async function recordProductScope(opts: {
  shopId: string;
  writes: readonly ScopeWrite[];
  now: Date;
}): Promise<void> {
  if (opts.writes.length === 0) return;

  // A blocchi, e non una riga per volta: un negozio che scende di piano ne ha
  // qualche migliaio da riclassificare, e qualche migliaio di andate e ritorno
  // verso un database remoto e' la differenza fra una corsa e un timeout.
  const BLOCCO = 200;
  for (let i = 0; i < opts.writes.length; i += BLOCCO) {
    const blocco = opts.writes.slice(i, i + BLOCCO);
    await prisma.$transaction(
      blocco.map((write) => {
        const createdAt = write.createdAt ? new Date(write.createdAt) : null;
        const sourceCreatedAt =
          createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null;

        return prisma.productScopeEntry.upsert({
          where: {
            shopId_shopifyProductId: {
              shopId: opts.shopId,
              shopifyProductId: String(write.productId),
            },
          },
          create: {
            shopId: opts.shopId,
            shopifyProductId: String(write.productId),
            sourceCreatedAt,
            inScope: write.inScope,
            reason: write.reason,
            firstScopedAt: opts.now,
            lastCheckedAt: opts.now,
            lastInScopeAt: write.written ? opts.now : null,
          },
          update: {
            sourceCreatedAt,
            inScope: write.inScope,
            reason: write.reason,
            lastCheckedAt: opts.now,
            ...(write.written ? { lastInScopeAt: opts.now } : {}),
          },
        });
      }),
    );
  }
}

/**
 * Toglie dal registro quel che questa corsa non ha piu' trovato.
 *
 * Si potano per data di verifica e non per elenco: l'elenco di cio' che resta
 * dentro puo' essere di decine di migliaia di id, e una condizione "non fra
 * questi" con decine di migliaia di valori non e' una query, e' un incidente.
 * Chi e' stato classificato in questa corsa porta la sua data; chi non l'ha
 * portano via da qui.
 *
 * Si chiama SOLO dopo un'impaginazione arrivata in fondo: dopo una corsa
 * interrotta, "non l'ho trovato" vuol dire "non l'ho cercato", e potare su
 * quella base cancellerebbe l'ambito di prodotti vivi.
 */
export async function pruneProductScope(shopId: string, before: Date): Promise<void> {
  await prisma.productScopeEntry.deleteMany({
    where: { shopId, lastCheckedAt: { lt: before } },
  });
}

/**
 * Toglie dal registro i prodotti che non ci sono piu'.
 *
 * "Fuori quota" e "non esiste piu'" sono due cose diverse, e questa e' la
 * seconda: una risorsa cancellata su Shopify non deve restare a occupare un
 * posto in graduatoria, altrimenti tiene fuori dall'ambito un prodotto vivo per
 * sempre.
 */
export async function forgetProductScope(
  shopId: string,
  productIds: readonly (number | string)[],
): Promise<void> {
  if (productIds.length === 0) return;
  await prisma.productScopeEntry.deleteMany({
    where: {
      shopId,
      shopifyProductId: { in: productIds.map((id) => String(id)) },
    },
  });
}

/**
 * Quante righe si aggiornano, quante sono ferme, e da quando.
 *
 * E' cio' che l'interfaccia mostra, e la ragione per cui i due numeri restano
 * separati: sommarli rimetterebbe insieme le due cose che tutto questo lavoro
 * serve a distinguere.
 */
export async function productScopeSummary(shopId: string): Promise<ScopeCounts> {
  const righe = await prisma.productScopeEntry.findMany({
    where: { shopId },
    select: { shopifyProductId: true, inScope: true, lastInScopeAt: true },
  });

  return scopeCounts(
    righe.map((riga) => ({
      productId: Number(riga.shopifyProductId),
      inScope: riga.inScope,
      lastInScopeAt: riga.lastInScopeAt,
    })),
  );
}
