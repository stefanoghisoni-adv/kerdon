import { describe, it, expect } from 'vitest';
import { polarisTranslations } from './polaris';
import { LOCALES, type Locale } from './locales';

/** I nomi dei mesi del calendario: e' li' che il difetto si vedeva. */
function august(locale: Locale): unknown {
  const polaris = polarisTranslations(locale).Polaris;
  if (typeof polaris === 'string') return undefined;
  const picker = polaris.DatePicker;
  if (typeof picker === 'string') return undefined;
  const months = picker.months;
  if (typeof months === 'string') return undefined;
  return months.august;
}

describe('polarisTranslations', () => {
  // Il sintomo esatto della correzione: il calendario scriveva "August 2026"
  // dentro un'app per il resto tutta in italiano.
  it('il calendario dice Agosto in italiano e August in inglese', () => {
    expect(august('it')).toBe('Agosto');
    expect(august('en')).toBe('August');
  });

  // Se domani l'app parlasse anche francese, questa e' la riga che
  // ricorderebbe di aggiungere il dizionario di Polaris insieme al nostro.
  it('ogni lingua dell app ha i suoi testi di Polaris', () => {
    for (const locale of LOCALES) {
      expect(august(locale)).toBeTypeOf('string');
    }
  });

  it('lingue diverse, testi diversi', () => {
    expect(polarisTranslations('it')).not.toBe(polarisTranslations('en'));
  });
});
