// app/lib/gdpr/steps.ts
//
// Il vocabolario comune delle richieste GDPR: com'e' andato un passo, e come si
// legge la risposta di un database per deciderlo.
//
// Sta in un file suo per una ragione sola, ed e' meccanica: l'inventario dei
// dati personali (customer-record.server) ha bisogno del grafo delle identita'
// (identity-graph.server), e il grafo ha bisogno di questi tipi. Tenerli
// nell'inventario avrebbe chiuso un cerchio fra i due moduli — il tipo di
// errore che in ESM non esplode subito, esplode a caso, dentro un test che con
// il GDPR non c'entra niente.

/**
 * Cos'e' successo a una tabella. Una richiesta GDPR e' fatta di piu' passi su
 * database diversi, e l'unica risposta onesta e' l'elenco di come e' andato
 * ognuno: e' quello che finisce nella traccia di controllo, ed e' quello che
 * decide se rispondere "fatto" oppure no.
 */
export interface GdprStep {
  /** Nome della tabella nel database, come si chiama davvero. */
  table: string;
  /**
   * 'deleted'    righe cancellate
   * 'anonymized' righe rimaste, riferimento alla persona rimosso
   * 'read'       righe lette per comporre l'esportazione
   * 'skipped'    niente da fare qui, e il perche' sta in `detail`
   * 'failed'     non riuscito: la richiesta NON e' completa
   */
  outcome: 'deleted' | 'anonymized' | 'read' | 'skipped' | 'failed';
  /** Quante righe sono state toccate, o lette. */
  rows: number;
  /** Il perche', quando l'esito da solo non basta a capirlo. */
  detail?: string;
}

/**
 * Basta un passo fallito perche' la richiesta sia fallita.
 *
 * E' la regola che impedisce a una cancellazione parziale di passare per
 * riuscita: se la tabella clienti si e' svuotata ma gli ordini portano ancora
 * il nome della persona, quello che e' successo non e' un erasure.
 */
export function stepsFailed(steps: GdprStep[]): boolean {
  return steps.some((step) => step.outcome === 'failed');
}

/** Riassunto leggibile dei soli passi andati male. */
export function failureMessage(steps: GdprStep[]): string {
  return steps
    .filter((step) => step.outcome === 'failed')
    .map((step) => `${step.table}: ${step.detail ?? 'errore sconosciuto'}`)
    .join('; ');
}

export interface QueryError {
  message?: string;
  code?: string;
}

/**
 * La tabella non c'e'.
 *
 * Succede per davvero e non e' un guasto: gli ordini esistono solo se il
 * negozio ci ha dato il permesso di leggerli, i clienti solo se il piano li
 * include, e il grafo dei browser solo dai collegamenti abbastanza recenti da
 * averlo nella DDL. Una tabella che non e' mai stata creata non contiene dati
 * della persona, quindi non c'e' niente da cancellare e la richiesta non deve
 * fallire per questo. Ogni altro errore, invece, e' un fallimento vero.
 */
export function isTableMissing(error: QueryError | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const message = error.message ?? '';
  // 42P01 e' l'"undefined_table" di Postgres; PGRST205 e' il modo in cui l'API
  // REST dice che la tabella non e' nella sua copia dello schema.
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /does not exist|could not find the table/i.test(message)
  );
}

export function toStep(
  table: string,
  done: GdprStep['outcome'],
  result: { error?: QueryError | null; count?: number | null },
): GdprStep {
  if (result.error) {
    if (isTableMissing(result.error)) {
      return {
        table,
        outcome: 'skipped',
        rows: 0,
        detail: 'tabella non presente in questo progetto',
      };
    }
    return {
      table,
      outcome: 'failed',
      rows: 0,
      detail: result.error.message ?? result.error.code ?? 'errore sconosciuto',
    };
  }
  return { table, outcome: done, rows: result.count ?? 0 };
}
