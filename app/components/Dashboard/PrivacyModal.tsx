import { useState } from 'react';
import { Banner, BlockStack, Modal, Text } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import { filenameFromDisposition } from '~/lib/privacy/download-filename';

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
 * PERCHE' UNA FETCH E NON UN LINK. Dentro l'admin di Shopify l'app vive in un
 * iframe e si autentica con il gettone di sessione, non con un cookie. Un <a>
 * verso una rotta protetta e' una navigazione: il gettone non c'e', la rotta
 * risponde 302 verso l'accesso, e l'iframe resta bianco — che e' esattamente
 * quello che succedeva. La fetch invece porta il gettone (la libreria di
 * Shopify la equipaggia da se', ed e' come parlano tutte le altre schede), e il
 * file si salva da un blob.
 *
 * Il tipo della risposta si controlla prima di salvare: se un giorno quella
 * rotta tornasse a rispondere con un redirect, la fetch lo seguirebbe fino alla
 * pagina di accesso e salverebbe HTML con il nome di un JSON. Meglio un errore
 * detto che un file inutile sul disco di qualcuno.
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
      const risposta = await fetch('/privacy/my-data');
      const tipo = risposta.headers.get('Content-Type') ?? '';
      if (!risposta.ok || !tipo.includes('application/json')) {
        throw new Error(`risposta inattesa: ${risposta.status} ${tipo}`);
      }

      const blob = await risposta.blob();
      const nome =
        filenameFromDisposition(risposta.headers.get('Content-Disposition')) ?? 'coreward.json';

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = nome;
      // Attaccato e poi tolto: senza essere nel documento, qualche browser
      // ignora il clic e non succede niente — e non succede in silenzio.
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

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
