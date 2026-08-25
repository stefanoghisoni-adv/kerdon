/**
 * Il marchio di Meta, disegnato qui dentro.
 *
 * Inline e non un'immagine da scaricare: dentro l'admin di Shopify ogni
 * richiesta di rete in piu' e' un riquadro che compare mezzo secondo dopo gli
 * altri, e una card di riconoscimento senza logo, per mezzo secondo, non
 * riconosce niente.
 */
export function MetaLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={(size * 24) / 38}
      viewBox="0 0 38 24"
      role="img"
      aria-label="Meta"
      focusable="false"
    >
      <defs>
        <linearGradient id="cw-meta-blue" x1="0" y1="0.5" x2="1" y2="0.5">
          <stop offset="0%" stopColor="#0064E1" />
          <stop offset="45%" stopColor="#0082FB" />
          <stop offset="100%" stopColor="#0064E1" />
        </linearGradient>
      </defs>
      {/* Un tratto solo che si incrocia al centro: sono i due anelli del
          marchio, ed e' l'incrocio a renderlo riconoscibile anche a 28px. */}
      <path
        d="M4.1 12.1c0-4.6 2.3-8 5.4-8 2.7 0 4.6 2 7 5.9l2.5 4.1c2.4 3.9 4.3 5.9 7 5.9 3.1 0 5.4-3.4 5.4-8s-2.3-8-5.4-8c-2.7 0-4.6 2-7 5.9l-2.5 4.1c-2.4 3.9-4.3 5.9-7 5.9-3.1 0-5.4-3.4-5.4-8z"
        fill="none"
        stroke="url(#cw-meta-blue)"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
