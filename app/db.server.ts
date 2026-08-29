import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient;

declare global {
  var __db__: PrismaClient;
}

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient();
} else {
  if (!global.__db__) {
    global.__db__ = new PrismaClient();
  }
  prisma = global.__db__;
}

// Niente `$connect()` all'importazione.
//
// Prima c'era, senza `await` e senza `catch`: una promise lasciata in volo che,
// se il database non risponde, diventa un rifiuto non gestito. Nei test —
// dove un database non c'e' affatto — le asserzioni passavano tutte e poi il
// processo usciva con codice 1 comunque, per quel rifiuto. Un cancello di
// rilascio che dice rosso quando il codice e' verde e' peggio di nessun
// cancello: si impara a ignorarlo.
//
// Non serviva nemmeno: Prisma si collega da solo alla prima interrogazione, e
// lo fa aspettandola come si deve.

export { prisma };
