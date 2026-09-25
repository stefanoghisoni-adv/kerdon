// app/lib/shipping/rule-order.ts
import type { FallbackRule } from './types';

/**
 * Le regole in ordine di peso massimo, "tutto il resto" in fondo.
 *
 * Si applica la prima regola che combacia: in quest'ordine una regola non ne
 * nasconde mai un'altra, e la tabella si legge dall'alto in basso come la
 * applica il calcolo. Si usa sia in scrittura sia in lettura, cosi' anche le
 * regole salvate fuori ordine prima di questa regola si vedono e si applicano
 * nello stesso ordine. A parita' di peso resta l'ordine di prima.
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
