import { useEffect, useState } from 'react';
import { BlockStack, Button, InlineStack, Spinner, Text } from '@shopify/polaris';
import { TrackingConflicts, type TrackingConflictsProps } from './TrackingConflicts';
import { useT } from '~/lib/i18n/context';

export interface TrackingCheckStepProps extends Omit<TrackingConflictsProps, 'variant'> {
  /** Il controllo e' ancora in corso. */
  loading: boolean;
  /** Il merchant ha gia' dichiarato di aver letto: il passo e' chiuso. */
  confirmed: boolean;
  /** La conferma e' in viaggio verso il server. */
  confirming?: boolean;
  onConfirm: () => void;
}

/**
 * Quanti secondi il comando resta spento prima di poter essere premuto.
 *
 * Non e' un'attesa tecnica — non c'e' niente da caricare — ed e' l'unico punto
 * dell'app in cui si fa aspettare di proposito. Questo passo esiste per far
 * leggere un elenco: un pulsante gia' pronto sotto di esso si preme prima di
 * arrivare alla seconda riga, e il passo diventa un ostacolo da togliere invece
 * che una cosa da guardare. Cinque secondi bastano a posare l'occhio, e sono
 * pochi abbastanza da non irritare chi quell'elenco lo conosce gia'.
 */
const COUNTDOWN_SECONDS = 5;

/**
 * Terzo passo: cosa, su questo negozio, sta gia' mandando eventi.
 *
 * Prima era un avviso in cima alla dashboard. Durante la configurazione pero'
 * non e' una notizia da dare di sfuggita: e' un passaggio, e viene prima della
 * scelta del piano perche' e' li' che il merchant capisce cosa sta comprando —
 * un tracciamento che sostituisce quello che ha, non uno che ci si somma.
 */
export function TrackingCheckStep({
  loading,
  findings,
  confirmed,
  confirming,
  onConfirm,
  ...rest
}: TrackingCheckStepProps) {
  const t = useT();

  // Il conto alla rovescia parte quando c'e' qualcosa da leggere, non quando il
  // passo si apre: farlo scorrere sotto lo spinner vorrebbe dire consumarlo
  // mentre non c'e' ancora niente sotto gli occhi.
  const [left, setLeft] = useState(COUNTDOWN_SECONDS);
  const counting = left > 0 && !confirmed;
  useEffect(() => {
    if (loading || confirmed || left === 0) return;
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [loading, confirmed, left]);

  if (loading) {
    return (
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        <Spinner size="small" accessibilityLabel={t.tracking.checkingLabel} />
        <Text as="p" tone="subdued">
          {t.tracking.checking}
        </Text>
      </InlineStack>
    );
  }

  return (
    <BlockStack gap="400">
      {findings.length === 0 ? (
        <BlockStack gap="200">
          <Text as="p">{t.tracking.nothingFound}</Text>
          {/* Dirlo apertamente: l'elenco e' per forza parziale, e "non ho trovato
              nulla" letto come "sei a posto" e' esattamente cio' che non possiamo
              garantire. */}
          <Text as="p" tone="subdued" variant="bodySm">
            {t.tracking.partialNote}
          </Text>
        </BlockStack>
      ) : (
        <TrackingConflicts findings={findings} variant="plain" {...rest} />
      )}

      {/* Il passo lo chiude il merchant, non il controllo.
          A sinistra perche' e' la fine di una lettura, e la lettura comincia da
          li'. Dopo la conferma resta a video, spento: toglierlo farebbe
          scomparire la riga e saltare in su tutto il resto. */}
      <InlineStack align="start">
        {/* Il pulsante porta SEMPRE il testo vero, anche mentre conta: e' lui a
            dargli la larghezza definitiva. Durante il conteggio il testo si fa
            trasparente e il numero gli sta sopra, centrato. Scambiare i due
            contenuti faceva nascere il pulsante stretto quanto una cifra e
            allargarsi di colpo alla fine — uno scatto che sposta anche quel che
            sta sotto. */}
        <div className="countdown-button" data-counting={counting ? '' : undefined}>
          <Button
            variant="primary"
            disabled={confirmed || counting || confirming}
            loading={confirming}
            onClick={onConfirm}
          >
            {t.steps.trackingCheck.proceed}
          </Button>
          {counting && <span className="countdown-button__count">{left}</span>}
        </div>
      </InlineStack>
    </BlockStack>
  );
}
