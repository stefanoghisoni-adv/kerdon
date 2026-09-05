// scripts/consent-replay.ts
//
// Il comando di replay delle revoche del tracciamento ferme.
//
//   npm run consent:replay              elenca cosa e' fermo, senza toccare niente
//   npm run consent:replay -- --tutti   rimette in lavorazione tutto
//   npm run consent:replay -- <id> ...  rimette in lavorazione solo quelle
//
// Esiste per lo stesso motivo dei tre gemelli sulla coda, sulle riparazioni e
// sui webhook, ma qui la posta e' diversa: quello che e' fermo non e' un lavoro
// nostro, e' il no di una persona che non abbiamo ancora applicato. Nessuno
// tornera' a chiederlo — il cookie e' scaduto il primo giorno, e da quel browser
// non arrivera' mai piu' una seconda revoca.
//
// COSA NON SI VEDE, ed e' voluto: il soggetto. Sta cifrato sulla riga e non
// esce da qui. Un elenco di revoche che stampa gli identificativi delle persone
// che hanno revocato sarebbe il modo piu' elegante di non aver revocato niente.
//
// L'elenco e' il comportamento di default di proposito: si guarda prima di
// rimettere in lavorazione, non dopo.

import {
  listDeadRevocations,
  replayDeadRevocations,
} from '../app/lib/consent/revocation-register.server';

async function main(): Promise<void> {
  const argomenti = process.argv.slice(2);
  const tutti = argomenti.includes('--tutti') || argomenti.includes('--all');
  const ids = argomenti.filter((a) => !a.startsWith('--'));

  const ferme = await listDeadRevocations();

  if (ferme.length === 0) {
    console.log('Nessuna revoca del tracciamento in lettera morta.');
    return;
  }

  console.log(`In lettera morta: ${ferme.length}\n`);
  for (const riga of ferme) {
    console.log(
      `  ${riga.id}  ${riga.scope}  negozio ${riga.shopId ?? 'sconosciuto'}` +
        `  tentativi ${riga.attempts}  ${riga.requestedAt.toISOString()}`,
    );
    if (riga.lastError) console.log(`      ${riga.lastError}`);
    if (riga.subjectPurgedAt) {
      // Senza soggetto non c'e' piu' niente da rigiocare: resta solo la prova
      // che la revoca era stata chiesta. Dirlo qui evita di far credere che un
      // `--tutti` la riprenda.
      console.log('      soggetto gia\' potato: non ripetibile, resta la sola prova');
    }
  }

  if (!tutti && ids.length === 0) {
    console.log(
      '\nNiente e\' stato rimesso in lavorazione. Per farlo: --tutti, oppure gli id da riprendere.',
    );
    return;
  }

  const rimesse = await replayDeadRevocations(tutti ? undefined : ids);
  console.log(`\nRimesse in lavorazione: ${rimesse}.`);
  console.log('Le riprende il prossimo giro del cron.');
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
