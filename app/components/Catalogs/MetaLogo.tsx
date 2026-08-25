import metaIcon from '~/assets/channel-meta.avif';

/**
 * Il marchio di Meta.
 *
 * Lo stesso file gia' usato per riconoscere il canale di vendita in dashboard:
 * un marchio altrui si mostra, non si ridisegna — la mia versione a tratto era
 * un "quasi", e su un segno che non ci appartiene un quasi e' peggio di niente.
 */
/**
 * 36 e non 28: il file ha il suo margine dentro, quindi il segno disegnato
 * occupa meno dei pixel che gli si danno. Dentro la cornice da 48 la differenza
 * fra "logo" e "puntino" e' tutta qui.
 */
export function MetaLogo({ size = 36 }: { size?: number }) {
  return (
    <img
      src={metaIcon}
      alt="Meta"
      width={size}
      height={size}
      style={{ objectFit: 'contain', display: 'block' }}
    />
  );
}
