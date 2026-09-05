// app/components/Dashboard/SyncLog.tsx
import { Card, BlockStack, Text, Badge, DataTable, Button } from '@shopify/polaris';
import type { SerializeFrom } from '@remix-run/node';
import type { SyncJob } from '@prisma/client';
import { useState } from 'react';
import {
  tableCreationMessage,
  syncStatusBadge,
  formatDateTime,
  syncErrorMessage,
  hasSyncDetail,
} from './sync-log-format';
import { SyncJobDetailsModal } from './SyncJobDetailsModal';
import { useT, useLocale } from '~/lib/i18n/context';

type SerializedSyncJob = SerializeFrom<SyncJob>;

interface SyncLogProps {
  jobs: SerializedSyncJob[];
  customersEnabled: boolean;
  timeZone: string | null;
}

export function SyncLog({ jobs, customersEnabled, timeZone }: SyncLogProps) {
  const t = useT();
  const locale = useLocale();
  const [detailsJobId, setDetailsJobId] = useState<string | null>(null);

  const detailsJob = detailsJobId ? jobs.find((j) => j.id === detailsJobId) : null;

  const rows = jobs.map((job) => {
    const creation = tableCreationMessage(job.jobType, t);
    const status = syncStatusBadge(job.status, t);
    const failure =
      job.status === 'failed' && job.errors
        ? syncErrorMessage((job.errors as { message?: string }).message, t)
        : null;

    // Il badge porta solo lo stato: cosa e' successo si legge nella colonna
    // accanto, non stipato nella stessa cella.
    const stateCell = <Badge tone={status.tone}>{status.label}</Badge>;

    // Descrizione: l'errore quando la corsa e' fallita, l'esito della creazione
    // tabelle quando il job e' quello. Una sync riuscita non ha niente da
    // aggiungere allo stato, e la cella resta vuota.
    const descriptionCell = failure ? (
      <Text as="span" tone="critical">
        {failure}
      </Text>
    ) : job.status === 'completed_with_repairs' ? (
      // La riga parziale ha qualcosa da aggiungere allo stato, e quel qualcosa
      // e' cosa succede adesso: senza, "Parziale" resterebbe una parola sola
      // accanto a una data, e chi la legge non saprebbe se deve fare qualcosa.
      <Text as="span">{t.logs.partialNote}</Text>
    ) : creation ? (
      <Text as="span">{creation}</Text>
    ) : (
      ''
    );

    // "Vedi dettagli" solo dove c'e' davvero del dettaglio da vedere: un modal
    // vuoto farebbe pensare che i dati siano andati persi. Le creazioni tabella
    // non ne hanno mai, e nemmeno le sincronizzazioni che non hanno cambiato
    // niente (comprese tutte quelle precedenti a questa funzione).
    const detailsCell =
      !creation && hasSyncDetail(job) ? (
        <Button variant="plain" onClick={() => setDetailsJobId(job.id)}>
          {t.logs.seeDetails}
        </Button>
      ) : (
        ''
      );

    // Solo data e ora: quanto e' durata la corsa non dice nulla al merchant.
    return [
      stateCell,
      descriptionCell,
      formatDateTime(job.startedAt, timeZone, locale),
      detailsCell,
    ];
  });

  return (
    <>
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            {t.logs.logTitle}
          </Text>
          {jobs.length === 0 ? (
            <Text as="p" tone="subdued">
              {t.logs.noActivity}
            </Text>
          ) : (
            <DataTable
              columnContentTypes={['text', 'text', 'text', 'text']}
              headings={[
                t.logs.columns.state,
                t.logs.columns.description,
                t.logs.dateTime,
                t.logs.detailsColumn,
              ]}
              rows={rows}
            />
          )}
        </BlockStack>
      </Card>

      {detailsJob && (
        <SyncJobDetailsModal
          open={!!detailsJobId}
          onClose={() => setDetailsJobId(null)}
          jobId={detailsJob.id}
          jobStartedAt={detailsJob.startedAt}
          timeZone={timeZone}
          customersEnabled={customersEnabled}
        />
      )}
    </>
  );
}
