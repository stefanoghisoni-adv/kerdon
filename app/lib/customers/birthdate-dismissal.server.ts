// app/lib/customers/birthdate-dismissal.server.ts
//
// Per quale campo il merchant ha chiuso l'avviso della data di nascita.
//
// PERCHE' NON PIU' NEL BROWSER. Ci stava, e non ha retto due volte per due
// ragioni diverse. La prima e' che `localStorage` appartiene all'indirizzo da
// cui la pagina arriva: quando l'app e' passata da `api.coreward.app` a
// `api.kerdon.io` la memoria di cio' che era stato chiuso e' rimasta
// sull'altro dominio, e l'avviso e' tornato su. La seconda e' strutturale:
// dentro l'admin l'app vive in un iframe di un'altra origine, quindi quello e'
// storage di terze parti — Safari lo blocca, Chrome lo partiziona. Il commento
// che c'era diceva che un avviso che ricompare e' "il male minore": in un'app
// embedded non e' il caso raro, e' la condizione normale, e il merchant si
// ritrovava un avviso che non riusciva piu' a chiudere.
//
// Una preferenza espressa con un gesto esplicito — "non mostrarmelo piu'" —
// non puo' vivere in un posto che cambia con l'indirizzo o che il browser puo'
// rifiutare.

import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';

/**
 * La tabella non c'e' ancora.
 *
 * Le migrazioni di questo progetto le lancia una persona, a mano, su Live e su
 * Test, e fra il rilascio del codice e quel momento la tabella non esiste. Non
 * e' un guasto: e' una finestra prevista, e si attraversa senza rumore.
 *
 * `P2021` e' la tabella mancante, `P2022` la colonna. Il controllo sul
 * messaggio copre i casi in cui l'errore arriva da sotto senza codice — vale
 * come rete, non come primo riconoscimento.
 */
function tabellaAssente(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return e.code === 'P2021' || e.code === 'P2022';
  }
  return e instanceof Error && /does not exist|relation .* does not exist/i.test(e.message);
}

/**
 * Per quale campo l'avviso risulta chiuso, o `null` se non risulta chiuso.
 *
 * QUANDO NON SI PUO' SAPERE si risponde con il campo stesso, cioe' "chiuso".
 * E' una scelta, e va spiegata: le due strade sbagliate non sono simmetriche.
 * Rispondere "non chiuso" terrebbe acceso un avviso che il merchant non puo'
 * spegnere — la chiusura andrebbe a scrivere sulla stessa tabella che non c'e'
 * — e nasconderebbe la card dei campi aggiuntivi, che compare solo quando
 * l'avviso tace: un guasto invisibile si porterebbe via una funzione.
 * Rispondendo "chiuso" si perde una conferma, che e' una cortesia, e si tiene
 * la funzione, che e' il lavoro.
 *
 * @param configured il campo in uso oggi, per intero (`facts.birth_date`)
 */
export async function birthdateNoticeDismissedFor(
  shopId: string,
  configured: string,
): Promise<string | null> {
  try {
    const riga = await prisma.birthdateNoticeDismissal.findUnique({
      where: { shopId },
      select: { dismissedFor: true },
    });
    return riga?.dismissedFor ?? null;
  } catch (e) {
    if (tabellaAssente(e)) return configured;
    // Un intoppo diverso — il database owner irraggiungibile per un istante —
    // non e' una ragione per cambiare quello che il merchant vede. Vale la
    // stessa risposta prudente, e si lascia traccia perche' questo ramo non
    // dovrebbe capitare.
    console.warn(
      '[birthdate-dismissal] lettura non riuscita:',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return configured;
  }
}

/**
 * Segna che l'avviso e' stato chiuso per questo campo.
 *
 * Si sovrascrive invece di accumulare: e' l'ultima chiusura, non uno storico.
 * Il valore e' IL CAMPO e non un si'/no, perche' cambiando il campo da cui si
 * legge la data di nascita c'e' una conferma nuova da dare — un "non mostrare
 * piu'" secco avrebbe zittito anche quella.
 *
 * Risponde se ha potuto scrivere. Chi chiama lo dice al merchant: far credere
 * che un "non mostrarmelo piu'" sia stato registrato quando non lo e' sarebbe
 * il peggiore degli esiti, perche' l'avviso tornerebbe e nessuno saprebbe
 * perche'.
 */
export async function dismissBirthdateNotice(
  shopId: string,
  configured: string,
): Promise<boolean> {
  try {
    await prisma.birthdateNoticeDismissal.upsert({
      where: { shopId },
      create: { shopId, dismissedFor: configured },
      update: { dismissedFor: configured },
    });
    return true;
  } catch (e) {
    if (!tabellaAssente(e)) {
      console.error(
        '[birthdate-dismissal] scrittura non riuscita:',
        e instanceof Error ? e.message : 'errore sconosciuto',
      );
    }
    return false;
  }
}
