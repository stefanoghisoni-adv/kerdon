import { useEffect, useState } from 'react';
import { BlockStack, Card, Text } from '@shopify/polaris';
import { MetricRow } from './MetricRow';
import { syncFrequencyLabel } from './account-format';
import { syncCountdownLabel } from '~/lib/sync/next-sync';
import { formatSyncDate } from './sync-format';
import { useT, useLocale } from '~/lib/i18n/context';

export interface SyncCardProps {
  /** Cadenza prevista dal piano, in ore. null = piano senza cadenza nota. */
  frequencyHours: number | null;
  /** Ultima corsa periodica completata (ISO), o null se non ce n'e' ancora una. */
  lastSync: string | null;
  /** Prossima corsa prevista (ISO), o null se non e' prevedibile. */
  nextSync: string | null;
  /** Fuso del negozio: le date si leggono nell'ora del merchant, non del server. */
  timeZone?: string | null;
}

/**
 * Come funziona la sincronizzazione per questo negozio.
 *
 * Di sola lettura, e non per pigrizia: la cadenza la stabilisce il piano, ed e'
 * uno dei suoi contenuti — comprare un piano superiore significa anche essere
 * aggiornati piu' spesso. Un campo modificabile qui darebbe l'idea di poter
 * andare piu' veloci senza cambiare piano, che non e' vero.
 */
export function SyncCard({ frequencyHours, lastSync, nextSync, timeZone }: SyncCardProps) {
  const t = useT();
  const locale = useLocale();

  // L'attesa si ricalcola mentre la pagina resta aperta.
  //
  // Prima si calcolava una volta sola, al disegno: una pagina lasciata aperta
  // continuava a dire "tra 20 minuti" mezz'ora dopo, e quando il momento
  // passava la riga spariva al primo aggiornamento. Un minuto e' il passo
  // giusto perche' e' anche l'unita' piu' piccola che l'attesa mostra.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(tick);
  }, []);

  const countdown = syncCountdownLabel(nextSync, now, t);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {t.sync.title}
        </Text>
        <MetricRow
          label={t.sync.frequency}
          badge={{ content: syncFrequencyLabel(frequencyHours, t) }}
        />
        <MetricRow
          label={t.sync.last}
          badge={{
            content: lastSync ? formatSyncDate(lastSync, timeZone, locale) : t.common.never,
          }}
        />
        {/* Il conto alla rovescia e non l'orario: "fra 2 giorni" si capisce a
            colpo d'occhio, mentre una data va confrontata con oggi.

            La riga c'e' finche' una prossima corsa si sa, anche quando il
            momento previsto e' gia' passato: in quel caso dice che e'
            imminente. Prima spariva, e spariva quasi sempre — la previsione per
            una corsa in ritardo e' l'istante in cui il server prepara la
            pagina, che al momento di disegnarla e' gia' passato. Restava una
            card con due righe invece di tre, e bastava ricaricare perche'
            tornassero tre. Quando invece una prossima corsa non si sa affatto
            la riga non c'e', e non c'e' mai: e' un'assenza stabile, non un
            dato che va e viene. */}
        {countdown && <MetricRow label={t.sync.next} badge={{ content: countdown }} />}
      </BlockStack>
    </Card>
  );
}
