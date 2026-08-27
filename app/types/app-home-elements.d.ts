/**
 * I web component di App Home, dichiarati per TypeScript.
 *
 * Sono elementi personalizzati registrati da `app-bridge.js`, che l'app carica
 * gia' — lo inietta `AppProvider` quando gli si passa `isEmbeddedApp`. Il
 * browser quindi li conosce, ma TypeScript no: senza questa dichiarazione ogni
 * `<s-icon>` nel JSX sarebbe un errore di compilazione.
 *
 * Si dichiara solo cio' che usiamo davvero. Ricopiare qui l'intera libreria
 * sarebbe una seconda fonte da tenere allineata a mano con quella vera, e la
 * prima volta che Shopify cambia qualcosa questo file racconterebbe una cosa
 * diversa dal componente.
 */
import type React from 'react';

/** I toni ammessi da `s-icon`. Fra questi non c'e' il viola. */
type AppHomeIconTone =
  | 'info'
  | 'success'
  | 'warning'
  | 'critical'
  | 'auto'
  | 'neutral'
  | 'caution';

// Si aumenta `React.JSX` e non il namespace globale `JSX`: dalla versione 19
// dei tipi di React quello globale non esiste piu', e dichiararlo li' non
// darebbe errore — semplicemente non verrebbe visto, che e' peggio.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      's-icon': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        /** Il nome dell'icona, per esempio `bolt-filled`. */
        type?: string;
        tone?: AppHomeIconTone;
        color?: 'base' | 'subdued';
        size?: 'small' | 'base';
      };
    }
  }
}

export {};
