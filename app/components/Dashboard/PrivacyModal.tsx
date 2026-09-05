import { BlockStack, Modal, Text } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';

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
 * Il download e' un link e non una fetch: il browser deve poter salvare il file
 * da se', e una risposta letta in JavaScript andrebbe rimessa in un blob per
 * ottenere lo stesso risultato con piu' passaggi e nessun vantaggio.
 */
export function PrivacyModal({ open, onClose }: Props) {
  const t = useT();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.privacy.title}
      primaryAction={{
        content: t.privacy.confirm,
        onAction: () => {
          // Una navigazione e non un link: `ComplexAction` non porta
          // l'attributo `download`, e senza quello un <a> verso un JSON
          // aprirebbe il file invece di salvarlo. Qui non serve, perche' la
          // risposta arriva con Content-Disposition: attachment — il browser
          // salva e la pagina resta dov'e', anche dentro l'iframe dell'admin.
          window.location.assign('/privacy/my-data');
          onClose();
        },
      }}
      secondaryActions={[{ content: t.privacy.cancel, onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Text as="p">{t.privacy.intro}</Text>
          <Text as="p" tone="subdued">
            {t.privacy.notIncluded}
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
