// scripts/webhooks-replay.ts
//
// Il comando di replay dei webhook amministrativi fermi.
//
//   npm run webhooks:replay              elenca cosa e' fermo, senza toccare niente
//   npm run webhooks:replay -- --tutti   rimette in lavorazione tutto
//   npm run webhooks:replay -- <id> ...  rimette in lavorazione solo quelli
//
// Esiste per lo stesso motivo dei due gemelli sulla coda e sulle riparazioni: un
// evento che ha fallito cinque volte smette di riprovarci da solo — ed e'
// giusto, perche' ritentare in eterno vuol dire che non se ne accorge nessuno —
// ma da quel momento nessuno lo applichera' mai, e Shopify non lo rimandera'.
// Quel che resta e' questa riga.
//
// L'elenco e' il comportamento di default di proposito: si guarda prima di
// rimettere in lavorazione, non dopo.

import {
  listDeadWebhookEvents,
  replayDeadWebhookEvents,
} from '../app/lib/webhooks/inbox.server';

async function main(): Promise<void> {
  const argomenti = process.argv.slice(2);
  const tutti = argomenti.includes('--tutti') || argomenti.includes('--all');
  const ids = argomenti.filter((a) => !a.startsWith('--'));

  const fermi = await listDeadWebhookEvents();

  if (fermi.length === 0) {
    console.log('Nessun webhook amministrativo in lettera morta.');
    return;
  }

  console.log(`In lettera morta: ${fermi.length}\n`);
  for (const riga of fermi) {
    console.log(
      `  ${riga.id}  ${riga.topic}  negozio ${riga.shopDomain}` +
        `  tentativi ${riga.attempts}  ${riga.receivedAt.toISOString()}`,
    );
    if (riga.lastError) console.log(`      ${riga.lastError}`);
  }

  if (!tutti && ids.length === 0) {
    console.log(
      '\nNiente e\' stato rimesso in lavorazione. Per farlo: --tutti, oppure gli id da riprendere.',
    );
    return;
  }

  const rimessi = await replayDeadWebhookEvents(tutti ? undefined : ids);
  console.log(`\nRimessi in lavorazione: ${rimessi}.`);
  console.log('Li riprende il prossimo giro del cron.');
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
