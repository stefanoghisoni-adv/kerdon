import { useState } from 'react';
import { Banner, BlockStack, Box, Button, Card, InlineStack, Text } from '@shopify/polaris';
import { useT, useLocale } from '~/lib/i18n/context';
import { downloadFile } from '~/lib/privacy/download-file';

export interface DataRequest {
  id: string;
  receivedAt: string;
  expiresAt: string;
  /** Le ultime cifre dell'impronta: distingue due pratiche, non dice chi. */
  ref: string | null;
}

interface Props {
  requests: DataRequest[];
}

/**
 * Le copie dei dati che qualcuno ha chiesto, pronte da ritirare.
 *
 * Quando una persona chiede al negozio una copia dei propri dati, Shopify ce lo
 * dice, ma la risposta la deve dare il titolare del negozio ed entro trenta
 * giorni. Noi prepariamo il file; questa e' la porta da cui lo prende.
 *
 * COMPARE SOLO QUANDO SERVE. Non e' una tab e non e' una riga fissa: una voce
 * di menu che il merchant vede tutti i giorni e apre due volte l'anno diventa
 * arredamento, e quando finalmente serve non la guarda. Qui, quando non c'e'
 * niente da ritirare, non c'e' niente da vedere — e quando c'e', sta in cima
 * alle Impostazioni, dove non si puo' non incontrarla.
 *
 * Il file si scarica solo da qui, e da qui solo con la sessione
 * dell'amministratore: e' il motivo per cui non esiste un indirizzo pubblico,
 * nemmeno lungo e casuale. Un collegamento indovinabile o inoltrato per sbaglio
 * e' una copia dei dati di una persona che gira senza controllo.
 */
export function DataRequestsCard({ requests }: Props) {
  const t = useT();
  const locale = useLocale();
  // Quale riga sta preparando il file, e quale non ce l'ha fatta. Per riga e
  // non per card: le pratiche possono essere piu' d'una, e un caricamento che
  // le accende tutte non dice quale si sta scaricando.
  const [inCorso, setInCorso] = useState<string | null>(null);
  const [fallita, setFallita] = useState<string | null>(null);

  async function scarica(id: string) {
    setInCorso(id);
    setFallita(null);
    try {
      await downloadFile(`/privacy/export/${id}`, 'kerdon-data-request.json');
    } catch (err) {
      console.error('[dataRequests] esportazione non scaricata:', err);
      setFallita(id);
    } finally {
      setInCorso(null);
    }
  }

  if (requests.length === 0) return null;

  const giorno = (iso: string) =>
    new Date(iso).toLocaleDateString(locale === 'it' ? 'it-IT' : 'en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            {t.dataRequests.title}
          </Text>
          <Text as="p" tone="subdued">
            {t.dataRequests.intro}
          </Text>
        </BlockStack>

        {requests.map((r) => (
          <Box key={r.id} borderBlockStartWidth="025" borderColor="border" paddingBlockStart="300">
            <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
              <BlockStack gap="050">
                <Text as="span" fontWeight="medium">
                  {t.dataRequests.received(giorno(r.receivedAt))}
                </Text>
                {/* La scadenza non e' un dettaglio: passata quella, il file non
                    c'e' piu' e la richiesta resta senza risposta. */}
                <Text as="span" tone="subdued" variant="bodySm">
                  {t.dataRequests.expires(giorno(r.expiresAt))}
                  {r.ref ? ` · ${r.ref}` : ''}
                </Text>
                {fallita === r.id && (
                  <Banner tone="critical">{t.dataRequests.error}</Banner>
                )}
              </BlockStack>
              {/* Una fetch e non un link: dentro l'admin l'app si autentica
                  con il gettone di sessione, e un <a> verso questa rotta
                  finirebbe sulla pagina di accesso invece che sul file. */}
              <Button
                variant="primary"
                loading={inCorso === r.id}
                disabled={inCorso !== null && inCorso !== r.id}
                onClick={() => scarica(r.id)}
              >
                {t.dataRequests.download}
              </Button>
            </InlineStack>
          </Box>
        ))}
      </BlockStack>
    </Card>
  );
}
