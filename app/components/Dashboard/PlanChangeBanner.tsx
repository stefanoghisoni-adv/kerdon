import { useEffect, useState } from 'react';
import { Banner, BlockStack, Button, InlineStack, Text } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import { planLabel } from './account-format';

/**
 * L'avviso del cambio di piano, su qualunque tab.
 *
 * Il contenuto lo calcola la dashboard, che e' l'unica pagina a conoscere i due
 * piani a confronto, e lo lascia nel sessionStorage. Qui si legge di li' e si
 * mostra ovunque: chi cambia piano e va dritto in Impostazioni o su Cataloghi
 * deve sapere lo stesso cosa e' cambiato, e prima quell'avviso viveva solo
 * sulla pagina da cui era partito.
 *
 * Leggerlo invece di ricalcolarlo e' una scelta: il calcolo ha sette dati
 * dietro, e duplicarlo nel guscio dell'app vorrebbe dire due posti che possono
 * cominciare a dire cose diverse. Il prezzo e' che chi non passa mai dalla
 * dashboard non lo vede — ed e' un prezzo accettabile, perche' la dashboard e'
 * la prima cosa che si apre.
 */

export const BANNER_KEY = 'planChangeBanner';
export const DISMISSED_KEY = 'planChangeBannerDismissed';

export interface StoredPlanBanner {
  at: number;
  plan: string;
  value: {
    tone: 'info' | 'success' | 'warning' | 'critical';
    title: string;
    messages: (string | { text: string; bold?: boolean }[])[];
  };
}

export interface PlanChangeBannerProps {
  /** Piano da proporre, quando c'e' qualcosa da guadagnarci. */
  upgradePlan?: string | null;
  /** La dashboard lo rende gia' da se': li' questo non deve comparire. */
  skip?: boolean;
}

export function PlanChangeBanner({ upgradePlan, skip }: PlanChangeBannerProps) {
  const t = useT();
  const [stored, setStored] = useState<StoredPlanBanner | null>(null);

  // Solo nel browser: il sessionStorage non esiste durante il render sul
  // server, e leggerlo li' romperebbe l'idratazione.
  useEffect(() => {
    if (skip) return;
    try {
      const raw = sessionStorage.getItem(BANNER_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredPlanBanner;
      if (sessionStorage.getItem(DISMISSED_KEY) === parsed.plan) return;
      setStored(parsed);
    } catch {
      // Contenuto illeggibile: non e' una notizia da dare, e un avviso rotto
      // e' peggio di nessun avviso.
    }
  }, [skip]);

  if (skip || !stored) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISSED_KEY, stored.plan);
    } catch {
      // Niente storage: l'avviso sparisce comunque per questa visita.
    }
    setStored(null);
  };

  return (
    <Banner tone={stored.value.tone} title={stored.value.title} onDismiss={dismiss}>
      <BlockStack gap="300">
        <BlockStack gap="200">
          {stored.value.messages.map((message, index) => (
            <Text as="p" key={index}>
              {typeof message === 'string'
                ? message
                : message.map((segment, segmentIndex) =>
                    segment.bold ? (
                      <Text key={segmentIndex} as="span" fontWeight="bold">
                        {segment.text}
                      </Text>
                    ) : (
                      segment.text
                    ),
                  )}
            </Text>
          ))}
        </BlockStack>

        {upgradePlan && (
          <InlineStack>
            <Button variant="primary" url="/plan">
              {t.account.upgradeTo(planLabel(upgradePlan))}
            </Button>
          </InlineStack>
        )}
      </BlockStack>
    </Banner>
  );
}
