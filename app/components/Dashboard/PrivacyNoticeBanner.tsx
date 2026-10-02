import { useFetcher } from '@remix-run/react';
import { useEffect, useState } from 'react';
import { Banner, BlockStack, Text } from '@shopify/polaris';
import { useLocale, useT } from '~/lib/i18n/context';
import { linkInformativa } from '~/lib/legal/privacy-policy';

/** L'intent con cui la Dashboard registra l'avviso come visto. */
export const ACKNOWLEDGE_PRIVACY_NOTICE_INTENT = 'acknowledge-privacy-notice';

/**
 * L'avviso delle modifiche sostanziali all'informativa.
 *
 * La sezione 10 dell'informativa promette che una modifica sostanziale viene
 * annunciata dentro l'app prima di valere: e' qui che succede. Compare quando
 * la versione dell'informativa e' piu' recente dell'ultima che il negozio ha
 * visto (lo decide il loader, `privacyNoticeDue`), e sparisce con "Ho capito",
 * che la registra sul server.
 *
 * NON BLOCCA NIENTE. E' un Banner fra gli avvisi, non un modal: la Dashboard
 * sotto funziona come sempre, e chi non lo chiude lo ritrova alla prossima
 * apertura.
 *
 * Tono info: non segnala un problema del negozio, annuncia un documento
 * aggiornato.
 */
export function PrivacyNoticeBanner() {
  const t = useT();
  const locale = useLocale();
  const fetcher = useFetcher<{ ok?: boolean }>();
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState(false);

  // Sparisce subito, poi si salva. Se il salvataggio non riesce l'avviso torna
  // con una riga che lo dice: far credere registrato un "Ho capito" che non lo
  // e' vorrebbe dire ritrovarselo alla prossima apertura senza sapere perche'.
  const acknowledge = () => {
    setHidden(true);
    setFailed(false);
    fetcher.submit({ intent: ACKNOWLEDGE_PRIVACY_NOTICE_INTENT }, { method: 'post' });
  };

  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data && fetcher.data.ok !== true) {
      setHidden(false);
      setFailed(true);
    }
  }, [fetcher.state, fetcher.data]);

  if (hidden) return null;

  const p = t.dashboard.privacyNotice;
  return (
    <Banner
      tone="info"
      title={p.title}
      action={{ content: p.acknowledge, onAction: acknowledge }}
      secondaryAction={{ content: p.link, url: linkInformativa(locale), target: '_blank' }}
    >
      <BlockStack gap="100">
        <Text as="p">{p.body}</Text>
        {failed && (
          <Text as="p" tone="critical">
            {p.saveFailed}
          </Text>
        )}
      </BlockStack>
    </Banner>
  );
}
