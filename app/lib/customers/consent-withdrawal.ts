import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Cosa succede a un cliente quando ritira il consenso al marketing.
 *
 * **Non si cancella niente.** I dati gia' sincronizzati restano nel database del
 * merchant esattamente com'erano: nome, email, telefono, indirizzo, data di
 * nascita, il legame con il browser. Cambia una cosa sola, e da quella dipende
 * tutto il resto: `accepts_marketing` va a `false`.
 *
 * IL PERCHE' DELLA SCELTA. Il database e' del merchant, non nostro, e quei dati
 * sono i suoi: cancellarli sarebbe rispondere a una richiesta di cancellazione,
 * che e' un'altra cosa e ha un'altra procedura (i webhook di conformita', che
 * cancellano davvero e ovunque). Un cliente che si disiscrive dalle
 * comunicazioni non ha chiesto di sparire dagli archivi del negozio.
 *
 * QUELLO CHE CAMBIA E' L'USO, NON LA CONSERVAZIONE. Da quel momento:
 *
 *  - la sincronizzazione non aggiorna piu' quella riga: resta la fotografia del
 *    giorno in cui il consenso c'era ancora, e non se ne aggiunge altra;
 *  - il proxy di lettura rifiuta di servirla. Chi prova a leggerla per il
 *    tracciamento si sente rispondere che quella persona al marketing non ha
 *    acconsentito, e non ottiene nessun dato. E' quel rifiuto — non la
 *    cancellazione — a impedire che il dato venga usato per cio' che la persona
 *    ha revocato.
 *
 * Per questo `accepts_marketing` e' l'unica colonna che si tocca: e' quella su
 * cui il proxy decide. Toccarne altre non aggiungerebbe protezione e toglierebbe
 * al merchant dei dati che nessuno gli ha chiesto di togliere.
 *
 * (Una versione precedente svuotava le colonne identificative. E' stata
 * rovesciata su decisione del proprietario del progetto: la conservazione dopo
 * una disiscrizione e' una scelta di prodotto, non una conseguenza tecnica.)
 */

/**
 * L'unica scrittura che una revoca comporta.
 *
 * Nessun'altra colonna: la riga resta com'e'. E funziona anche sulle tabelle
 * nate da versioni precedenti, che potrebbero non avere tutte le colonne di
 * oggi — questa c'e' da sempre, perche' e' quella su cui si decide.
 */
export const WITHDRAWN_CUSTOMER_FIELDS = { accepts_marketing: false } as const;

interface WriteResult {
  error: { message: string; code?: string } | null;
  count?: number | null;
}

/**
 * Marca come non consenzienti i clienti indicati.
 *
 * Non crea righe: su un cliente mai sincronizzato e' un'operazione a vuoto, ed
 * e' giusto cosi' — di chi non abbiamo mai scritto non c'e' niente da marcare.
 */
export async function withdrawConsentFor(
  supabase: SupabaseClient,
  customersTable: string,
  customerIds: readonly (string | number)[],
): Promise<{ error: { message: string; code?: string } | null }> {
  if (customerIds.length === 0) return { error: null };

  // Il tipo del costruttore di query di Supabase, ridotto ai due metodi che
  // servono: tenerlo intero qui dentro faceva esplodere l'inferenza, e non
  // aggiungeva niente — l'una o l'altra forma del filtro e' tutto cio' che
  // cambia fra un cliente solo e una corsa periodica.
  const filter = supabase
    .from(customersTable)
    .update(WITHDRAWN_CUSTOMER_FIELDS) as unknown as {
    eq: (column: string, value: string | number) => PromiseLike<WriteResult>;
    in: (column: string, values: readonly (string | number)[]) => PromiseLike<WriteResult>;
  };

  const result = await (customerIds.length === 1
    ? filter.eq('shopify_customer_id', customerIds[0])
    : filter.in('shopify_customer_id', customerIds));

  return { error: result.error };
}
