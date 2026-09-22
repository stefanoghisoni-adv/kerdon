import { useCallback, useState } from 'react';
import {
  Banner,
  BlockStack,
  Button,
  InlineStack,
  Modal,
  Text,
} from '@shopify/polaris';
import { CopyIconButton } from './CopyIconButton';
import { MetricRow } from './MetricRow';
import { useT } from '~/lib/i18n/context';

/** Una credenziale come la pagina la conosce: mai il valore, mai il segreto. */
export interface IngestKeySummary {
  keyId: string;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface IngestKeySectionProps {
  keys: IngestKeySummary[];
}

interface Risposta {
  ok?: boolean;
  value?: string;
  previousValidUntil?: string;
  revoked?: number;
  keys?: IngestKeySummary[];
  error?: string;
}

/**
 * La chiave con cui l'installazione INVIA, dentro la card del tracciamento.
 *
 * STA ACCANTO ALL'ALTRA E NON IN UNA SCHERMATA SUA, ed e' voluto: le due chiavi
 * si copiano nello stesso momento, nello stesso container, durante la stessa
 * installazione. Separarle vorrebbe dire far scorrere la pagina avanti e
 * indietro fra le istruzioni e cio' che le istruzioni chiedono di copiare —
 * che e' esattamente come si finisce per incollarne una al posto dell'altra.
 *
 * IL VALORE SI VEDE UNA VOLTA SOLA, E IL MESSAGGIO LO DICE PRIMA, non dopo.
 * Un avviso che compare quando il valore e' gia' sparito non e' un avviso, e'
 * una spiegazione. Qui la frase sta sopra al valore, mentre e' ancora li' da
 * copiare.
 *
 * LA SOSTITUZIONE NON INTERROMPE NIENTE, e il messaggio dice per quanto: la
 * chiave di prima continua a funzionare per il tempo necessario a pubblicare
 * quella nuova. La revoca invece chiude subito — e' un gesto diverso, con un
 * pulsante diverso e una conferma, perche' e' la risposta a "e' finita nelle
 * mani sbagliate" e non a "voglio cambiarla".
 */
export function IngestKeySection({ keys }: IngestKeySectionProps) {
  const t = useT();

  const [elenco, setElenco] = useState(keys);
  const [appena, setAppena] = useState<{ value: string; validoFino: string | null } | null>(null);
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState(false);
  const [confermaRevoca, setConfermaRevoca] = useState(false);

  const vive = elenco.filter((k) => k.revokedAt === null);
  const neHaGia = vive.length > 0;

  const chiama = useCallback(async (intent: 'issue' | 'revoke') => {
    setInCorso(true);
    setErrore(false);
    try {
      const risposta = await fetch('/api/tracking/ingest-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent }),
      });
      const body = (await risposta.json()) as Risposta;
      if (!body.ok) {
        setErrore(true);
        return;
      }
      if (body.keys) setElenco(body.keys);
      // Il valore compare solo qui, e solo adesso: nessuna rilettura della
      // pagina lo riporta indietro.
      setAppena(
        body.value ? { value: body.value, validoFino: body.previousValidUntil ?? null } : null,
      );
    } catch {
      setErrore(true);
    } finally {
      setInCorso(false);
      setConfermaRevoca(false);
    }
  }, []);

  return (
    <BlockStack gap="300">
      <MetricRow
        label={t.database.writeKey}
        info={t.database.writeKeyHelp}
        badge={{
          tone: neHaGia ? 'success' : undefined,
          content: neHaGia ? t.database.writeKeyActive(vive.length) : t.database.writeKeyNone,
        }}
        action={!neHaGia ? (
          <Button onClick={() => chiama('issue')} loading={inCorso} disabled={inCorso}>
            {t.database.writeKeyCreate}
          </Button>
        ) : undefined}
      />

      {/* Nessun avviso che conti i giorni a una scadenza: non ce n'e' piu' una.
          Chi ha una chiave viva e' a posto, e chi ha incollato quella sbagliata
          nel container lo vede dalla riga qui sotto — nessun dato ricevuto —
          molto piu' in fretta che da un banner. */}
      {appena && (
        <Banner tone="info">
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {t.database.writeKeyOnce}
            </Text>
            <InlineStack gap="200" blockAlign="center" wrap={false}>
              <Text as="span" variant="bodyMd" breakWord>
                {appena.value}
              </Text>
              <CopyIconButton value={appena.value} />
            </InlineStack>
            {/* Solo se c'era gia' qualcosa da sostituire: alla prima chiave
                non c'e' nessuna finestra di cui parlare. */}
            {appena.validoFino && elenco.length > 1 && (
              <Text as="p" variant="bodySm" tone="subdued">
                {t.database.writeKeyOverlap(giorno(appena.validoFino))}
              </Text>
            )}
          </BlockStack>
        </Banner>
      )}

      {errore && (
        <Banner tone="critical">
          <Text as="p" variant="bodyMd">
            {t.database.writeKeyFailed}
          </Text>
        </Banner>
      )}

      {neHaGia && (
        <InlineStack gap="200" blockAlign="center">
          <Button onClick={() => chiama('issue')} loading={inCorso} disabled={inCorso}>
            {t.database.writeKeyRotate}
          </Button>
          <Button
            tone="critical"
            variant="plain"
            onClick={() => setConfermaRevoca(true)}
            disabled={inCorso}
          >
            {t.database.writeKeyRevoke}
          </Button>
        </InlineStack>
      )}

      {/* Solo quando un invio c'e' stato davvero. Prima diceva "nessun invio
          ricevuto finora", che e' vero anche un istante dopo aver creato la
          chiave: chi ha appena finito leggeva un'assenza al posto di un esito,
          e non c'era niente da fare per cambiarla. Un'assenza non e' una
          notizia — la riga compare quando ha qualcosa da dire. */}
      {neHaGia && ultimoInvio(vive) && (
        <Text as="p" variant="bodySm" tone="subdued">
          {t.database.writeKeyLastUsed(giorno(ultimoInvio(vive)!))}
        </Text>
      )}

      {/* La revoca ferma l'invio finche' non se ne pubblica una nuova: e' una
          conseguenza che va letta prima, non scoperta dai dati che non
          arrivano. */}
      <Modal
        open={confermaRevoca}
        onClose={() => setConfermaRevoca(false)}
        title={t.database.writeKeyRevokeTitle}
        primaryAction={{
          content: t.database.writeKeyRevoke,
          destructive: true,
          loading: inCorso,
          onAction: () => void chiama('revoke'),
        }}
        secondaryActions={[{ content: t.common.cancel, onAction: () => setConfermaRevoca(false) }]}
      >
        <Modal.Section>
          <Text as="p" variant="bodyMd">
            {t.database.writeKeyRevokeBody}
          </Text>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}

/** L'invio piu' recente fra tutte le credenziali vive. null = mai. */
function ultimoInvio(keys: IngestKeySummary[]): string | null {
  const date = keys.map((k) => k.lastUsedAt).filter((d): d is string => d !== null);
  return date.length > 0 ? date.sort().at(-1)! : null;
}

/**
 * Una data come la legge una persona.
 *
 * `undefined` come lingua di proposito: si segue quella del browser del
 * merchant, che e' la stessa con cui legge tutte le altre date del suo admin.
 * Una data sempre formattata all'italiana sarebbe l'unica stonata della pagina.
 */
function giorno(iso: string): string {
  const quando = new Date(iso);
  if (Number.isNaN(quando.getTime())) return iso;
  return quando.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}
