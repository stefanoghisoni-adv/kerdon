import { Button, Link, Spinner } from '@shopify/polaris';
import { planLabel } from './account-format';
import { PlanUpgradeModal } from './PlanUpgradeModal';
import { usePlanUpgrade, type PlanUpgradeData } from './plan-upgrade-action';
import { samePlanName } from '~/lib/billing/plan-name';
import { useT } from '~/lib/i18n/context';

export interface PlanUpgradeActionProps {
  /**
   * Il piano da proporre, col nome tecnico. Senza, non c'e' niente da proporre
   * e il comando non compare: e' il caso di chi ha gia' tutto, o di chi sopra
   * di se' non ha piu' nessun piano.
   */
  plan?: string | null;
  /**
   * Il comando come pulsante principale invece che come collegamento. Lo usa il
   * solo avviso del tetto prodotti, dove l'aggiornamento non e' una scorciatoia
   * in mezzo a una frase ma la risposta al problema che l'avviso ha appena
   * annunciato.
   */
  variant?: 'link' | 'primary';
  /** Quando l'invito va detto diversamente da "Aggiorna a <piano>". */
  label?: string;
  /** Solo per il pulsante: l'app e' bloccata e non c'e' niente da comprare. */
  disabled?: boolean;
  /** Dati gia' in mano a chi ospita il comando: evita di richiederli. */
  data?: PlanUpgradeData | null;
}

/**
 * L'invito ad aggiornare piano, in un pezzo solo.
 *
 * E' la forma scelta per non avere quattro modi di dire la stessa cosa: il
 * testo, l'aspetto, l'attesa e il confronto che si apre stanno tutti qui, e i
 * punti che invitano ad aggiornare devono sapere una cosa sola — quale piano
 * proporre. Prima ognuno se la cavava a modo suo: due erano pulsanti che
 * portavano alla tab Piano, uno un collegamento che apriva il confronto, e il
 * merchant vedeva risposte diverse alla stessa domanda a seconda di dove
 * l'avesse fatta.
 *
 * Componente e non hook perche' cio' che va condiviso e' proprio il pezzo
 * visibile — un hook avrebbe lasciato a ogni punto il compito di ridisegnarsi
 * il collegamento, cioe' esattamente la parte che oggi diverge. E un componente
 * per comando, non uno per pagina: ogni istanza tiene il proprio stato, quindi
 * due inviti nella stessa card non possono piu' accendersi insieme.
 */
export function PlanUpgradeAction({
  plan,
  variant = 'link',
  label,
  disabled,
  data: preloaded,
}: PlanUpgradeActionProps) {
  const t = useT();
  const upgrade = usePlanUpgrade(preloaded ?? null);

  if (!plan) return null;

  const text = label ?? t.account.upgradeTo(planLabel(plan));
  const currentPlan = upgrade.data?.currentPlan ?? null;
  // Il nome arriva da una pagina e il listino da un'altra: si confrontano come
  // ovunque nell'app, a meno di maiuscole e spazi.
  const nextPlan = upgrade.data?.plans.find((p) => samePlanName(p.planName, plan)) ?? null;

  return (
    <>
      {variant === 'primary' ? (
        <Button
          variant="primary"
          onClick={upgrade.request}
          disabled={disabled || upgrade.loading}
          loading={upgrade.loading}
        >
          {text}
        </Button>
      ) : (
        // Un `Link` di Polaris e non un pulsante "plain": il blu e' quello dei
        // collegamenti del design system, non un blu deciso da noi, e
        // `removeUnderline` lascia la sottolineatura al passaggio del mouse —
        // che e' il modo in cui un collegamento si annuncia senza rigare di blu
        // le frasi in cui vive.
        //
        // Il cerchietto sta accanto e non dentro: `Link` non ha un `loading`, e
        // uno `Spinner` e' fatto di soli `span`, quindi non spezza la frase che
        // ospita il collegamento.
        <>
          <Link onClick={upgrade.request} removeUnderline>
            {text}
          </Link>
          {upgrade.loading && (
            <>
              {' '}
              <Spinner size="small" accessibilityLabel={t.common.loading} />
            </>
          )}
        </>
      )}

      {/* Senza i due piani non c'e' confronto da mostrare: succede solo se il
          piano proposto sparisce dal listino fra una pagina e l'altra, e in quel
          caso e' meglio non aprire niente che aprire una tabella a meta'. */}
      {currentPlan && nextPlan && upgrade.data && (
        <PlanUpgradeModal
          open={upgrade.open}
          onClose={upgrade.close}
          currentPlan={currentPlan}
          nextPlan={nextPlan}
          currency={upgrade.data.currency}
          counts={{ products: upgrade.data.totalProducts, customers: upgrade.data.optIn }}
        />
      )}
    </>
  );
}
