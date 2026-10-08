// app/lib/integrations/conflicts.server.ts
//
// Risoluzione dei conflitti: lista i conflitti aperti e li risolve singolarmente o
// in blocco. `used_theirs` scrive su Shopify (chi fallisce resta `open`);
// `kept_ours` chiude senza scrivere.

import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { birthdateMetafieldOf } from '~/lib/customers/birthdate-metafield';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { hasCustomerWriteAccess } from '~/lib/sync/customers-write-access';
import { resolveBirthdateTarget } from '~/lib/workers/processors.server';

const MAX_IDS = 250;

export interface ConflictRow {
  customerId: number;
  field: 'birthdate';
  ours: string | null;
  theirs: string;
  provider: 'klaviyo';
}

/**
 * Elenco dei conflitti aperti di un negozio.
 *
 * @param shopId L'ID del negozio
 * @param opts Opzioni di filtro (status: 'open' per i soli aperti)
 */
export async function listConflicts(
  shopId: string,
  opts?: { status?: 'open' },
): Promise<ConflictRow[]> {
  const whereClause: Prisma.IntegrationConflictWhereInput = {
    shopId,
    provider: 'klaviyo',
    targetField: 'birthdate',
    ...(opts?.status === 'open' && { status: 'open' }),
  };

  const conflicts = await prisma.integrationConflict.findMany({
    where: whereClause,
    orderBy: { createdAt: 'desc' },
  });

  return conflicts.map((c) => ({
    customerId: Number(c.customerId),
    field: 'birthdate' as const,
    ours: c.ourValue,
    theirs: c.theirValue,
    provider: 'klaviyo' as const,
  }));
}

/**
 * Risolve i conflitti in blocco.
 *
 * - `kept_ours`: chiude i conflitti senza scrivere niente su Shopify.
 * - `used_theirs`: scrive i valori Klaviyo su Shopify; chi fallisce resta `open`.
 *
 * Gli ID di altri negozi vengono ignorati. Se il negozio non ha accesso in
 * scrittura o non ha un campo configurato, i conflitti `used_theirs` restano
 * `open` e tornano in `notWritten`.
 *
 * @param shopId L'ID del negozio
 * @param customerIds Gli ID dei clienti i cui conflitti vanno risolti (max 250)
 * @param choice 'kept_ours' o 'used_theirs'
 * @returns resolved: numero di conflitti chiusi; notWritten: ID non scritti
 */
export async function resolveConflicts(
  shopId: string,
  customerIds: number[],
  choice: 'kept_ours' | 'used_theirs',
): Promise<{ resolved: number; notWritten: number[] }> {
  if (customerIds.length > MAX_IDS) {
    throw new Error('too many ids');
  }

  if (customerIds.length === 0) {
    return { resolved: 0, notWritten: [] };
  }

  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) {
    return { resolved: 0, notWritten: [] };
  }

  // Leggi i conflitti aperti per questo negozio e questi clienti
  const conflicts = await prisma.integrationConflict.findMany({
    where: {
      shopId,
      provider: 'klaviyo',
      targetField: 'birthdate',
      customerId: { in: customerIds.map(BigInt) },
      status: 'open',
    },
  });

  if (conflicts.length === 0) {
    return { resolved: 0, notWritten: [] };
  }

  const notWritten: number[] = [];

  if (choice === 'kept_ours') {
    // Chiudi i conflitti senza scrivere, ma solo se il valore non e' cambiato
    const now = new Date();
    const updates = await Promise.all(
      conflicts.map((c) =>
        prisma.integrationConflict.updateMany({
          where: {
            id: c.id,
            status: 'open',
            theirValue: c.theirValue,
          },
          data: {
            status: 'kept_ours',
            decidedAt: now,
          },
        }),
      ),
    );

    const resolved = updates.reduce((sum, result) => sum + result.count, 0);
    return { resolved, notWritten: [] };
  }

  // choice === 'used_theirs': scriviamo su Shopify
  const canWrite = hasCustomerWriteAccess(shop.scopes);
  const configured = birthdateMetafieldOf(shop);

  if (!canWrite || !configured) {
    // Nessun accesso in scrittura o campo non configurato: restano aperti
    return {
      resolved: 0,
      notWritten: conflicts.map((c) => Number(c.customerId)),
    };
  }

  const shopify = await ShopifyAPIClient.forShop(shop.shopDomain);
  const target = await resolveBirthdateTarget(shopify, configured, canWrite);

  if (!target) {
    // Campo non scrivibile: restano aperti
    return {
      resolved: 0,
      notWritten: conflicts.map((c) => Number(c.customerId)),
    };
  }

  // Ri-leggi i conflitti per verificare che i valori non siano cambiati
  const freshConflicts = await prisma.integrationConflict.findMany({
    where: {
      id: { in: conflicts.map((c) => c.id) },
      status: 'open',
    },
  });

  // Filtra i conflitti il cui valore e' cambiato
  const unchanged = conflicts.filter((original) => {
    const fresh = freshConflicts.find((f) => f.id === original.id);
    return fresh && fresh.theirValue === original.theirValue;
  });

  if (unchanged.length === 0) {
    // Tutti i valori sono cambiati: nessuno da scrivere
    return {
      resolved: 0,
      notWritten: conflicts.map((c) => Number(c.customerId)),
    };
  }

  // Prepara le scritture solo per i valori invariati
  const entries = unchanged.map((c) => ({
    customerId: Number(c.customerId),
    date: c.theirValue,
  }));

  // Scrivi su Shopify
  const result = await shopify.setCustomerBirthdates(entries, target);

  // Raccogli i falliti
  const failed = new Set(result.failed.map((f) => f.customerId));

  // Chiudi solo i riusciti, condizionale sul valore non cambiato
  const toClose = unchanged.filter((c) => !failed.has(Number(c.customerId)));
  const now = new Date();
  const updates = await Promise.all(
    toClose.map((c) =>
      prisma.integrationConflict.updateMany({
        where: {
          id: c.id,
          status: 'open',
          theirValue: c.theirValue,
        },
        data: {
          status: 'used_theirs',
          decidedAt: now,
        },
      }),
    ),
  );

  const resolved = updates.reduce((sum, result) => sum + result.count, 0);

  // I falliti e i cambiati restano open
  const changed = conflicts.filter(
    (c) => !unchanged.find((u) => u.id === c.id),
  );
  notWritten.push(...result.failed.map((f) => f.customerId));
  notWritten.push(...changed.map((c) => Number(c.customerId)));

  return { resolved, notWritten };
}
