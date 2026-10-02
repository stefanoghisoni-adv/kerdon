/**
 * Calcola il messaggio di clienti rimanenti sincronizzabili.
 *
 * @param active - Numero di clienti attualmente sincronizzati
 * @param limit - Limite del piano (null = illimitato)
 * @returns Oggetto con la chiave i18n e il tono da usare
 */
export function customerRemainingMessage(
  active: number,
  limit: number | null,
): { key: 'unlimited' | 'remaining'; remaining?: number; tone: 'subdued' | 'caution' } {
  if (limit === null) {
    return { key: 'unlimited', tone: 'subdued' };
  }

  const remaining = Math.max(0, limit - active);
  return {
    key: 'remaining',
    remaining,
    tone: remaining === 0 ? 'caution' : 'subdued',
  };
}
