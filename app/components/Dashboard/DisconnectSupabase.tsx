import { useCallback, useEffect, useState } from 'react';
import { useFetcher, useRevalidator } from '@remix-run/react';
import { Banner, BlockStack, Button, InlineStack, Modal, Text, TextField } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import { matchesProjectName, projectConfirmationName } from './disconnect-confirm';
import { CopyIconButton } from './CopyIconButton';

export type DisconnectMode = 'delete' | 'keep';

export interface DisconnectSupabaseProps {
  /** Nome del progetto collegato, se ce n'e' uno. */
  projectName?: string | null;
  /** URL del progetto: da qui si ricava il nome quando non lo si conosce. */
  projectUrl?: string | null;
  disabled?: boolean;
  onDisconnected?: (mode: DisconnectMode) => void;
}

/**
 * Scollegare Supabase.
 *
 * Vive nel primo passo, accanto all'account: e' l'accesso che si sta
 * revocando, non il database — dopo, il database non e' "cambiato", non e'
 * piu' raggiungibile affatto. Stava nel secondo passo perche' li' c'era la
 * card del collegamento, ma il gesto appartiene a quello sopra.
 *
 * Con un database collegato la domanda diventa una sola, e pesante: i dati
 * gia' sincronizzati restano o spariscono? Per questo il modal, e per questo
 * l'eliminazione chiede di scrivere il nome del progetto. Senza database non
 * c'e' niente da eliminare e si scollega e basta.
 */
export function DisconnectSupabase({
  projectName,
  projectUrl,
  disabled,
  onDisconnected,
}: DisconnectSupabaseProps) {
  const t = useT();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DisconnectMode | null>(null);
  const [askingName, setAskingName] = useState(false);
  const [typedName, setTypedName] = useState('');

  const running = fetcher.state !== 'idle';
  const confirmationName = projectConfirmationName({
    projectName: projectName ?? undefined,
    projectUrl: projectUrl ?? undefined,
  });
  const nameConfirmed =
    confirmationName != null && matchesProjectName(typedName, confirmationName);
  // Senza progetto non c'e' niente da eliminare: la domanda non si pone.
  const hasProject = confirmationName != null;

  const close = useCallback(() => {
    setOpen(false);
    setAskingName(false);
    setTypedName('');
  }, []);

  const disconnect = useCallback(
    (deleteData: boolean) => {
      setMode(deleteData ? 'delete' : 'keep');
      fetcher.submit(
        { deleteData },
        { method: 'post', action: '/api/supabase/disconnect', encType: 'application/json' },
      );
    },
    [fetcher],
  );

  // Il messaggio di un tentativo andato male. Sta qui e non in un toast
  // perche' il modal resta aperto apposta: l'eliminazione non e' avvenuta, il
  // database e' ancora collegato, e il posto dove riprovare e' questo.
  const failure = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    close();
    onDisconnected?.(mode ?? 'keep');
    revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  return (
    <>
      <Button
        tone="critical"
        onClick={() => (hasProject ? setOpen(true) : disconnect(false))}
        loading={running}
        disabled={disabled || running}
      >
        {t.connect.database.disconnect}
      </Button>

      {hasProject && (
        <Modal
          open={open}
          onClose={close}
          title={t.connect.database.disconnectTitle}
          primaryAction={{
            content: t.connect.database.deleteData,
            destructive: true,
            // Primo clic: chiede di scrivere il nome del progetto. Il secondo
            // cancella davvero, e arriva solo se il nome corrisponde.
            onAction: () => {
              if (!askingName) {
                setAskingName(true);
                return;
              }
              disconnect(true);
            },
            loading: running && mode === 'delete',
            disabled: running || (askingName && !nameConfirmed),
          }}
          secondaryActions={[
            {
              content: t.connect.database.keepData,
              onAction: () => disconnect(false),
              loading: running && mode === 'keep',
              disabled: running,
            },
            {
              content: t.common.cancel,
              onAction: close,
              disabled: running,
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              {failure && (
                <Banner tone="critical">
                  <Text as="p">{failure}</Text>
                </Banner>
              )}
              <Text as="p">
                {t.connect.database.disconnectBody.before}
                <strong>{t.connect.database.disconnectBody.delete}</strong>
                {t.connect.database.disconnectBody.middle}
                <strong>{t.connect.database.disconnectBody.keep}</strong>
                {t.connect.database.disconnectBody.after}
              </Text>

              {askingName && (
                <BlockStack gap="200">
                  {/* Il nome da riscrivere si puo' anche copiare: e' una sigla
                      lunga, e chi la ribatte a mano sbaglia un carattere e non
                      capisce perche' il pulsante resta spento. */}
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <Text as="p">
                      {t.connect.database.typeName} <strong>{confirmationName}</strong>
                    </Text>
                    <CopyIconButton value={confirmationName} />
                  </InlineStack>
                  <TextField
                    label={t.connect.database.projectName}
                    labelHidden
                    value={typedName}
                    onChange={setTypedName}
                    autoComplete="off"
                    autoFocus
                    placeholder={confirmationName ?? ''}
                    disabled={running}
                    helpText={t.connect.database.typeNameHelp}
                  />
                </BlockStack>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </>
  );
}
