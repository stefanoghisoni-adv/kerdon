// Applicazione del limite di clienti per piano.
//
// I piani definiscono `maxCustomers` (Basic 0, Growth 250, Scale 500,
// Core/Lifetime = null → illimitato; il listino sta in
// app/lib/billing/plan-tiers.ts). E' lo specchio di product-limit.ts e della
// graduatoria di app/lib/sync/product-scope.ts, con le stesse regole:
//
// COSA SI CONTA. I clienti IDONEI gia' sincronizzati — le righe della tabella
// clienti del merchant con `accepts_marketing = true` — non i clienti di
// Shopify. Chi non ha dato il consenso non entra mai (vedi
// isCustomerOptedIn), quindi non occupa posti; chi lo ritira resta nella
// tabella marcato e libera il suo posto.
//
// CHI ENTRA SOTTO IL TETTO. La stessa graduatoria dei prodotti: dal piu'
// vecchio al piu' recente per data di creazione su Shopify, a parita' l'id
// piu' basso. Un cliente nuovo non scalza uno che c'era gia', e due corse con
// lo stesso piano scelgono lo stesso insieme comunque arrivino le pagine.
//
// IL REGISTRO E' LA TABELLA. Per i prodotti l'ambito vive in un registro sul
// database dell'applicazione; per i clienti no, e di proposito: il database del
// merchant contiene gia' esattamente l'insieme da contare, e la graduatoria e'
// totale, quindi "i primi N fra quelli presenti + quelli appena letti" da' lo
// stesso risultato a ogni corsa senza tenere una copia degli id da nessun'altra
// parte.
//
// AL CAMBIO DI PIANO. Come per i prodotti, il tetto decide chi CONTINUA a
// essere aggiornato, non chi esiste: scendendo di piano nessuna riga viene
// cancellata. I primi N continuano ad aggiornarsi, gli altri restano fermi
// dov'erano. Le revoche del consenso invece si applicano sempre, anche fuori
// quota: sono una protezione, non un aggiornamento.

import { createScopeSelector, type ScopeCandidate } from '~/lib/sync/product-scope';

/** Un cliente ridotto a cio' che serve a metterlo in graduatoria. */
export interface CustomerRankEntry {
  id: number;
  /** `created_at` come lo scrive Shopify, o come lo restituisce il database. */
  createdAt?: string | null;
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/;

/**
 * La chiave di graduatoria di una data di creazione.
 *
 * La colonna `created_at` della tabella clienti e' TIMESTAMP senza fuso:
 * Postgres scarta lo scostamento e conserva l'ora come scritta da Shopify. Per
 * confrontare un cliente appena letto da Shopify con uno riletto dal database
 * bisogna quindi leggere la stessa cosa da entrambe le parti: data e ora,
 * senza fuso e senza frazioni. Confrontate come testo hanno l'ordine del tempo.
 *
 * Data assente o illeggibile vale stringa vuota, cioe' "vecchissimo" — la
 * stessa scelta dei prodotti: trattarlo come nuovo lo butterebbe fuori a ogni
 * corsa.
 */
export function customerRankKey(createdAt: string | null | undefined): string {
  if (!createdAt) return '';
  const match = WALL_CLOCK.exec(createdAt);
  return match ? `${match[1]}T${match[2]}` : '';
}

function candidateOf(entry: CustomerRankEntry): ScopeCandidate {
  return { productId: entry.id, createdAt: customerRankKey(entry.createdAt) };
}

/** La quota clienti mentre la corsa scorre le pagine. */
export interface CustomerQuota {
  /** True se il cliente sta dentro il tetto e va scritto. */
  admit(entry: CustomerRankEntry): boolean;
  /** Gli id dentro il tetto, in graduatoria. */
  chosenIds(): number[];
  /** Posti liberi; `null` quando il piano non ha tetto. */
  remaining(): number | null;
}

/**
 * La quota, partendo da chi e' gia' sincronizzato.
 *
 * `seed` sono i clienti idonei gia' presenti nel database del merchant. Basta
 * passare i primi `limit` in graduatoria: chi sta oltre non potrebbe comunque
 * rientrare fra i primi N dell'insieme completo.
 */
export function createCustomerQuota(
  limit: number | null | undefined,
  seed: readonly CustomerRankEntry[] = [],
): CustomerQuota {
  const selector = createScopeSelector(limit, seed.map(candidateOf));
  return {
    admit: (entry) => selector.offer(candidateOf(entry)).admitted,
    chosenIds: () => selector.chosen().map((c) => c.productId),
    remaining: () => selector.remaining(),
  };
}

/** True se, con `synced` clienti idonei gia' presenti, il tetto e' raggiunto. */
export function isCustomerLimitReached(
  synced: number,
  limit: number | null | undefined,
): boolean {
  if (limit == null) return false;
  return synced >= limit;
}

/** Quanti clienti si aggiornano e quanti sono fermi, sul totale consentito. */
export interface CustomerQuotaStatus {
  /** Clienti idonei presenti nel database del merchant. */
  synced: number;
  /** Tetto del piano; `null` = illimitato. */
  limit: number | null;
  /** Quanti continuano ad aggiornarsi. */
  active: number;
  /** Quanti restano fermi perche' oltre il tetto (dopo un cambio di piano). */
  paused: number;
}

export function customerQuotaStatus(
  synced: number,
  limit: number | null | undefined,
): CustomerQuotaStatus {
  const totale = Math.max(0, Math.trunc(Number(synced)) || 0);
  const tetto = limit == null ? null : Math.max(0, limit);
  const active = tetto == null ? totale : Math.min(totale, tetto);
  return { synced: totale, limit: tetto, active, paused: totale - active };
}
