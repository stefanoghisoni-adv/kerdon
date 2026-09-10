import { useCallback, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Divider,
  Icon,
  InlineStack,
  List,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import { CheckCircleIcon, AlertCircleIcon } from '@shopify/polaris-icons';
import { CopyIconButton } from './CopyIconButton';
import { MetricRow } from './MetricRow';
import { useLocale } from '~/lib/i18n/context';
import { bridgeSnippet, installCopy } from '~/lib/tracking/install-copy';
import { INSTALL_PATHS, isInstallPath, type InstallPath } from '~/lib/tracking/install';
import { CHECK_ORDER, type CheckResult } from '~/lib/tracking/verify-checks';

export interface TrackingInstallProps {
  /** L'indirizzo dell'app: entra nel pezzo da incollare in vetrina. */
  appUrl: string | null;
  path: InstallPath | null;
  endpoint: string | null;
  verifiedAt: string | null;
}

interface VerifyResponse {
  ok?: boolean;
  passed?: boolean;
  checks?: CheckResult[];
  verifiedAt?: string | null;
  error?: string;
}

/**
 * La scelta di come si installa il tracciamento, dentro la card del tracciamento.
 *
 * PERCHE' UN MENU A TENDINA E NON DUE SCHEDE AFFIANCATE. Le due strade non sono
 * due funzioni fra cui passare avanti e indietro: sono due modi di fare la
 * stessa cosa, e se ne fa uno. Un menu dice "scegli", due schede dicono
 * "guardale tutte e due" — e chi le guarda tutte e due si trova davanti due
 * elenchi di istruzioni di cui uno non lo riguarda.
 *
 * E PERCHE' LE ISTRUZIONI STANNO QUI E NON IN UN DOCUMENTO. Chi installa ha
 * sotto gli occhi, in questa stessa card, i due valori che deve copiare.
 * Mandarlo altrove significa fargli perdere il posto — e tornare con uno dei
 * due valori sbagliato.
 *
 * LO STATO NON DICE MAI "COMPLETO" PER SENTITO DIRE. La riga in cima resta "da
 * verificare" finche' la verifica non e' passata: aver scelto una strada e aver
 * scritto un indirizzo e' una dichiarazione di intenti, non un giro che si
 * chiude. E' esattamente il modo in cui un merchant arrivava in fondo, vedeva
 * tutto a posto, e non tracciava niente.
 */
export function TrackingInstall({ appUrl, path, endpoint, verifiedAt }: TrackingInstallProps) {
  const locale = useLocale();
  const t = installCopy(locale);

  const [chosen, setChosen] = useState<InstallPath | ''>(path ?? '');
  const [address, setAddress] = useState(endpoint ?? '');
  const [savedAt, setSavedAt] = useState<string | null>(verifiedAt);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResponse | null>(null);

  const options = useMemo(
    () => [
      { label: t.choose, value: '' },
      ...INSTALL_PATHS.map((id) => ({ label: t.paths[id], value: id })),
    ],
    [t],
  );

  // Salvare e' una sola chiamata per tutti e due i valori: sono una scelta
  // sola, e salvarli separatamente farebbe esistere per un istante uno stato
  // che non ha senso — la strada di uno e l'indirizzo dell'altro.
  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch('/api/tracking/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: chosen || null, endpoint: address.trim() || null }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string; verifiedAt?: string | null };
      if (!body.ok) {
        setSaveError(body.error === 'invalid_endpoint' ? t.invalidEndpoint : t.saveFailed);
        return;
      }
      // Salvare cambia la configurazione, quindi la verifica di prima non vale
      // piu': l'esito a video va via insieme.
      setSavedAt(body.verifiedAt ?? null);
      setResult(null);
    } catch {
      setSaveError(t.saveFailed);
    } finally {
      setSaving(false);
    }
  }, [address, chosen, t]);

  const verify = useCallback(async () => {
    setVerifying(true);
    setResult(null);
    try {
      const response = await fetch('/api/tracking/verify', { method: 'POST' });
      const body = (await response.json()) as VerifyResponse;
      setResult(body);
      setSavedAt(body.verifiedAt ?? null);
    } catch {
      setResult({ ok: false, error: 'unreachable' });
    } finally {
      setVerifying(false);
    }
  }, []);

  // Tre stati e non due: "non configurata" e "da verificare" sono cose diverse,
  // e mostrarle uguali toglierebbe al merchant l'unica informazione che gli
  // serve — se manca la scelta o manca la prova.
  const status: { tone?: 'success' | 'warning'; content: string } = savedAt
    ? { tone: 'success', content: t.statusVerified }
    : chosen
      ? { tone: 'warning', content: t.statusToVerify }
      : { content: t.statusNotStarted };

  const snippet = bridgeSnippet(appUrl ?? '', address.trim() || null);
  const checks = result?.checks ?? [];

  return (
    <BlockStack gap="400">
      <Divider />

      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">
          {t.title}
        </Text>
        <Text as="p" tone="subdued" variant="bodySm">
          {t.intro}
        </Text>
      </BlockStack>

      <MetricRow label={t.statusLabel} badge={status} />

      <Select
        label={t.installLabel}
        options={options}
        value={chosen}
        onChange={(value) => setChosen(isInstallPath(value) ? value : '')}
        helpText={chosen ? t.pathHelp[chosen] : undefined}
      />

      {/* Il resto compare solo dopo la scelta: prima non c'e' niente da dire
          che valga per tutte e due le strade, e mostrarlo lo stesso vorrebbe
          dire chiedere un indirizzo prima di aver detto di cosa. */}
      {chosen && (
        <BlockStack gap="400">
          <List type="number">
            {t.steps[chosen].map((step) => (
              <List.Item key={step}>{step}</List.Item>
            ))}
          </List>

          <TextField
            label={t.endpointLabel}
            helpText={t.endpointHelp}
            placeholder={t.endpointPlaceholder[chosen]}
            value={address}
            onChange={setAddress}
            autoComplete="off"
            inputMode="url"
            error={saveError ?? undefined}
          />

          {/* Il pezzo da incollare porta gia' dentro l'indirizzo appena scritto:
              un esempio da riadattare si sbaglia, uno gia' giusto si copia. */}
          <BlockStack gap="200">
            <Text as="span" variant="bodyMd">
              {t.snippetLabel}
            </Text>
            <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
              <Text as="span" tone="subdued" truncate>
                {snippet.replace(/\n\s+/g, ' ')}
              </Text>
              <CopyIconButton value={snippet} />
            </InlineStack>
          </BlockStack>

          <InlineStack gap="200">
            <Button onClick={save} loading={saving} disabled={verifying}>
              {t.save}
            </Button>
            <Button
              variant="primary"
              onClick={verify}
              loading={verifying}
              // Senza indirizzo non c'e' niente da chiamare: il comando resta
              // spento invece di partire e tornare con un errore che sembra un
              // guasto.
              disabled={saving || address.trim() === ''}
            >
              {verifying ? t.verifying : t.verify}
            </Button>
          </InlineStack>

          {result?.error === 'no_endpoint' && <Banner tone="warning">{t.noEndpoint}</Banner>}

          {result?.checks && (
            <BlockStack gap="300">
              <Banner tone={result.passed ? 'success' : 'critical'}>
                {result.passed ? t.passed : t.failed}
              </Banner>

              <BlockStack gap="200">
                {CHECK_ORDER.map((id) => {
                  const check = checks.find((c) => c.id === id);
                  if (!check) return null;
                  return (
                    <BlockStack gap="050" key={id}>
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <Icon
                          source={check.ok ? CheckCircleIcon : AlertCircleIcon}
                          tone={check.ok ? 'success' : 'critical'}
                        />
                        <Text as="span" variant="bodyMd">
                          {t.checks[id]}
                        </Text>
                      </InlineStack>
                      {/* Il motivo sotto e non accanto: e' una frase, e accanto
                          a una riga di elenco spingerebbe fuori l'icona. */}
                      {!check.ok && check.reason && (
                        <Text as="p" tone="subdued" variant="bodySm">
                          {t.reasons[check.reason] ?? check.reason}
                        </Text>
                      )}
                    </BlockStack>
                  );
                })}
              </BlockStack>
            </BlockStack>
          )}

          {savedAt && !result && (
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="success">{t.statusVerified}</Badge>
              <Text as="span" tone="subdued" variant="bodySm">
                {t.verifiedOn(new Date(savedAt).toLocaleDateString(locale))}
              </Text>
            </InlineStack>
          )}

          {/* La durata si dice per quello che e': un massimo tecnico, non una
              promessa. Chi legge "un anno" e lo prende per garantito si accorge
              solo mesi dopo che i numeri non tornano. */}
          <Text as="p" tone="subdued" variant="bodySm">
            {t.retention}
          </Text>
        </BlockStack>
      )}
    </BlockStack>
  );
}
