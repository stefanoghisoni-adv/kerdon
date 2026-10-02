/**
 * Quanto ha impiegato ogni fase di una risposta.
 *
 * Finisce nell'header `Server-Timing`, che gli strumenti per sviluppatori del
 * browser mostrano accanto alla richiesta: si legge da produzione senza
 * aggiungere log e senza toccare la pagina. Contiene solo nomi di fase e
 * millisecondi, niente che riguardi il negozio.
 *
 * Le fasi che finiscono dopo la risposta (i dati che arrivano in un secondo
 * momento) non possono stare nell'header, gia' partito: per quelle c'e'
 * `summary()`, da scrivere nei log quando tutto e' arrivato.
 */
export class ServerTiming {
  private readonly entries: { name: string; ms: number }[] = [];

  record(name: string, ms: number): void {
    this.entries.push({ name, ms });
  }

  /** Esegue `work` e ne registra la durata, anche quando fallisce. */
  async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await work();
    } finally {
      this.record(name, Date.now() - start);
    }
  }

  header(): string {
    return this.entries.map((e) => `${e.name};dur=${round(e.ms)}`).join(', ');
  }

  summary(): string {
    return this.entries.map((e) => `${e.name}=${round(e.ms)}ms`).join(' ');
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
