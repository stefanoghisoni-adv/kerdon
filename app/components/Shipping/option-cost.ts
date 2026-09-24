// app/components/Shipping/option-cost.ts
//
// Le parti pure della modale dei costi per opzione. Le regole delle fasce non
// vivono qui: sono quelle delle fasce di zona (brackets.ts), cosi' una modifica
// alle regole vale per entrambe e le due modali non possono divergere.

import type { OptionCostType, OptionBracket, RateBracket } from '~/lib/shipping/types';
import type { Locale } from '~/lib/i18n/locales';
import type { Dictionary } from '~/lib/i18n/context';
import { formatMoneyExact } from '~/lib/billing/money';
import { INVALID_BRACKETS, validateBrackets, parseBrackets } from './brackets';

export { INVALID_BRACKETS };

/**
 * Il costo indicativo di un'opzione, per la tabella delle zone.
 *
 * Serve al merchant per riconoscere a colpo d'occhio cosa ha scritto, non per
 * calcolare: per le fasce basta l'intervallo dal costo piu' basso al piu'
 * alto. Senza tariffe un trattino, cosi' l'opzione ancora da compilare salta
 * all'occhio invece di sembrare gratuita.
 */
export function formatIndicativeOptionCost(
  costType: OptionCostType,
  rates: OptionBracket[],
  currency: string,
  locale: Locale,
): string {
  if (rates.length === 0) return '—';

  if (costType === 'flat') {
    return formatMoneyExact(rates[0].cost, currency, locale);
  }

  if (costType === 'linear') {
    return `${formatMoneyExact(rates[0].cost, currency, locale)}/kg`;
  }

  // Fasce: dal costo minimo al massimo, oppure uno solo se coincidono.
  const costs = rates.map((r) => r.cost);
  const min = Math.min(...costs);
  const max = Math.max(...costs);

  if (min === max) {
    return formatMoneyExact(min, currency, locale);
  }

  return `${formatMoneyExact(min, currency, locale)} – ${formatMoneyExact(max, currency, locale)}`;
}

/**
 * La cella del costo di un'opzione nella tabella.
 *
 * Un'opzione importata e mai salvata porta zeri segnaposto, e il calcolo non
 * la usa (vale la tariffa della zona): mostrarla come "0,00 €" farebbe
 * credere al merchant che quella spedizione risulti gratuita. Si segnala
 * invece come da compilare. Dopo il salvataggio si mostra il costo, zero
 * compreso, perche' a quel punto e' una scelta del merchant.
 */
export function optionCostCell(
  option: { costType: OptionCostType; confirmed: boolean; rates: OptionBracket[] },
  currency: string,
  locale: Locale,
): { toFill: true } | { toFill: false; text: string } {
  if (!option.confirmed) return { toFill: true };
  return { toFill: false, text: formatIndicativeOptionCost(option.costType, option.rates, currency, locale) };
}

/**
 * La tariffa la calcola un corriere o un'app al checkout.
 *
 * In quel caso sull'ordine compare il nome del servizio scelto (es. "UPS
 * Ground"), che puo' non coincidere con il nome dell'opzione importata: il
 * merchant va avvisato che il costo vale solo a nome identico.
 */
export function isCarrierCalculated(shopifyKind: string | null): boolean {
  return shopifyKind === 'DeliveryParticipant';
}

/**
 * Le fasce di un'opzione nella forma delle fasce di zona.
 *
 * Solo un cambio di nome dei campi: i valori passano cosi' come sono, anche
 * se sbagliati, perche' e' validateBrackets a decidere se la forma regge. Un
 * elemento che non e' un oggetto resta com'e' e viene scartato li'.
 */
function comeFasceDiZona(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((b: unknown) => {
    if (typeof b !== 'object' || b === null) return b;
    const { from, to, cost } = b as Record<string, unknown>;
    return { weightFromKg: from, weightToKg: to, cost };
  });
}

/**
 * Controlla le fasce di un'opzione con le stesse regole delle fasce di zona.
 *
 * Per il costo fisso e al kg non ci sono fasce da controllare. Per le fasce di
 * peso e di valore le regole sono identiche (da 0, contigue, solo l'ultima
 * illimitata, costi non negativi): cambia solo l'unita', che i messaggi di
 * errore non nominano.
 *
 * @returns la chiave i18n dell'errore, oppure null se le fasce vanno bene
 */
export function validateOptionBrackets(costType: OptionCostType, input: unknown): string | null {
  if (costType === 'flat' || costType === 'linear') return null;
  return validateBrackets(comeFasceDiZona(input));
}

/**
 * Le fasce opzione dal campo del form, gia' validate.
 *
 * Il JSON malformato e' un errore di validazione come gli altri, non
 * un'eccezione: l'azione risponde con la chiave e il merchant vede un
 * messaggio, invece di una pagina di errore. La lettura e i controlli sono
 * quelli di parseBrackets, dopo aver rinominato i campi.
 */
export function parseOptionBrackets(
  costType: OptionCostType,
  raw: string | undefined,
): { brackets: OptionBracket[]; error: null } | { brackets: null; error: string } {
  // Il fisso e il costo al kg non hanno fasce: niente da leggere dal campo.
  if (costType === 'flat' || costType === 'linear') return { brackets: [], error: null };
  const letto = parseBrackets(raw, comeFasceDiZona);
  if (letto.error !== null) return { brackets: null, error: letto.error };
  return { brackets: fromRateBrackets(letto.brackets), error: null };
}

/** Le etichette dell'editor delle fasce, che cambiano con l'unita' delle soglie. */
export interface BracketEditorLabels {
  from: string;
  to: string;
  cost: string;
  unlimited: string;
  /** Le regole delle fasce, dette nell'unita' giusta. */
  help: string;
  /** Il passo dei campi soglia: decimi di kg, centesimi per gli importi. */
  rangeStep: number;
}

/**
 * Le etichette per le fasce di un'opzione.
 *
 * Le fasce di valore misurano l'importo dell'ordine: mostrare "kg" farebbe
 * scrivere al merchant soglie di peso dove servono soglie in euro.
 */
export function bracketEditorLabels(
  costType: 'weight_brackets' | 'value_brackets',
  t: Dictionary,
): BracketEditorLabels {
  const m = t.shipping.optionModal;
  const comuni = { cost: m.bracketCost, unlimited: m.bracketUnlimited };
  if (costType === 'value_brackets') {
    return { ...comuni, from: m.bracketValueFrom, to: m.bracketValueTo, help: m.valueBracketsHelp, rangeStep: 0.01 };
  }
  return { ...comuni, from: m.bracketWeightFrom, to: m.bracketWeightTo, help: m.weightBracketsHelp, rangeStep: 0.1 };
}

/**
 * Controlla il costo fisso o al kg scritto nel campo, con la stessa regola
 * del server (un numero finito, zero compreso): se il campo passa qui, il
 * server non lo rifiuta.
 *
 * Ogni tipo ha il suo errore, perche' il messaggio compare sotto il suo campo.
 */
export function validateCostField(costType: 'flat' | 'linear', raw: string): string | null {
  const n = parseFloat(raw);
  if (Number.isFinite(n) && n >= 0) return null;
  return costType === 'flat' ? 'shipping.errors.invalidFlatCost' : 'shipping.errors.invalidLinearCost';
}

/**
 * L'errore da mostrare mentre il merchant scrive.
 *
 * Si ricalcola a ogni tasto, cosi' l'errore sparisce appena il valore torna
 * valido e Salva si riabilita. Il campo vuoto non e' ancora un errore: il
 * merchant lo sta riscrivendo. Al salvataggio invece vale validateCostField.
 */
export function costFieldErrorWhileTyping(costType: 'flat' | 'linear', raw: string): string | null {
  if (raw.trim() === '') return null;
  return validateCostField(costType, raw);
}

/**
 * La fascia che l'editor mostra quando non ce n'e' nessuna: tutto l'intervallo,
 * da 0 senza limite, costo 0. Passa la validazione, cosi' Salva funziona.
 */
export const DEFAULT_OPTION_BRACKET: OptionBracket = { from: 0, to: null, cost: 0 };

/**
 * Le fasce con cui parte la modale.
 *
 * Mai una lista vuota: l'editor mostrerebbe comunque una fascia, e salvare
 * risponderebbe "serve almeno una fascia" con una fascia in vista. Partire
 * dalla stessa fascia che l'editor mostra tiene allineato cio' che si vede e
 * cio' che si salva, anche quando il merchant passa a fasce da fisso o al kg.
 * Le tariffe si copiano prima di ordinarle: sono quelle del loader.
 */
export function initialOptionBrackets(option: {
  costType: OptionCostType;
  rates: ReadonlyArray<{ from: number | null; to: number | null; cost: number }>;
}): OptionBracket[] {
  const aFasce = option.costType === 'weight_brackets' || option.costType === 'value_brackets';
  if (!aFasce || option.rates.length === 0) return [{ ...DEFAULT_OPTION_BRACKET }];
  return [...option.rates]
    .sort((a, b) => (a.from ?? 0) - (b.from ?? 0))
    .map(({ from, to, cost }) => ({ from, to, cost }));
}

/** Per l'editor delle fasce, che lavora nella forma delle fasce di zona. */
export function toRateBrackets(brackets: OptionBracket[]): RateBracket[] {
  return brackets.map((b) => ({ weightFromKg: b.from, weightToKg: b.to, cost: b.cost }));
}

/** Dall'editor delle fasce alla forma delle fasce di opzione. */
export function fromRateBrackets(brackets: RateBracket[]): OptionBracket[] {
  return brackets.map((b) => ({ from: b.weightFromKg, to: b.weightToKg, cost: b.cost }));
}
