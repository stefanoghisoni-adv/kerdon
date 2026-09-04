import { useCallback, useEffect, useState } from 'react';
import { Button, Icon, Tooltip } from '@shopify/polaris';
import { CheckIcon, DuplicateIcon } from '@shopify/polaris-icons';
import { useT } from '~/lib/i18n/context';
import { copyToClipboard } from './copy-value';

export interface CopyIconButtonProps {
  /** Il valore che finisce negli appunti, sempre intero. */
  value: string;
}

/** Quanto resta la spunta prima che torni il pulsante. */
const CONFIRM_MS = 1000;

/**
 * Copia un valore: solo l'icona, nessuna parola.
 *
 * Prima si copiava cliccando il valore stesso, che non lo dichiarava a nessuno:
 * chi non passava sopra col puntatore non sapeva di poterlo fare. Un pulsante
 * accanto lo dice, e lascia il valore selezionabile con il mouse per chi
 * preferisce quella strada.
 *
 * A copia fatta il pulsante sparisce e al suo posto resta una spunta per un
 * secondo: e' la conferma piu' corta possibile, e non sposta niente attorno
 * perche' occupa lo stesso posto.
 */
export function CopyIconButton({ value }: CopyIconButtonProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    // La spunta si accende solo a copia riuscita: dentro la cornice dell'admin
    // il permesso puo' essere negato, e una conferma non vera e' peggio di
    // nessuna conferma.
    if (await copyToClipboard(value)) setCopied(true);
  }, [value]);

  // I tre pixel valgono per tutti e due gli stati, spunta compresa: se
  // scendesse solo il pulsante, a copia fatta la conferma salterebbe su di
  // tre pixel e il movimento si vedrebbe.
  if (copied) {
    return (
      <span
        className="copy-button"
        aria-live="polite"
        aria-label={t.database.copied}
      >
        <Icon source={CheckIcon} tone="success" />
      </span>
    );
  }

  return (
    <span className="copy-button">
    <Tooltip content={t.database.copy}>
      <Button
        icon={DuplicateIcon}
        variant="tertiary"
        // La scatola piu' piccola possibile: a misura piena il pulsante e' piu'
        // alto della riga di testo e, pur centrato, sembra salito — l'occhio
        // confronta il suo bordo con le lettere, non con la riga.
        size="slim"
        onClick={copy}
        accessibilityLabel={t.database.copy}
      />
    </Tooltip>
    </span>
  );
}
