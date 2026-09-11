// e2e/harness/clock.ts
//
// L'orologio del banco di prova, fermo dove lo si mette.
//
// PERCHE' SERVE. Il selettore del periodo non mostra un calendario qualunque:
// mostra i due mesi che finiscono sull'oggi, offre "Ieri", "Mese scorso" e i
// trimestri contati a partire da adesso, e spegne tutto cio' che sta nel
// futuro. Ogni singola asserzione su quale mese si veda, su quale giorno sia
// selezionato o su quale casella sia disabilitata dipende da che giorno e'.
//
// Con l'orologio vero quelle prove sarebbero verdi oggi e rosse domani — e
// rosse in un modo particolarmente odioso: non subito, ma il primo del mese, o
// a capodanno, o l'unica settimana dell'anno in cui il Black Friday cade prima
// dell'ultimo venerdi'. Una prova che cambia esito senza che nessuno tocchi il
// codice non e' una prova: e' un calendario.
//
// COSA SI FERMA, E COSA NO. Si sostituisce `Date`, e con lei `Date.now()`: e'
// da li' che passa tutto quello che l'app chiama "oggi". NON si toccano i
// timer — `setTimeout` e compagnia restano quelli veri — perche' servono a
// Polaris e a React per funzionare, e fermarli bloccherebbe la pagina invece
// di renderla prevedibile.

/**
 * Installa un'ora fissa al posto di quella di sistema.
 *
 * Va chiamata PRIMA che React renda qualunque cosa: un componente che ha gia'
 * letto l'ora vera non la rilegge, e resterebbe ancorato al giorno sbagliato
 * per tutta la prova.
 */
export function freezeClock(isoInstant: string): void {
  const fisso = new Date(isoInstant).getTime();
  if (Number.isNaN(fisso)) {
    throw new Error(`istante non leggibile: ${isoInstant}`);
  }

  const Originale = Date;

  // La classe sostitutiva estende quella vera: cosi' `instanceof Date`, i
  // metodi di formattazione e il passaggio a Intl continuano a funzionare
  // come prima. Cambia una cosa sola — cosa succede quando non si passa
  // nessun argomento, che e' esattamente il modo in cui si chiede "adesso".
  class DataFerma extends Originale {
    // `unknown[]` e una sola chiamata a `super`: con la firma vera di Date
    // TypeScript restringe `args` a una tupla e considera impossibile il
    // confronto con zero, e `super(...args)` non compila comunque perche' Date
    // ha piu' firme. La costruzione con argomenti passa dalla classe vera e se
    // ne copia l'istante.
    constructor(...args: unknown[]) {
      super(args.length === 0 ? fisso : (Reflect.construct(Originale, args) as Date).getTime());
    }

    static override now(): number {
      return fisso;
    }
  }

  globalThis.Date = DataFerma as unknown as DateConstructor;
}
