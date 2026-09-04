// app/lib/supabase/managed-resources.server.ts
// Il registro di proprieta': chi ha creato quale tabella nel database del
// merchant, scritto quando la risposta e' ancora conoscibile.
//
// Il momento e' uno solo ed e' il collegamento: prima di eseguire la DDL si
// guarda quali tabelle ci sono gia', e quelle nascono nel registro come NON
// nostre. Dopo la DDL la domanda non ha piu' risposta — CREATE TABLE IF NOT
// EXISTS non dice se ha creato o trovato, e una tabella presente non racconta
// chi l'ha fatta.
//
// Perche' importa: `products` e' un nome che chiunque userebbe per il proprio
// catalogo. Senza registro, "elimina le tabelle che l'app ha creato" diventava
// "elimina le tabelle che l'app userebbe", che su un progetto pre-esistente e'
// un'altra cosa.

import { prisma } from '~/db.server';
import { MERCHANT_TABLE_NAMES } from '~/lib/supabase-schema';
import { isSafeIdentifier } from './identifiers';
import type { ManagedResource } from './managed-resources';

/** Lo schema in cui la DDL lavora. Unico, oggi. */
export const MERCHANT_SCHEMA = 'public';

export interface RecordProvisionedResourcesInput {
  shopId: string;
  projectRef: string;
  /** Le tabelle che la DDL appena eseguita si prefiggeva di garantire. */
  provisioned: readonly string[];
  /** Quelle che esistevano gia' PRIMA della DDL: sono del merchant. */
  preExisting: readonly string[];
  schemaVersion: number;
}

/**
 * Registra chi possiede cosa, dopo una DDL di collegamento.
 *
 * Due regole, e la seconda conta piu' della prima:
 *
 *  - una tabella che non c'era e ora c'e' e' nostra;
 *  - una proprieta' gia' registrata come nostra NON si declassa mai.
 *
 * La seconda esiste perche' il collegamento si rifa': alla riconnessione le
 * nostre tabelle risultano "gia' presenti", ed e' vero — le avevamo create noi
 * il giro prima. Senza questa regola ogni riconnessione ce le farebbe
 * dimenticare, e l'eliminazione non troverebbe piu' niente da eliminare.
 *
 * Il verso opposto invece si concede: una tabella registrata come del merchant
 * che al giro dopo non esiste piu' (l'ha cancellata lui) e che la nostra DDL
 * ricrea, da quel momento e' nostra.
 *
 * Best effort a carico del chiamante: il collegamento e' gia' riuscito quando
 * si arriva qui, e un errore nello scrivere il registro non deve farlo fallire.
 */
export async function recordProvisionedResources(
  input: RecordProvisionedResourcesInput,
): Promise<void> {
  const preExisting = new Set(input.preExisting.map((t) => t.toLowerCase()));

  // I nomi che non sarebbero identificatori leciti non entrano nemmeno nel
  // registro: il registro e' cio' da cui un giorno nascera' un DROP, e un nome
  // che non potra' mai essere eliminato in sicurezza e' meglio non prometterlo.
  const names = input.provisioned.filter((n) => isSafeIdentifier(n));

  const existing = await prisma.supabaseManagedResource.findMany({
    where: { shopId: input.shopId, projectRef: input.projectRef },
  });
  const known = new Map(existing.map((r) => [`${r.schemaName}.${r.resourceName}`, r]));

  for (const name of names) {
    const key = `${MERCHANT_SCHEMA}.${name}`;
    const ours = !preExisting.has(name.toLowerCase());
    const row = known.get(key);

    if (!row) {
      await prisma.supabaseManagedResource.create({
        data: {
          shopId: input.shopId,
          projectRef: input.projectRef,
          schemaName: MERCHANT_SCHEMA,
          resourceName: name,
          resourceKind: 'table',
          createdByCoreWard: ours,
          schemaVersion: input.schemaVersion,
        },
      });
      continue;
    }

    if (row.createdByCoreWard || !ours) continue;

    await prisma.supabaseManagedResource.update({
      where: { id: row.id },
      data: { createdByCoreWard: true, schemaVersion: input.schemaVersion },
    });
  }
}

/**
 * Le risorse che possiamo eliminare: solo quelle marcate come nostre.
 *
 * Una tabella senza riga nel registro non e' nostra per definizione. E' la
 * lettura conservativa, ed e' voluta: il costo di sbagliare nei due versi non
 * e' lo stesso — non eliminare una nostra tabella lascia dello spazio occupato
 * in un database del merchant, eliminare una sua tabella gli porta via i dati.
 */
export async function ownedResources(
  shopId: string,
  projectRef: string,
): Promise<ManagedResource[]> {
  const rows = await prisma.supabaseManagedResource.findMany({
    where: { shopId, projectRef, createdByCoreWard: true },
  });
  return rows.map((r) => ({
    schemaName: r.schemaName,
    resourceName: r.resourceName,
    resourceKind: 'table' as const,
  }));
}

/**
 * Le tabelle di cui chiedere l'esistenza prima di eseguire la DDL del
 * collegamento.
 *
 * Sono tutte quelle che l'app sa creare, non solo quelle che creera' stavolta:
 * un piano che oggi non prevede i clienti potrebbe prevederli domani, e la
 * risposta a "la sua `customers` c'era gia'?" va presa adesso, mentre e' ancora
 * vera.
 */
export function tablesToProbe(): string[] {
  return [...MERCHANT_TABLE_NAMES];
}
