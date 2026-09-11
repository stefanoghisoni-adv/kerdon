// e2e/server/clock.ts
//
// L'orologio del server di prova, spostabile a comando.
//
// PERCHE' UN ORROLOGIO FINTO ANCHE QUI. Meta' delle regole che valgono la pena
// di essere provate sono regole sul tempo: una prova che scade, una copia dei
// dati che dopo la sua finestra non si consegna piu', un ritentativo che non
// riparte prima del suo distanziamento. Provarle aspettando davvero vorrebbe
// dire prove che durano giorni; provarle scrivendo date gia' vecchie nel
// database vorrebbe dire provare una situazione che nel sistema vero non si
// forma mai — si arriva a "scaduto" restandoci dentro, non nascendoci.
//
// Qui si sposta l'orologio, e il codice dell'app attraversa la scadenza come la
// attraverserebbe di suo.
//
// SOLO NEL PROCESSO DI PROVA. Questo file non e' importato da niente che vada
// in produzione: lo carica `main.ts`, che gira solo sotto Playwright.

let scarto = 0;

/** L'istante a cui il server crede di essere. */
export function now(): Date {
  return new Date(Date.now());
}

/**
 * Sostituisce `Date` con una che porta lo scarto corrente.
 *
 * Si tocca la classe globale e non si passa un'ora in giro per i parametri
 * perche' il codice dell'app chiama `new Date()` in centinaia di punti, e
 * riscriverli tutti per i test significherebbe provare un codice diverso da
 * quello che va online.
 *
 * I timer restano quelli veri: spostarli farebbe scadere i tempi massimi delle
 * prove invece delle scadenze dell'applicazione.
 */
export function installShiftableClock(): void {
  const Originale = Date;

  class DataSpostata extends Originale {
    // `unknown[]` e una sola chiamata a `super`: vedi la stessa nota in
    // `e2e/harness/clock.ts`.
    constructor(...args: unknown[]) {
      super(
        args.length === 0
          ? Originale.now() + scarto
          : (Reflect.construct(Originale, args) as Date).getTime(),
      );
    }

    static override now(): number {
      return Originale.now() + scarto;
    }
  }

  globalThis.Date = DataSpostata as unknown as DateConstructor;
}

/** Sposta l'orologio in avanti di tanti millisecondi. */
export function advanceBy(ms: number): void {
  scarto += ms;
}

/** Rimette l'orologio sull'ora vera: e' cio' che fa l'azzeramento fra due prove. */
export function resetClock(): void {
  scarto = 0;
}

/** Di quanto e' avanti, in millisecondi. Serve a raccontarlo nelle diagnosi. */
export function currentShift(): number {
  return scarto;
}
