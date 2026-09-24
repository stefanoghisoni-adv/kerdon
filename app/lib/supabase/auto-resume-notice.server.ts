// app/lib/supabase/auto-resume-notice.server.ts
//
// "Abbiamo riacceso noi il tuo database": il punto in cui glielo si dice.
//
// OGGI L'AVVISO E' IN-APP, ed e' il banner del database in pausa — lo stesso,
// con il testo che cambia perche' a premere il pulsante non e' stato il
// merchant. Resta warning per tutta la durata: finche' il database non risponde
// la sincronizzazione e' ferma e i numeri che il merchant guarda sono vecchi.
// Non e' una bella notizia con un lieto fine, e' un problema in corso di cui
// abbiamo tolto la parte irreversibile.
//
// PERCHE' QUESTA FUNZIONE ESISTE LO STESSO, se oggi non manda niente. Perche'
// l'avviso che conta davvero e' quello che raggiunge il merchant che NON apre
// l'app — che e' esattamente quello a cui il database e' stato messo in pausa.
// Il giorno in cui ci sara' un provider email, l'invio va scritto qui dentro e
// in nessun altro posto: questa e' gia' la sola chiamata sul percorso, riceve
// gia' tutto quel che servirebbe, e viene gia' fatta una volta per
// riattivazione e non una per giro del cron.
//
// COSA SERVIREBBE PER L'EMAIL, in concreto:
//   1. un provider (una dipendenza nuova, che oggi non c'e' e non si aggiunge)
//      e le sue credenziali fra le variabili d'ambiente;
//   2. un indirizzo a cui scrivere. L'app non lo conserva: va letto dall'admin
//      di Shopify (`shop.email` / `shop.customerEmail`) al momento dell'invio,
//      non copiato in una colonna — un indirizzo copiato invecchia e diventa
//      un'email che non arriva a nessuno;
//   3. una traccia di "gia' inviata", per non riscrivere a ogni giro del cron:
//      c'e' gia', ed e' `auto_resumed_at` sulla riga di questo negozio;
//   4. il testo, nei due file i18n accanto a quello del banner, nella lingua
//      che il merchant ha scelto nelle Impostazioni.
//
// Cio' che NON servirebbe: un'altra decisione. Se si arriva qui, la
// riattivazione e' stata chiesta ed e' stata accettata.

/** Quel che l'avviso deve sapere, oggi come il giorno in cui partira' un'email. */
export interface AutoResumeNotice {
  shopId: string;
  shopDomain: string;
  /** Quando la riattivazione e' stata chiesta e accettata. */
  at: Date;
  /** Da quanto il database non dava prova di vita, se lo sappiamo. */
  fermoDaMs: number | null;
}

/**
 * Registra che il merchant va avvisato — e, oggi, lo avvisa in-app.
 *
 * L'avviso a schermo non parte da qui: lo fa il banner leggendo lo stato del
 * database, dove sta gia' scritto che a chiedere la riattivazione e' stata
 * l'app. Qui resta la riga di log, che e' l'unica traccia consultabile finche'
 * l'email non c'e' — e serve a rispondere alla domanda "a quanti merchant e'
 * successo davvero?", che e' quella che dira' se l'email valga la pena.
 */
export async function notifyAutoResume(notice: AutoResumeNotice): Promise<void> {
  const fermoDaGiorni =
    notice.fermoDaMs === null ? 'ignoto' : Math.floor(notice.fermoDaMs / 86_400_000);
  console.warn(
    '[auto-resume] database riacceso dall’app:',
    JSON.stringify({
      shopId: notice.shopId,
      shopDomain: notice.shopDomain,
      at: notice.at.toISOString(),
      fermoDaGiorni,
    }),
  );
}
