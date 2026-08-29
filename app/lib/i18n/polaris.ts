/**
 * I testi che Polaris si scrive da solo, nella lingua del merchant.
 *
 * Non sono i nostri: sono le parole che i componenti mettono senza che gliele
 * passi nessuno — i nomi dei mesi e dei giorni nel calendario, "Cancella" nei
 * campi, le etichette che leggono gli screen reader. Senza questo dizionario
 * AppProvider ricade sull'inglese che si porta dentro, e il calendario scriveva
 * "August 2026" con "Mo Tu We" in cima dentro un'app per il resto tutta in
 * italiano.
 *
 * Le due lingue si importano per nome, una per una. Polaris ne spedisce
 * ventuno: un import costruito su una variabile le imbarcherebbe tutte nel
 * pacchetto che scarica il browser, per venti lingue in cui l'app non ha una
 * sola frase da dire. Aggiungendo una lingua all'app si aggiunge qui la riga
 * corrispondente — e se ci si dimentica non compila, perche' il Record le vuole
 * tutte.
 */
import en from '@shopify/polaris/locales/en.json';
import it from '@shopify/polaris/locales/it.json';
import type { Locale } from './locales';

/**
 * La forma che AppProvider si aspetta: un albero di stringhe.
 *
 * Scritta qui invece che importata da Polaris perche' e' l'unica cosa che ci
 * serve saperne, e un tipo nostro non si rompe se Polaris sposta i suoi file
 * interni.
 */
export interface PolarisTranslations {
  [key: string]: string | PolarisTranslations;
}

const POLARIS_TRANSLATIONS: Record<Locale, PolarisTranslations> = { en, it };

/** I testi di Polaris nella lingua indicata. */
export function polarisTranslations(locale: Locale): PolarisTranslations {
  return POLARIS_TRANSLATIONS[locale];
}
