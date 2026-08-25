import { useCallback, useState } from 'react';
import { Avatar, Banner, BlockStack, Box, Button, Icon, InlineStack, Text } from '@shopify/polaris';
import { CodeIcon } from '@shopify/polaris-icons';
import type { TrackingFinding } from '~/lib/tracking/detect';
import metaIcon from '~/assets/channel-meta.avif';
import googleIcon from '~/assets/channel-google.webp';
import tiktokIcon from '~/assets/channel-tiktok.webp';
import pinterestIcon from '~/assets/channel-pinterest.webp';
import { useT } from '~/lib/i18n/context';

// Icone dei canali che sappiamo riconoscere. Vite le trasforma in URL con hash
// al build, quindi non serve una cartella pubblica ne' un percorso scritto a
// mano che si romperebbe in silenzio.
//
// Le chiavi sono i nomi che assegna detectTrackingChannels, non quelli dei
// canali: "Google" copre sia "Google & YouTube" sia le sue varianti tradotte.
// Chi non e' elencato qui ricade sulle iniziali — Shopify non espone il logo
// delle app altrui, quindi ogni icona va aggiunta a mano.
const CHANNEL_ICONS: Record<string, string> = {
  Meta: metaIcon,
  Google: googleIcon,
  TikTok: tiktokIcon,
  Pinterest: pinterestIcon,
};

export interface TrackingConflictsProps {
  findings: TrackingFinding[];
  /** `https://admin.shopify.com/store/<negozio>`, per i collegamenti all'admin. */
  adminBase?: string;
  /** Id del tema pubblicato: senza, il collegamento all'editor non si costruisce. */
  themeId?: number | null;
  /**
   * Come si presenta. `banner` e' l'avviso giallo della dashboard a
   * configurazione conclusa; `plain` e' lo stesso contenuto senza cornice, per
   * quando vive gia' dentro il riquadro di un passo — un avviso dentro una card
   * sarebbe una cornice dentro l'altra.
   */
  variant?: 'banner' | 'plain';
}

/**
 * Avviso sulle altre fonti di eventi presenti sul negozio.
 *
 * Non compare quando non c'e' niente da dire. E' voluto: l'elenco e' per forza
 * parziale — alcuni strumenti non sono visibili a nessuna applicazione — quindi
 * un riquadro che dicesse "non ho trovato nulla" verrebbe letto come "sei a
 * posto", che e' precisamente cio' che non possiamo garantire.
 *
 * Ogni riga ha due strade, perche' il merchant ne sa piu' di noi: un canale puo'
 * essere collegato per il solo catalogo, con il tracciamento spento, e in quel
 * caso l'avviso e' rumore. Dichiararlo lo mette a tacere per sempre.
 */
/** Iniziali di un canale: "Facebook & Instagram" → "FI". */
function initials(name: string): string {
  return name
    .split(/[\s&]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

export function TrackingConflicts({
  findings,
  adminBase,
  themeId,
  variant = 'banner',
}: TrackingConflictsProps) {
  const t = useT();
  // Stato per riga, non uno solo per la tabella: le righe sono indipendenti, e
  // dichiarare Meta innocuo mentre si dichiara anche Google deve poter avvenire
  // insieme, con ciascuna riga che mostra la propria attesa.
  const [busy, setBusy] = useState<Record<string, 'dismiss' | 'leave' | 'restore'>>({});
  // Righe che il merchant ha appena dichiarato innocue. Restano dov'erano, con
  // una riga di testo al posto dei pulsanti: farle sparire sotto il dito
  // toglieva la conferma di quel che era appena successo, e lasciava il dubbio
  // di aver premuto l'altro pulsante. Alla riapertura non ci saranno piu' —
  // quella dichiarazione e' registrata sul server e vale da li' in poi.
  const [declared, setDeclared] = useState<Record<string, true>>({});

  /**
   * Le righe dichiarate in questa sessione, tenute in vita.
   *
   * Il server toglie dall'elenco cio' che risulta dichiarato: al primo
   * ricalcolo dei conflitti la riga appena dichiarata sparisce, e con lei il
   * pulsante per disdire — che a quel punto non esiste piu' da nessuna parte.
   * Qui la riga resta finche' il merchant non lascia la pagina, che e' l'unico
   * momento in cui puo' davvero avere finito di guardarla.
   */
  const [sticky, setSticky] = useState<TrackingFinding[]>([]);

  const rowKey = (finding: TrackingFinding) => `${finding.kind}-${finding.name}`;

  // fetch e non useFetcher: un fetcher solo per tutta la tabella verrebbe
  // riusato a ogni clic, e in Remix una seconda richiesta sullo stesso fetcher
  // annulla quella ancora in volo. Non si sarebbe perso solo il caricamento
  // della prima riga: si sarebbe potuta perdere la dichiarazione stessa.
  const dismiss = useCallback(
    async (finding: TrackingFinding) => {
      const key = `${finding.kind}-${finding.name}`;
      setBusy((current) => ({ ...current, [key]: 'dismiss' }));

      const body = new FormData();
      body.set('kind', finding.kind);
      body.set('name', finding.name);

      try {
        const response = await fetch('/api/tracking/dismiss', { method: 'POST', body });
        // Solo se il server l'ha registrata: una riga che si dichiara a posto
        // mentre la richiesta e' fallita tornerebbe alla riapertura, e nel
        // frattempo avrebbe detto il contrario di cio' che risulta.
        if (response.ok) {
          setDeclared((current) => ({ ...current, [key]: true }));
          setSticky((current) =>
            current.some((f) => `${f.kind}-${f.name}` === key) ? current : [...current, finding],
          );
        }
      } finally {
        // Sbloccare comunque: se la richiesta e' fallita, e' l'unico modo per
        // riprovare.
        setBusy((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [],
  );

  /**
   * Disdice la dichiarazione appena data.
   *
   * Un giudizio sul merito si puo' sbagliare — o si guarda meglio e si cambia
   * idea. Senza questo, l'unico modo per rivedere quell'avviso sarebbe non
   * vederlo mai piu': la dichiarazione vale da li' in avanti, anche alle
   * riaperture.
   */
  const restore = useCallback(
    async (finding: TrackingFinding) => {
      const key = `${finding.kind}-${finding.name}`;
      setBusy((current) => ({ ...current, [key]: 'restore' }));

      const body = new FormData();
      body.set('intent', 'restore');
      body.set('kind', finding.kind);
      body.set('name', finding.name);

      try {
        const response = await fetch('/api/tracking/dismiss', { method: 'POST', body });
        // Come per la dichiarazione: i pulsanti tornano solo se il server ha
        // davvero disfatto, altrimenti la riga direbbe una cosa e il database
        // un'altra.
        if (response.ok) {
          setDeclared((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          });
          // Disdetta la dichiarazione, la riga torna a farsi calcolare dal
          // server come tutte le altre: tenerla in vita qui la duplicherebbe.
          setSticky((current) => current.filter((f) => `${f.kind}-${f.name}` !== key));
        }
      } finally {
        setBusy((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [],
  );

  // Dove porta il pulsante di destra. Non esegue niente: accompagna il merchant
  // dove la cosa si fa davvero. Disinstallare un'app o modificare un tema non
  // sono azioni che quest'app puo' compiere, e fingere il contrario sarebbe
  // peggio che non offrirle.
  //
  // I canali stanno in settings/sales_channels e non in settings/apps: la
  // seconda elenca tutte le applicazioni installate, e il merchant si
  // troverebbe a cercare fra quelle quella che gli abbiamo appena segnalato.
  const actionUrl = (finding: TrackingFinding): string | null => {
    if (!adminBase) return null;
    if (finding.kind === 'channel') return `${adminBase}/settings/sales_channels`;
    return themeId ? `${adminBase}/themes/${themeId}` : null;
  };

  // L'uscita anticipata sta DOPO tutti gli hook, e non e' una questione di
  // stile: l'elenco arriva da una richiesta, quindi al primo render e' vuoto e
  // al secondo no. Con il `return` piu' in alto il secondo render eseguiva un
  // hook in piu' del primo, e React interrompeva la pagina intera con l'errore
  // #310 — "Rendered more hooks than during the previous render". E' quello che
  // faceva comparire "Si e' verificato un errore" al posto della dashboard.
  // L'elenco del server piu' le righe dichiarate qui, che il server non manda
  // piu'. L'ordine e' quello del server: le aggiunte vanno in coda, dove il
  // merchant le ha lasciate.
  const shown = [
    ...findings,
    ...sticky.filter(
      (f) => !findings.some((g) => g.kind === f.kind && g.name === f.name),
    ),
  ];

  if (shown.length === 0) return null;

  const content = (
      <BlockStack gap="300">
        <Text as="p">{t.tracking.conflicts.intro}</Text>

        <BlockStack gap="200">
          {shown.map((finding) => {
            const url = actionUrl(finding);
            const key = rowKey(finding);
            // Entrambi i pulsanti della riga si spengono, ovunque si sia
            // premuto: la riga sta gia' facendo qualcosa, e l'altra azione
            // sarebbe un ripensamento a meta' strada.
            const rowBusy = busy[key] !== undefined;
            return (
              // I pulsanti seguono il nome invece di essere spinti al bordo
              // opposto del riquadro: a tutta larghezza l'occhio doveva
              // attraversare mezzo schermo per collegare la riga alla sua
              // azione. La colonna del nome ha una larghezza minima, cosi' i
              // pulsanti restano comunque incolonnati fra una riga e l'altra.
              <InlineStack key={key} blockAlign="center" gap="400">
                <Box minWidth="260px">
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  {/* Segno visivo della riga. NON e' il logo dell'app: Shopify
                      non espone l'icona delle applicazioni altrui — verificato,
                      `catalog` torna null su ogni canale — e disegnare noi il
                      marchio di Meta o Google sarebbe usare un segno che non ci
                      appartiene per parlare di loro. Le iniziali del canale
                      distinguono le righe senza spacciarsi per altro. */}
                  {finding.kind !== 'channel' ? (
                    <Icon source={CodeIcon} tone="subdued" />
                  ) : CHANNEL_ICONS[finding.name] ? (
                    <img
                      src={CHANNEL_ICONS[finding.name]}
                      alt=""
                      width={24}
                      height={24}
                      style={{ borderRadius: 'var(--p-border-radius-100)', display: 'block' }}
                    />
                  ) : (
                    // Canale di cui non abbiamo l'icona: le iniziali. Shopify non
                    // espone il logo delle app altrui (verificato: `catalog` torna
                    // null), quindi ogni icona va aggiunta a mano qui sopra.
                    <Avatar size="sm" name={finding.where} initials={initials(finding.where)} />
                  )}
                  {/* Il nome che il merchant riconosce e' quello dell'app come la
                      vede nel suo admin ("Facebook & Instagram"), non il nome della
                      piattaforma dietro ("Meta"): e' quello che deve andare a
                      cercare fra i canali. Per il codice nel tema il nome dello
                      strumento e' invece l'unica cosa che serve. */}
                  <Text as="span" fontWeight="semibold">
                    {finding.kind === 'channel' ? finding.where : finding.name}
                  </Text>
                </InlineStack>
                </Box>

                {declared[key] ? (
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <Text as="span" tone="subdued">
                      {finding.kind === 'channel'
                        ? t.tracking.conflicts.declaredChannel
                        : t.tracking.conflicts.declaredCode}
                    </Text>
                    <Button
                      onClick={() => restore(finding)}
                      loading={busy[key] === 'restore'}
                      disabled={rowBusy}
                    >
                      {t.common.cancel}
                    </Button>
                  </InlineStack>
                ) : (
                <InlineStack gap="200">
                  <Button
                    onClick={() => dismiss(finding)}
                    disabled={rowBusy}
                    loading={busy[key] === 'dismiss'}
                  >
                    {finding.kind === 'channel'
                      ? t.tracking.conflicts.channelHarmless
                      : t.tracking.conflicts.codeHarmless}
                  </Button>
                  {/* _top e non una scheda nuova: l'admin di Shopify rifiuta di
                      essere incorniciato, quindi un collegamento normale da qui
                      dentro finisce in "Connessione negata". Si esce dal riquadro
                      dell'app restando nella stessa scheda. */}
                  <Button
                    variant="primary"
                    url={url ?? undefined}
                    target="_top"
                    disabled={!url || rowBusy}
                    loading={busy[key] === 'leave'}
                    onClick={() => setBusy((current) => ({ ...current, [key]: 'leave' }))}
                  >
                    {finding.kind === 'channel'
                      ? t.tracking.conflicts.uninstall
                      : t.tracking.conflicts.removeSnippet}
                  </Button>
                </InlineStack>
                )}
              </InlineStack>
            );
          })}
        </BlockStack>

        <Text as="p" tone="subdued">
          {t.tracking.conflicts.incomplete}
        </Text>
      </BlockStack>
  );

  if (variant === 'plain') return content;

  return (
    <Banner tone="warning" title={t.tracking.conflicts.title}>
      {content}
    </Banner>
  );
}
