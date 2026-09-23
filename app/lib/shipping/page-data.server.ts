// app/lib/shipping/page-data.server.ts
//
// I dati della pagina Spedizioni: zone con tariffe e configurazione packaging.
//
// Sta fuori dalla rotta per poter provare il caso che conta: le tabelle owner
// non ancora create. Le migrazioni del DB owner le lancia una persona, a mano,
// su Live e su Test, e fra il rilascio del codice e quel momento le tabelle non
// esistono. Non e' un guasto ma una finestra prevista: la pagina si apre vuota,
// come per un negozio che non ha ancora importato niente, invece di un 500.

import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { validateCategories, validateFallbackRules } from './load-config.server';
import type { FallbackRule, PackagingCategory } from './types';

export interface ShippingPageZone {
  id: string;
  zoneName: string;
  countries: string[];
  restOfWorld: boolean;
  rateType: 'linear' | 'brackets';
  rates: Array<{ id: string; weightFromKg: number | null; weightToKg: number | null; cost: number }>;
}

export interface ShippingPagePackaging {
  categories: PackagingCategory[];
  fallbackRules: FallbackRule[];
  defaultWeightPerItemKg: number | null;
  returnCost: number | null;
  /** Cambia a ogni salvataggio: rimonta la card con i valori appena scritti. */
  configKey: string;
}

export const EMPTY_PACKAGING: ShippingPagePackaging = {
  categories: [],
  fallbackRules: [],
  defaultWeightPerItemKg: null,
  returnCost: null,
  configKey: 'empty',
};

/**
 * La tabella o la colonna non c'e' ancora (P2021 / P2022).
 *
 * Stesso riconoscimento di `birthdate-dismissal.server.ts`: il codice di
 * Prisma prima, il messaggio solo come rete per gli errori che arrivano da
 * sotto senza codice.
 */
function tabellaAssente(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return e.code === 'P2021' || e.code === 'P2022';
  }
  return e instanceof Error && /relation .* does not exist/i.test(e.message);
}

export async function loadShippingPageData(
  shopId: string,
): Promise<{ zones: ShippingPageZone[]; packaging: ShippingPagePackaging }> {
  try {
    const [zones, packagingConfig] = await Promise.all([
      prisma.shippingZone.findMany({
        where: { shopId },
        include: { rates: true },
        orderBy: { zoneName: 'asc' },
      }),
      prisma.packagingConfig.findUnique({ where: { shopId } }),
    ]);

    return {
      zones: zones.map((zone) => ({
        id: zone.id,
        zoneName: zone.zoneName,
        countries: zone.countries,
        restOfWorld: zone.restOfWorld,
        rateType: zone.rateType as 'linear' | 'brackets',
        rates: zone.rates.map((rate) => ({
          id: rate.id,
          weightFromKg: rate.weightFrom != null ? Number(rate.weightFrom) : null,
          weightToKg: rate.weightTo != null ? Number(rate.weightTo) : null,
          cost: Number(rate.cost),
        })),
      })),
      packaging: packagingConfig
        ? {
            categories: validateCategories(packagingConfig.categories),
            fallbackRules: validateFallbackRules(packagingConfig.fallbackRules),
            defaultWeightPerItemKg:
              packagingConfig.defaultWeightPerItem != null ? Number(packagingConfig.defaultWeightPerItem) : null,
            returnCost: packagingConfig.returnCost != null ? Number(packagingConfig.returnCost) : null,
            configKey: packagingConfig.updatedAt.toISOString(),
          }
        : EMPTY_PACKAGING,
    };
  } catch (error) {
    // Senza rumore nei log: e' la finestra prevista fra rilascio e migrazione,
    // e la migrazione stessa la chiude.
    if (tabellaAssente(error)) return { zones: [], packaging: EMPTY_PACKAGING };
    throw error;
  }
}
