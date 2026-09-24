import { useFetcher } from '@remix-run/react';
import { useEffect, useState } from 'react';
import { Banner, Text } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';

interface WeightMissingBannerProps {
  /** Quanti ordini spediti non hanno un peso */
  count: number;
}

/**
 * Avviso "ordini senza peso" nella dashboard.
 *
 * Il costo di spedizione dipende dal peso dell'ordine. Se il peso manca e non
 * c'e' un default configurato, il costo resta a zero — cioe' il profitto
 * calcolato risulta piu' alto del vero.
 *
 * L'avviso e' chiudibile e la chiusura si ricorda sul server, per sempre: non
 * torna alla prossima apertura, anche se gli ordini senza peso restano. Sparisce
 * da solo quando si configura un peso di default per articolo.
 *
 * Tono info (non warning): e' l'unica eccezione consentita alla regola del
 * progetto "un problema resta warning". L'utente ha esplicitamente chiesto un
 * avviso info chiudibile, non permanente.
 */
export function WeightMissingBanner({ count }: WeightMissingBannerProps) {
  const t = useT();
  const dismissFetcher = useFetcher<{ ok?: boolean }>();
  const [dismissed, setDismissed] = useState(false);

  // Chiusura immediata nel browser, poi si salva sul server.
  const handleDismiss = () => {
    setDismissed(true);
    dismissFetcher.submit(
      { intent: 'dismiss-weight-alert' },
      { method: 'post' },
    );
  };

  // Se il salvataggio fallisce, l'avviso torna: far credere che un "non
  // mostrarmelo piu'" sia stato preso quando non lo e' sarebbe peggio.
  useEffect(() => {
    if (dismissFetcher.state === 'idle' && dismissFetcher.data?.ok === false) {
      setDismissed(false);
    }
  }, [dismissFetcher.state, dismissFetcher.data]);

  if (dismissed || count === 0) return null;

  return (
    <Banner
      tone="info"
      title={t.dashboard.weightMissingAlert.title(count)}
      onDismiss={handleDismiss}
      action={{
        content: t.dashboard.weightMissingAlert.action,
        url: '/spedizioni',
      }}
    >
      <Text as="p">{t.dashboard.weightMissingAlert.body}</Text>
    </Banner>
  );
}
