// scripts/queue-replay.ts
//
// Il comando di replay della lettera morta.
//
//   npm run queue:replay              elenca cosa e' fermo, senza toccare niente
//   npm run queue:replay -- --tutti   rimette in coda tutto
//   npm run queue:replay -- <id> ...  rimette in coda solo quelli
//
// Esiste perche' la lettera morta senza un modo di uscirne e' un cestino. Un
// lavoro che ha fallito cinque volte smette di riprovarci da solo — ed e'
// giusto, perche' ritentare in eterno vuol dire che non se ne accorge nessuno —
// ma dopo che la causa e' stata aggiustata qualcuno deve poterlo far ripartire
// senza scrivere una UPDATE a mano su un database di produzione.
//
// L'elenco e' il comportamento di default di proposito: si guarda prima di
// rimettere in coda, non dopo.

import { listDeadLetters, replayDeadLetters } from '../app/lib/queue/queue-store.server';

async function main(): Promise<void> {
  const argomenti = process.argv.slice(2);
  const tutti = argomenti.includes('--tutti') || argomenti.includes('--all');
  const ids = argomenti.filter((a) => !a.startsWith('--'));

  const ferme = await listDeadLetters();

  if (ferme.length === 0) {
    console.log('Nessuna richiesta in lettera morta.');
    return;
  }

  console.log(`In lettera morta: ${ferme.length}\n`);
  for (const riga of ferme) {
    console.log(
      `  ${riga.id}  ${riga.type}${riga.shopId ? `  negozio ${riga.shopId}` : ''}` +
        `  tentativi ${riga.attempts}  ${riga.updatedAt.toISOString()}`,
    );
    if (riga.lastError) console.log(`      ${riga.lastError}`);
  }

  if (!tutti && ids.length === 0) {
    console.log(
      '\nNiente e\' stato rimesso in coda. Per farlo: --tutti, oppure gli id da riprendere.',
    );
    return;
  }

  const rimesse = await replayDeadLetters(tutti ? undefined : ids);
  console.log(`\nRimesse in coda: ${rimesse}.`);
  console.log(
    'Le lavora il prossimo drenaggio: in locale il worker, in produzione il cron ' +
      '(o una chiamata a /api/cron/sync).',
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
