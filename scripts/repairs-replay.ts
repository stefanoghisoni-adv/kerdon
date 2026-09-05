// scripts/repairs-replay.ts
//
// Il comando di replay delle riparazioni ferme.
//
//   npm run repairs:replay              elenca cosa e' fermo, senza toccare niente
//   npm run repairs:replay -- --tutti   rimette in lavorazione tutto
//   npm run repairs:replay -- <id> ...  rimette in lavorazione solo quelli
//
// Esiste per lo stesso motivo del gemello sulla coda: una risorsa che ha
// fallito cinque volte smette di riprovarci da sola — ed e' giusto, perche'
// ritentare in eterno vuol dire che non se ne accorge nessuno — ma da quel
// momento il confine incrementale non la aspetta piu', e senza un modo di
// rimetterla in lavorazione resterebbe disallineata per sempre.
//
// L'elenco e' il comportamento di default di proposito: si guarda prima di
// rimettere in lavorazione, non dopo.

import { listDeadRepairs, replayDeadRepairs } from '../app/lib/sync/repair-outbox.server';

async function main(): Promise<void> {
  const argomenti = process.argv.slice(2);
  const tutte = argomenti.includes('--tutti') || argomenti.includes('--all');
  const ids = argomenti.filter((a) => !a.startsWith('--'));

  const ferme = await listDeadRepairs();

  if (ferme.length === 0) {
    console.log('Nessuna riparazione in lettera morta.');
    return;
  }

  console.log(`In lettera morta: ${ferme.length}\n`);
  for (const riga of ferme) {
    console.log(
      `  ${riga.id}  ${riga.resourceType} ${riga.resourceId} (${riga.operation})` +
        `  negozio ${riga.shopId}  tentativi ${riga.attempts}  ${riga.updatedAt.toISOString()}`,
    );
    if (riga.lastError) console.log(`      ${riga.lastError}`);
  }

  if (!tutte && ids.length === 0) {
    console.log(
      '\nNiente e\' stato rimesso in lavorazione. Per farlo: --tutti, oppure gli id da riprendere.',
    );
    return;
  }

  const rimesse = await replayDeadRepairs(tutte ? undefined : ids);
  console.log(`\nRimesse in lavorazione: ${rimesse}.`);
  console.log(
    'Le riprende la prossima sincronizzazione del negozio: quelle che il delta ' +
      'riporta tenendo indietro il confine, le altre rispingendole all\'inizio della corsa.',
  );
}

main()
  .catch((error) => {
    console.error('Replay non riuscito:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Il client Prisma tiene aperto il processo: senza questo il comando finisce
    // e resta li' a guardare.
    process.exit(process.exitCode ?? 0);
  });
