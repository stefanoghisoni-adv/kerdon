// app/lib/shipping/packaging-store.server.ts
//
// Leggere e riscrivere categorie e regole di imballo di un negozio, per le
// modifiche di una riga alla volta (vedi components/Shipping/packaging-edit).
//
// Si legge con la stessa lettura difensiva del calcolo dei costi, cosi' una
// voce rovinata nel JSON non blocca le modifiche alle altre; si riscrivono solo
// categorie e regole, e peso di default e costo dei resi restano quelli che
// sono (hanno il loro salvataggio).

import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { validateCategories, validateFallbackRules } from './load-config.server';
import type { FallbackRule, PackagingCategory } from './types';

export interface StoredPackaging {
  categories: PackagingCategory[];
  rules: FallbackRule[];
}

export async function readPackaging(shopId: string): Promise<StoredPackaging> {
  const config = await prisma.packagingConfig.findUnique({
    where: { shopId },
    select: { categories: true, fallbackRules: true },
  });
  return {
    categories: validateCategories(config?.categories),
    rules: validateFallbackRules(config?.fallbackRules),
  };
}

export async function writePackaging(shopId: string, value: StoredPackaging): Promise<void> {
  const data = {
    categories: value.categories as unknown as Prisma.InputJsonValue,
    fallbackRules: value.rules as unknown as Prisma.InputJsonValue,
  };
  await prisma.packagingConfig.upsert({
    where: { shopId },
    create: { shopId, ...data },
    update: data,
  });
}
