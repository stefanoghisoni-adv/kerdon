import { useState } from 'react';
import { Banner, BlockStack, Modal, Text } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import { downloadFile } from '~/lib/privacy/download-file';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * La conferma prima di scaricare la copia dei propri dati.
 *
 * Un modal e non un download diretto, per una ragione sola: il file contiene la
 * configurazione completa del negozio, e una volta sul disco ci resta. Chiederlo
 * prima non e' un passaggio burocratico, e' il momento in cui si dice cosa c'e'
 * dentro e cosa no — chi lo scarica sapendo che i dati dei suoi clienti NON ci
 * sono non torna a cercarli li'.
 *
 * Il file NON si scarica con un link: dentro l'admin l'app si autentica con il
 * gettone di sessione, e una navigazione verso una rotta protetta finisce sulla
 * pagina di accesso. Il perche' per esteso sta in `lib/privacy/download-file`,
 * che e' anche il posto da cui passa il pulsante delle richieste dei clienti.
 */
export function PrivacyModal({ open, onClose }: Props) {
  const t = useT();
  const [scaricando, setScaricando] = useState(false);
  const [errore, setErrore] = useState(false);

  const chiudi = () => {
    setErrore(false);
    onClose();
  };

  async function scarica() {
    setScaricando(true);
    setErrore(false);
    try {
      await downloadFile('/privacy/my-data', 'kerdon.json');
      chiudi();
    } catch (err) {
      console.error('[privacy] copia dei dati non scaricata:', err);
      setErrore(true);
    } finally {
      setScaricando(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={chiudi}
      title={t.privacy.title}
      primaryAction={{
        content: t.privacy.confirm,
        onAction: scarica,
        loading: scaricando,
      }}
      secondaryActions={[{ content: t.privacy.cancel, onAction: chiudi, disabled: scaricando }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {errore && <Banner tone="critical">{t.privacy.error}</Banner>}
          <Text as="p">{t.privacy.intro}</Text>
          <Text as="p" tone="subdued">
            {t.privacy.notIncluded}
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
