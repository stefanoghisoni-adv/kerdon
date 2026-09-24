// app/components/Shipping/packaging-edit.ts
//
// Una modifica alla volta su categorie e regole, come le fanno le tabelle
// della pagina Spedizioni.
//
// PERCHE' UNA ALLA VOLTA. Prima categorie, regole, peso di default e costo dei
// resi stavano in un solo modulo con un solo Salva: una categoria appena
// scritta e una gia' salvata erano identiche a schermo, e il merchant non
// capiva cosa fosse stato salvato. Ora ogni riga si salva dalla sua modale, e
// il server applica la singola modifica alla configurazione salvata con queste
// funzioni. Sono pure: non toccano la configurazione ricevuta, e il risultato
// passa sempre da `validatePackaging`, la stessa regola del salvataggio in
// blocco.

import { normalizeOrigin } from '~/lib/shipping/category-origin';
import type { FallbackRule, PackagingCategory } from '~/lib/shipping/types';
import { validatePackaging, type PackagingInput } from './packaging';

export { normalizeOrigin };

export type PackagingEditResult = { value: PackagingInput; error: null } | { value: null; error: string };

const ERR = {
  nameEmpty: 'shipping.packaging.errors.categoryNameEmpty',
  nameDuplicate: 'shipping.packaging.errors.categoryNameDuplicate',
  costNegative: 'shipping.packaging.errors.categoryCostNegative',
  categoryNotFound: 'shipping.packaging.errors.categoryNotFound',
  stillReferenced: 'shipping.packaging.errors.categoryStillReferenced',
  ruleInvalidCategory: 'shipping.packaging.errors.ruleInvalidCategory',
  ruleWeightNegative: 'shipping.packaging.errors.ruleWeightNegative',
  multipleUnlimited: 'shipping.packaging.errors.multipleUnlimitedRules',
  ruleNotFound: 'shipping.packaging.errors.ruleNotFound',
} as const;

const fail = (error: string): PackagingEditResult => ({ value: null, error });

/** Il risultato, se passa la validazione completa della configurazione. */
function done(value: PackagingInput): PackagingEditResult {
  const error = validatePackaging(value);
  return error ? fail(error) : { value, error: null };
}

/** Due nomi sono lo stesso nome se differiscono solo per maiuscole e spazi ai bordi. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/**
 * Aggiunge (`originalName` null) o modifica una categoria.
 *
 * Il nome si confronta senza badare a maiuscole e spazi: "Busta" e " busta "
 * a schermo sembrano la stessa cosa, e due categorie cosi' confonderebbero le
 * regole. Rinominando, le regole che usavano il vecchio nome lo seguono; la
 * categoria tiene la sua origine.
 */
export function saveCategory(
  config: PackagingInput,
  originalName: string | null,
  input: { name: string; cost: number },
): PackagingEditResult {
  const name = input.name.trim();
  if (name === '') return fail(ERR.nameEmpty);
  if (!Number.isFinite(input.cost) || input.cost < 0) return fail(ERR.costNegative);

  const index = originalName === null ? -1 : config.categories.findIndex((c) => c.name === originalName);
  if (originalName !== null && index === -1) return fail(ERR.categoryNotFound);

  const duplicate = config.categories.some((c, i) => i !== index && sameName(c.name, name));
  if (duplicate) return fail(ERR.nameDuplicate);

  if (index === -1) {
    return done({
      categories: [...config.categories, { name, cost: input.cost, origin: 'manual' }],
      rules: [...config.rules],
    });
  }

  const previous = config.categories[index];
  const categories = config.categories.map((c, i): PackagingCategory =>
    i === index ? { name, cost: input.cost, origin: normalizeOrigin(previous.origin) } : c,
  );
  const rules = config.rules.map((r) => (r.category === previous.name ? { ...r, category: name } : r));
  return done({ categories, rules });
}

/** Elimina una categoria, ma non se una regola la usa: la regola resterebbe senza imballo. */
export function deleteCategory(config: PackagingInput, name: string): PackagingEditResult {
  if (!config.categories.some((c) => c.name === name)) return fail(ERR.categoryNotFound);
  if (config.rules.some((r) => r.category === name)) return fail(ERR.stillReferenced);
  return done({ categories: config.categories.filter((c) => c.name !== name), rules: [...config.rules] });
}

/**
 * Le regole in ordine di peso massimo, "tutto il resto" in fondo.
 *
 * Si applica la prima regola che combacia: in quest'ordine una regola non ne
 * nasconde mai un'altra, e la tabella si legge dall'alto in basso come la
 * applica il calcolo. A parita' di peso resta l'ordine di prima.
 */
export function sortRules(rules: FallbackRule[]): FallbackRule[] {
  return rules
    .map((rule, i) => ({ rule, i }))
    .sort((a, b) => {
      const wa = a.rule.weightMaxKg ?? Infinity;
      const wb = b.rule.weightMaxKg ?? Infinity;
      return wa === wb ? a.i - b.i : wa - wb;
    })
    .map(({ rule }) => rule);
}

/** Aggiunge (`index` null) o modifica una regola, poi rimette le regole in ordine di peso. */
export function saveRule(config: PackagingInput, index: number | null, input: FallbackRule): PackagingEditResult {
  if (index !== null && (!Number.isInteger(index) || index < 0 || index >= config.rules.length)) {
    return fail(ERR.ruleNotFound);
  }
  if (!config.categories.some((c) => c.name === input.category)) return fail(ERR.ruleInvalidCategory);
  if (input.weightMaxKg !== null && (!Number.isFinite(input.weightMaxKg) || input.weightMaxKg < 0)) {
    return fail(ERR.ruleWeightNegative);
  }

  const rule: FallbackRule = { weightMaxKg: input.weightMaxKg, category: input.category };
  const others = config.rules.filter((_, i) => i !== index);
  if (rule.weightMaxKg === null && others.some((r) => r.weightMaxKg === null)) return fail(ERR.multipleUnlimited);

  const rules = index === null ? [...config.rules, rule] : config.rules.map((r, i) => (i === index ? rule : r));
  return done({ categories: [...config.categories], rules: sortRules(rules) });
}

/** Toglie la regola in posizione `index`. */
export function deleteRule(config: PackagingInput, index: number): PackagingEditResult {
  if (!Number.isInteger(index) || index < 0 || index >= config.rules.length) return fail(ERR.ruleNotFound);
  return done({ categories: [...config.categories], rules: config.rules.filter((_, i) => i !== index) });
}
