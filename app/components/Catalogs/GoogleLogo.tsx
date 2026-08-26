import googleIcon from '~/assets/google-merchant-center.svg';

/**
 * Il marchio di Google Merchant Center.
 *
 * Come per Meta: il file ufficiale, non una versione ridisegnata. Su un segno
 * che non ci appartiene un "quasi" e' peggio di niente.
 *
 * 30 e non 36: questo file non ha margine interno — il disegno arriva fino al
 * bordo — quindi alla stessa misura occuperebbe piu' spazio del logo di Meta e
 * la fila di card si vedrebbe sfalsata.
 */
export function GoogleLogo({ size = 30 }: { size?: number }) {
  return (
    <img
      src={googleIcon}
      alt="Google Merchant Center"
      width={size}
      height={size}
      style={{ objectFit: 'contain', display: 'block' }}
    />
  );
}
