import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// Il giro dell'addebito esce dall'app: il merchant conferma sulla pagina di
// Shopify e torna su /billing/callback con in coda un `charge_id` e nient'altro
// che non ci fossimo scritti da soli. Senza un segno nostro in quella coda, la
// callback non ha modo di sapere QUALE tentativo di sottoscrizione la sta
// chiudendo: vede un id e un negozio, e deve dare per buono che il resto
// combaci.
//
// Qui si prepara quel segno. Un nonce casuale, che finisce sia nella
// querystring di ritorno sia sulla riga del tentativo
// (`billing_charges.callback_nonce`), incastonato in un payload firmato con il
// segreto dell'app insieme a negozio, piano, cifra, valuta e cadenza. Chi torna
// non puo' cambiare nessuna di quelle cose senza rompere la firma, e non puo'
// inventarsi un nonce che corrisponda a un tentativo vero.
//
// Cosa questo state NON e': un'autorizzazione. Il piano si attiva perche'
// Shopify, riletto direttamente, dice che quell'abbonamento e' ACTIVE e porta
// il nome di un piano del listino — non perche' uno state torni indietro.
// Serve a legare la callback al tentativo che l'ha aperta e a far rumore quando
// i due non si somigliano; per questo chi lo verifica non lo tratta mai come un
// permesso da negare, ma come una firma da confrontare.

/**
 * Quanto vale un tentativo.
 *
 * Ventiquattr'ore, non dieci minuti: fra il momento in cui si apre la pagina di
 * approvazione e quello in cui il merchant decide puo' passare mezza giornata —
 * la lascia aperta, chiede a un socio, la riprende la mattina dopo. Uno state
 * scaduto non blocca comunque niente, viene solo registrato come anomalia.
 */
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Il tentativo di sottoscrizione, come lo si porta avanti e indietro. */
export interface BillingAttemptState {
  /** Casuale e monouso: e' il legame con la riga in `billing_charges`. */
  nonce: string;
  /** Il negozio che ha avviato il tentativo. */
  shopDomain: string;
  /** Nome del piano richiesto, esattamente come sta a listino. */
  planName: string;
  /**
   * Il prezzo di LISTINO comunicato a Shopify, non quello che il merchant paga:
   * lo sconto riservato viaggia a parte, e Shopify ci rilegge il listino. E'
   * l'unica delle due cifre confrontabile con quello che l'abbonamento dichiara.
   */
  listPrice: number;
  /** Valuta di quella cifra. */
  currency: string;
  /** Ogni quanto si paga. */
  interval: 'monthly' | 'yearly';
}

interface SignedPayload extends BillingAttemptState {
  /** Scadenza in millisecondi epoch. */
  exp: number;
}

/**
 * Il segreto con cui si firma.
 *
 * E' quello dell'app, lo stesso che valida gli webhook: se manca, l'app non
 * riesce gia' a fare niente di suo: meglio accorgersene qui con un errore
 * chiaro che ritrovarsi uno state che non si verifica mai.
 */
function stateSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error('SHOPIFY_API_SECRET non configurato');
  }
  return secret;
}

function signature(payload: string): string {
  return createHmac('sha256', stateSecret()).update(payload).digest('base64url');
}

/** Un nonce nuovo: 128 bit di casuale, che nessuno indovina a tentativi. */
export function newBillingNonce(): string {
  return randomBytes(16).toString('hex');
}

/** Il tentativo, firmato e pronto da mettere in coda alla URL di ritorno. */
export function signBillingState(
  attempt: BillingAttemptState,
  now: number = Date.now(),
): string {
  const body: SignedPayload = { ...attempt, exp: now + STATE_TTL_MS };
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${payload}.${signature(payload)}`;
}

/**
 * Il tentativo racchiuso nello state, o null se non c'e', non e' firmato da noi
 * o e' scaduto.
 *
 * Null non significa "rifiuta la callback": significa "di questi valori non ci
 * si puo' fidare, quindi non li si usa per niente". Chi chiama registra
 * l'anomalia e continua a fidarsi solo di cio' che risponde Shopify.
 */
export function verifyBillingState(
  state: string | null | undefined,
  now: number = Date.now(),
): BillingAttemptState | null {
  const raw = (state ?? '').trim();
  if (!raw) return null;

  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;

  let expected: string;
  try {
    expected = signature(payload);
  } catch {
    // Segreto mancante: non si puo' verificare niente, ma non e' questo il
    // posto dove far cadere il ritorno di un merchant che ha appena pagato.
    return null;
  }

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  // Il confronto a tempo costante non regge lunghezze diverse: timingSafeEqual
  // lancerebbe, e un'eccezione qui sarebbe gia' mezza risposta a chi tenta.
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Partial<SignedPayload>;

    if (
      typeof parsed.nonce !== 'string' ||
      typeof parsed.shopDomain !== 'string' ||
      typeof parsed.planName !== 'string' ||
      typeof parsed.currency !== 'string' ||
      typeof parsed.listPrice !== 'number' ||
      (parsed.interval !== 'monthly' && parsed.interval !== 'yearly') ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    if (now > parsed.exp) return null;

    return {
      nonce: parsed.nonce,
      shopDomain: parsed.shopDomain,
      planName: parsed.planName,
      listPrice: parsed.listPrice,
      currency: parsed.currency,
      interval: parsed.interval,
    };
  } catch {
    return null;
  }
}
