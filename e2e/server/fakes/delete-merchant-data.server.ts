// e2e/server/fakes/delete-merchant-data.server.ts
//
// L'eliminazione dei dati dal database del merchant, finta. Prende il posto di
// `~/lib/supabase/delete-merchant-data.server` nel solo server di prova.
//
// PERCHE' SI FINGE PROPRIO QUESTA. Dietro c'e' un DROP TABLE su un progetto
// Supabase vero, chiesto con un gettone vero. Non e' una cosa che si prova
// contro un servizio: e' la cosa che non si prova mai contro un servizio.
//
// COSA RESTA VERO. Tutto quello che la rotta fa INTORNO a questa chiamata, che
// e' esattamente cio' che le prove devono verificare: che a esito fallito le
// credenziali NON vengano cancellate — sono l'unica cosa con cui il merchant
// puo' riprovare — che a esito riuscito lo scollegamento vada fino in fondo, e
// che una seconda richiesta ravvicinata riceva 409 senza ripetere niente.
//
// Il conteggio delle chiamate serve proprio all'ultima: "non ripete niente" e'
// una frase che senza un numero non si puo' provare.

import { stato } from './state';
import { prisma } from '~/db.server';
import type { DeleteMerchantDataResult } from '~/lib/supabase/delete-merchant-data.server';

export async function deleteMerchantData(shopId: string): Promise<DeleteMerchantDataResult> {
  const s = stato();
  s.eliminazioniChieste += 1;
  const preparato = s.eliminazione;

  // A verifica riuscita il modulo vero ha GIA' tolto token, configurazione e
  // registro — e' scritto nel commento della rotta, che infatti da li' in poi
  // non cancella piu' niente. Il finto deve fare altrettanto: se si limitasse a
  // restituire 'completed' lasciando le credenziali al loro posto, la rotta
  // sembrerebbe sbagliata e la prova inseguirebbe un difetto che non esiste.
  if (preparato.status === 'completed') {
    await prisma.supabaseOAuthToken.deleteMany({ where: { shopId } });
    await prisma.supabaseConfig.deleteMany({ where: { shopId } });
  }

  return {
    status: preparato.status,
    attempted: preparato.attempted ?? [],
    remaining: preparato.remaining ?? [],
    retryable: preparato.retryable ?? true,
    error: preparato.error,
  };
}
