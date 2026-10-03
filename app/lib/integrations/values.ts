/**
 * Lettura dei valori da Klaviyo e decisione su cosa fare quando differiscono.
 *
 * Le date arrivano in formati diversi — `YYYY-MM-DD` da Shopify, `DD/MM/YYYY` o
 * `MM/DD/YYYY` da Klaviyo — e la decisione ("chi vince" quando non combaciano)
 * dipende da cosa e' successo prima: se il merchant ha gia' deciso, quella
 * decisione resta.
 */

export type DateFormat = 'auto' | 'DMY' | 'MDY' | 'YMD';

export type ParsedDate =
  | { ok: true; date: string /* YYYY-MM-DD */ }
  | { ok: false; reason: 'empty' | 'invalid' | 'ambiguous' };

/**
 * Converte una data grezza in formato ISO, o spiega perche' non e' riuscita.
 *
 * **Regole:**
 * - `null`, `''`, stringhe di soli spazi → `empty`
 * - ISO (`YYYY-MM-DD` o `YYYY-MM-DDTHH:mm:ss...`) → sempre ok
 * - Con separatori (`/.-`) e anno a 4 cifre → usa il formato dato
 * - `auto`: se i primi due numeri sono entrambi ≤12 e diversi → `ambiguous`
 * - Anno a 2 cifre → `invalid`
 * - Data inesistente (30 febbraio) → `invalid`
 * - Anno < 1900 o nel futuro → `invalid`
 * - Numeri, oggetti, qualunque altra cosa → `invalid`
 */
export function parseDate(raw: unknown, format: DateFormat): ParsedDate {
  // null, undefined, stringhe vuote
  if (raw == null) return { ok: false, reason: 'empty' };
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' };

  const text = raw.trim();
  if (!text) return { ok: false, reason: 'empty' };

  // ISO: YYYY-MM-DD o YYYY-MM-DDTHH:mm:ss...
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return validateAndFormat(year, month, day);
  }

  // Con separatori: DD/MM/YYYY, MM/DD/YYYY, YYYY/MM/DD
  const separated = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (separated) {
    const [, first, second, year] = separated;

    if (format === 'DMY') {
      return validateAndFormat(year, second, first);
    }
    if (format === 'MDY') {
      return validateAndFormat(year, first, second);
    }

    // auto: prova a dedurre
    const f = Number(first);
    const s = Number(second);

    // Entrambi ≤12 e diversi → ambiguo
    if (f <= 12 && s <= 12 && f !== s) {
      return { ok: false, reason: 'ambiguous' };
    }

    // Primo >12 → DMY
    if (f > 12) {
      return validateAndFormat(year, second, first);
    }

    // Secondo >12 → MDY
    if (s > 12) {
      return validateAndFormat(year, first, second);
    }

    // Entrambi uguali o entrambi ≤12 con uno == s → usa DMY come default
    return validateAndFormat(year, second, first);
  }

  // YYYY/MM/DD (anno per primo)
  const yearFirst = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (yearFirst) {
    const [, year, month, day] = yearFirst;
    return validateAndFormat(year, month, day);
  }

  return { ok: false, reason: 'invalid' };
}

/**
 * Valida che la data esista davvero e sia nell'intervallo accettabile.
 */
function validateAndFormat(
  year: string,
  month: string,
  day: string
): ParsedDate {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  // Anno a 2 cifre (sarebbe < 1000)
  if (year.length !== 4) {
    return { ok: false, reason: 'invalid' };
  }

  // Anno < 1900
  if (y < 1900) {
    return { ok: false, reason: 'invalid' };
  }

  // Anno nel futuro (usa UTC per evitare dipendenze dal fuso orario)
  const currentYear = new Date().getUTCFullYear();
  if (y > currentYear) {
    return { ok: false, reason: 'invalid' };
  }

  // Mese o giorno fuori range
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return { ok: false, reason: 'invalid' };
  }

  // Verifica che la data esista davvero (30 febbraio → invalid)
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return { ok: false, reason: 'invalid' };
  }

  // Formato ISO con padding
  const formatted = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { ok: true, date: formatted };
}

/**
 * Rileva il formato di una serie di date campione.
 *
 * Se almeno un campione e' inequivocabile (primo o secondo numero >12), usa
 * quel formato. Altrimenti, se tutti i campioni sono ambigui o vuoti, torna
 * `ambiguous: true`.
 */
export function detectFormat(
  samples: readonly unknown[]
): { format: DateFormat; ambiguous: boolean } {
  if (samples.length === 0) {
    return { format: 'auto', ambiguous: true };
  }

  const formats: DateFormat[] = [];

  for (const sample of samples) {
    if (sample == null || typeof sample !== 'string') continue;

    const text = sample.trim();
    if (!text) continue;

    // ISO → YMD
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(text)) {
      formats.push('YMD');
      continue;
    }

    // YYYY/MM/DD o YYYY.MM.DD → YMD
    if (/^\d{4}[-/.]/.test(text)) {
      formats.push('YMD');
      continue;
    }

    // DD/MM/YYYY o MM/DD/YYYY
    const separated = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
    if (separated) {
      const f = Number(separated[1]);
      const s = Number(separated[2]);

      if (f > 12) {
        formats.push('DMY');
      } else if (s > 12) {
        formats.push('MDY');
      }
      // Se entrambi ≤12, non contribuisce alla decisione
    }
  }

  if (formats.length === 0) {
    return { format: 'auto', ambiguous: true };
  }

  // Controlla se c'e' consenso
  const first = formats[0];
  const allSame = formats.every((f) => f === first);

  if (allSame) {
    return { format: first, ambiguous: false };
  }

  // Formati contrastanti → ambiguo
  return { format: 'auto', ambiguous: true };
}

export type Decision = 'fill' | 'same' | 'conflict' | 'decided';

/**
 * Normalizza una data in formato ISO (YYYY-MM-DD).
 *
 * Accetta:
 * - 'YYYY-MM-DD' (ISO, gia' normalizzato)
 * - 'YYYYMMDD' (formato compatto del database merchant)
 *
 * Restituisce `null` se il formato non e' riconoscibile o la data non e' valida.
 */
function normalizeToISO(value: string): string | null {
  const text = value.trim();
  if (!text) return null;

  // Gia' in formato ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  // Formato compatto (YYYYMMDD)
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }

  return null;
}

/**
 * Decide cosa fare quando il valore nel nostro database e quello di Klaviyo
 * non combaciano.
 *
 * **Formati accettati:**
 * - `ours`: 'YYYY-MM-DD' (ISO) o 'YYYYMMDD' (formato merchant)
 * - `theirs`: 'YYYY-MM-DD' (ISO)
 * - `prior.theirValue`: 'YYYY-MM-DD' (ISO)
 *
 * Entrambi i valori vengono normalizzati a ISO prima del confronto. Un valore
 * `ours` non parsabile e' trattato come riempito-ma-diverso: diventa un
 * conflitto, mai una sovrascrittura silenziosa.
 *
 * **Regole:**
 * - `ours` vuoto (null o '') → `fill` (Klaviyo riempie il buco)
 * - Uguali (dopo normalizzazione) → `same`
 * - `prior` non `open` e `prior.theirValue === theirs` → `decided` (merchant
 *   ha gia' scelto, e Klaviyo non e' cambiato: vale ancora quella scelta)
 * - Altrimenti → `conflict` (serve una decisione nuova)
 */
export function decide(
  ours: string | null,
  theirs: string,
  prior: { status: 'open' | 'kept_ours' | 'used_theirs'; theirValue: string } | null
): Decision {
  // Vuoto → riempi
  if (!ours || ours.trim() === '') return 'fill';

  // Normalizza entrambi i lati per confrontare come con come
  const oursNormalized = normalizeToISO(ours);
  const theirsNormalized = normalizeToISO(theirs);

  // ours non parsabile → e' riempito ma diverso, quindi conflitto
  if (!oursNormalized) return 'conflict';

  // Uguali → nessun conflitto
  if (oursNormalized === theirsNormalized) return 'same';

  // Decisione gia' presa e Klaviyo non e' cambiato → vale ancora
  if (prior && prior.status !== 'open' && prior.theirValue === theirs) {
    return 'decided';
  }

  // Altrimenti e' un conflitto (nuovo o riaperto)
  return 'conflict';
}

/**
 * Converte una data ISO nel formato compatto del database del merchant.
 *
 * `YYYY-MM-DD` → `YYYYMMDD`
 *
 * **Precondizioni:** L'input deve essere in formato ISO rigoroso (YYYY-MM-DD)
 * e rappresentare una data esistente. Su input malformato lancia un errore
 * invece di restituire un valore corrotto.
 *
 * @throws {Error} Se l'input non e' in formato ISO o la data non esiste
 */
export function toMerchantDate(iso: string): string {
  // Valida il formato ISO
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    throw new Error(
      `toMerchantDate: input must be in ISO format (YYYY-MM-DD), got: ${iso}`
    );
  }

  const [, year, month, day] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  // Valida che la data esista
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new Error(`toMerchantDate: invalid date components: ${iso}`);
  }

  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new Error(`toMerchantDate: date does not exist: ${iso}`);
  }

  return `${year}${month}${day}`;
}
