// app/lib/ingest/ingest-body.server.ts
//
// Il corpo di una richiesta di scrittura, letto senza fidarsi della sua taglia.
//
// COSA C'ERA PRIMA, in una riga: `await request.json()`. Una riga sola che fa
// tre cose senza chiedere permesso per nessuna — scarica tutto quello che
// arriva, lo tiene in memoria e poi ci passa sopra un parser ricorsivo. Su una
// rotta pubblica che chiunque puo' chiamare, quelle tre cose sono tre modi
// diversi di far cadere un'istanza con una richiesta sola.
//
// I DUE TETTI, e perche' servono tutti e due.
//
// IL PRIMO E' SUI BYTE, e si applica PRIMA di aver finito di leggere. Non basta
// leggere tutto e poi misurare: a quel punto i cinquanta megabyte sono gia' in
// memoria, e il rifiuto arriva dopo il danno. Qui si legge a pezzi e ci si
// ferma appena il totale supera il tetto — quel che resta sul filo non viene
// nemmeno raccolto.
//
// `Content-Length`, quando c'e', si guarda per primo: e' un risparmio, non una
// garanzia. Chi manda un corpo enorme puo' dichiararne uno piccolo, o non
// dichiararne affatto (`Transfer-Encoding: chunked`), quindi il conto vero si
// fa comunque mentre si legge. Fidarsi di quell'intestazione e basta vorrebbe
// dire aver messo un tetto che si scavalca dicendo un numero.
//
// IL SECONDO E' SULLA PROFONDITA', e si applica PRIMA del parse. E' il tetto
// che quello sui byte non copre: `[[[[[[…]]]]]]` sta comodo in sedici kilobyte
// e porta dentro decine di migliaia di livelli di annidamento, che su un parser
// ricorsivo sono decine di migliaia di frame di stack. Si conta sul testo,
// scorrendolo una volta sola, e solo se il conto sta dentro si chiama
// `JSON.parse`. Contarla dopo vorrebbe dire contarla quando il parse e' gia'
// avvenuto — cioe' non contarla.
//
// L'IMPRONTA SI CALCOLA QUI, ed e' l'altro motivo per cui questo modulo
// restituisce il TESTO e non solo l'oggetto. La firma copre il corpo esatto che
// e' arrivato: ricalcolare l'impronta da un oggetto gia' parsato e riserializzato
// darebbe una stringa diversa — le chiavi in un altro ordine, gli spazi persi —
// e una firma che non torna mai.

import { createHash } from 'crypto';
import { MAX_INGEST_BODY_BYTES, MAX_INGEST_JSON_DEPTH, jsonDepthWithin } from './ingest-model';

export type BodyRefusal =
  /** Oltre il tetto dei byte, dichiarato o misurato. */
  | 'too_large'
  /** Annidato oltre il tetto: rifiutato senza essere parsato. */
  | 'too_deep'
  /** Non e' JSON, o non e' un oggetto. */
  | 'malformed';

export type BoundedBody =
  | { ok: true; raw: string; digest: string; json: Record<string, unknown> }
  | { ok: false; refusal: BodyRefusal };

/**
 * L'impronta del corpo, come entra nella stringa firmata.
 *
 * Il corpo vuoto ha comunque un'impronta — quella della stringa vuota — e non
 * un valore speciale: una richiesta senza corpo deve poter essere firmata come
 * tutte le altre, e un caso a parte qui sarebbe un ramo in piu' da tenere
 * d'accordo fra chi firma e chi verifica.
 */
export function bodyDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('base64url');
}

/**
 * Legge il corpo con i due tetti, e lo parsa solo se li rispetta.
 *
 * Restituisce un rifiuto invece di sollevare: chi chiama e' una rotta pubblica,
 * e i tre casi qui sotto sono tre risposte diverse — non tre guasti.
 */
export async function readBoundedJsonBody(
  request: Request,
  limits: { maxBytes?: number; maxDepth?: number } = {},
): Promise<BoundedBody> {
  const maxBytes = limits.maxBytes ?? MAX_INGEST_BODY_BYTES;
  const maxDepth = limits.maxDepth ?? MAX_INGEST_JSON_DEPTH;

  // Il risparmio: se chi chiama dichiara gia' una taglia fuori misura si chiude
  // qui, senza leggere niente. Una dichiarazione onesta e' la norma; una
  // disonesta la scopre il conto vero qui sotto.
  const dichiarata = Number(request.headers.get('content-length'));
  if (Number.isFinite(dichiarata) && dichiarata > maxBytes) {
    return { ok: false, refusal: 'too_large' };
  }

  const letto = await readAtMost(request, maxBytes);
  if (letto === null) return { ok: false, refusal: 'too_large' };

  // Prima del parse, sempre. E' l'unico ordine che conti qualcosa.
  if (!jsonDepthWithin(letto, maxDepth)) return { ok: false, refusal: 'too_deep' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(letto);
  } catch {
    return { ok: false, refusal: 'malformed' };
  }

  // Un array o un numero al posto dell'oggetto non e' "quasi giusto": le rotte
  // che chiamano qui leggono chiavi per nome, e su un valore che chiavi non ne
  // ha leggerebbero `undefined` ovunque — cioe' andrebbero avanti con un corpo
  // vuoto invece di rifiutarlo.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, refusal: 'malformed' };
  }

  return {
    ok: true,
    raw: letto,
    digest: bodyDigest(letto),
    json: parsed as Record<string, unknown>,
  };
}

/**
 * Il corpo, fino al tetto e non oltre. `null` se lo supera.
 *
 * Si legge a pezzi dal flusso e si conta in BYTE, non in caratteri: una `è` e'
 * un carattere e due byte, e un tetto contato sui caratteri lascerebbe passare
 * il doppio della roba a chi scrive in una lingua accentata — o in emoji, dove
 * il fattore e' quattro.
 *
 * Il ripiego su `text()` serve a chi ci arriva con una richiesta costruita a
 * mano senza flusso: li' il corpo e' gia' tutto in memoria e il tetto non
 * protegge piu' niente, ma la misura si fa lo stesso — se non altro perche' il
 * rifiuto resti quello giusto invece di dipendere da come e' fatta la richiesta.
 */
async function readAtMost(request: Request, maxBytes: number): Promise<string | null> {
  const body = request.body;
  if (!body) {
    const testo = await request.text();
    return Buffer.byteLength(testo, 'utf8') > maxBytes ? null : testo;
  }

  const reader = body.getReader();
  const pezzi: Uint8Array[] = [];
  let totale = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totale += value.byteLength;
      if (totale > maxBytes) {
        // Si smette di leggere davvero: `cancel` dice al mittente che il resto
        // non serve, invece di scaricarlo per buttarlo via.
        await reader.cancel().catch(() => undefined);
        return null;
      }
      pezzi.push(value);
    }
  } catch {
    // Un flusso che si interrompe a meta' e' un corpo che non c'e': lo tratta
    // come tale chi chiama, con lo stesso rifiuto di un JSON illeggibile.
    return '';
  }

  return Buffer.concat(pezzi.map((p) => Buffer.from(p))).toString('utf8');
}
