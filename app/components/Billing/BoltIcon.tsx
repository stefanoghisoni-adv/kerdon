/**
 * Il fulmine del "Matching avanzato": i due tracciati veri di Shopify.
 *
 * `@shopify/polaris-icons` un fulmine non ce l'ha. Quello di Shopify esiste ma
 * vive nei web component di App Home, che si caricano con una libreria a parte:
 * provata, portava con se' il proprio tema e scuriva l'app intera, ogni tab. Per
 * due icone non vale una seconda libreria di stili addosso a Polaris React —
 * mentre i tracciati, quelli, si possono tenere identici agli originali.
 *
 * Passano dal componente `Icon` di Polaris come qualunque altra icona
 * (`IconSource` accetta un componente React), quindi restano dentro la sua API
 * invece di essere `<svg>` piantati nel markup.
 *
 * Il colore non e' scritto qui: si disegna con `currentColor`, cosi' il fulmine
 * prende la tinta di chi lo contiene e non puo' divergere dal testo accanto.
 *
 * Sulla griglia: i tracciati di Shopify sono disegnati in 16×16, le icone di
 * Polaris vivono in 20×20, e l'`Icon` scala l'svg per riempire il riquadro.
 * Lasciando il `viewBox` a 16 il fulmine veniva quindi disegnato un quarto piu'
 * grande di ogni icona accanto — e stringerlo con una larghezza in CSS non e' la
 * cura: rimpicciolisce l'elemento, non ricentra il disegno, che scivola in alto
 * a sinistra.
 *
 * Si dichiara allora la griglia 20×20 come tutte le altre e si sposta il disegno
 * di due unita' per lato — (20-16)/2 — cosi' i 16 punti originali cadono esatti
 * al centro dei 20. Il fulmine resta quello di Shopify, non ridisegnato ne'
 * riscalato, e occupa la stessa area utile delle icone che gli stanno intorno.
 */

/** Lo scarto che centra un disegno da 16 dentro il riquadro da 20 di Polaris. */
const CENTER_16_IN_20 = 'translate(2 2)';

/** Vuoto: la funzione non c'e'. */
export function BoltIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
      <g transform={CENTER_16_IN_20}>
        <path
          fillRule="evenodd"
          fill="currentColor"
          d="M9.025.293a.75.75 0 0 1 .495.777l-.438 4.68h3.818a.75.75 0 0 1 .624 1.166l-5.674 8.5a.75.75 0 0 1-1.37-.486l.438-4.68h-3.818a.75.75 0 0 1-.624-1.166l5.674-8.5a.75.75 0 0 1 .875-.29m-4.523 8.457h3.24a.75.75 0 0 1 .747.82l-.239 2.545 3.248-4.865h-3.24a.75.75 0 0 1-.747-.82l.239-2.545z"
        />
      </g>
    </svg>
  );
}

/** Pieno: la funzione c'e'. La differenza si coglie prima di leggere. */
export function BoltFilledIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
      <g transform={CENTER_16_IN_20}>
        <path
          fill="currentColor"
          d="M9.52 1.07a.75.75 0 0 0-1.37-.486l-5.674 8.5a.75.75 0 0 0 .624 1.166h3.818l-.438 4.68a.75.75 0 0 0 1.37.486l5.674-8.5a.75.75 0 0 0-.624-1.166h-3.818z"
        />
      </g>
    </svg>
  );
}
