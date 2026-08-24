/**
 * Il marchio di Meta, disegnato qui dentro.
 *
 * Inline e non un'immagine da scaricare: dentro l'admin di Shopify ogni
 * richiesta di rete in piu' e' un riquadro che compare mezzo secondo dopo gli
 * altri, e una card di riconoscimento senza logo, per mezzo secondo, non
 * riconosce niente.
 *
 * E' il doppio anello nel blu di Meta, ridisegnato: la forma si legge a 28px,
 * che e' la dimensione a cui vive. Per il marchio esatto basta sostituire
 * questo file con l'SVG ufficiale — il resto della card non cambia.
 */
export function MetaLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 24"
      role="img"
      aria-label="Meta"
      focusable="false"
    >
      <defs>
        <linearGradient id="cw-meta-blue" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#0064E1" />
          <stop offset="55%" stopColor="#0082FB" />
          <stop offset="100%" stopColor="#0064E1" />
        </linearGradient>
      </defs>
      {/* Un tratto solo: i due anelli del marchio sono una linea che non si
          interrompe, ed e' quello che lo rende riconoscibile anche piccolo. */}
      <path
        d="M4 12c0-4.4 2.2-7.6 5.3-7.6 2.6 0 4.4 1.9 6.6 5.4l4.1 6.6c2.2 3.5 4 5.4 6.6 5.4 3.1 0 5.3-3.2 5.3-7.6S29.7 4.4 26.6 4.4c-2.6 0-4.4 1.9-6.6 5.4l-4.1 6.6c-2.2 3.5-4 5.4-6.6 5.4C6.2 21.8 4 18.6 4 14.2z"
        fill="none"
        stroke="url(#cw-meta-blue)"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
