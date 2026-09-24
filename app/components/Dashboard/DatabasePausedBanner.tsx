import { useEffect, useRef } from 'react';
import { useFetcher } from '@remix-run/react';
import { Banner, BlockStack, Button, InlineStack, Text } from '@shopify/polaris';
import { databaseIsStopped } from '~/lib/supabase/database-pause';
import type { DatabasePauseView } from '~/lib/supabase/database-pause.server';
import { useT } from '~/lib/i18n/context';

/** Dove si chiede lo stato e dove si chiede la riattivazione: lo stesso posto. */
const PATH = '/api/supabase/database-pause';

/**
 * Ogni quanto il banner ricontrolla, mentre il database e' fermo.
 *
 * Mezzo minuto, e vale solo finche' c'e' qualcosa da segnalare: e' l'attesa fra
 * "il database e' ripartito" e "l'avviso sparisce da solo". A database acceso
 * qui non gira niente. Il ricontrollo non arriva comunque a Supabase a ogni
 * giro: la rotta ha dentro il suo freno.
 */
const RICONTROLLO_MS = 30_000;

/** Esito della richiesta di riattivazione, come la rotta lo scrive. */
interface ResumeResult {
  ok?: boolean;
  code?: 'reconnect' | 'no_permission' | 'rate_limited' | 'failed' | 'not_connected';
  dashboardUrl?: string | null;
}

/**
 * Il database del merchant e' in pausa.
 *
 * PERCHE' ESISTE. Un progetto gratuito che nessuno tocca per un po' viene messo
 * in pausa: i dati restano tutti dove sono, ma il database smette di rispondere
 * e la sincronizzazione si ferma. Nell'app non si vedeva: le card restavano
 * vuote e il merchant leggeva un negozio senza numeri invece di un database
 * spento — senza sapere che cosa fosse successo, e senza sapere che bastava un
 * clic.
 *
 * IL TONO E' WARNING PER TUTTA LA VICENDA, riattivazione in corso compresa.
 * Finche' il database non risponde la sincronizzazione e' ferma e i numeri che
 * il merchant guarda sono vecchi: e' un problema che dura, e non diventa
 * un'informazione solo perche' lui ha gia' premuto il pulsante. Si esce dal
 * warning quando il database e' davvero tornato — e li' l'avviso SPARISCE,
 * non si ammorbidisce.
 *
 * NON SI CHIUDE. Un avviso che dice che i dati a schermo sono fermi non deve
 * poter sparire lasciando i dati dove sono, ed e' la stessa ragione per cui non
 * si chiude l'avviso dei prodotti fermi qui accanto.
 *
 * I dati se li procura da se', come `ProductScopeBanner`: cosi' le pagine che
 * lo mostrano non se li devono caricare ognuna nel proprio loader, e soprattutto
 * non possono finire a dire due cose diverse sullo stesso database.
 */
export function DatabasePausedBanner() {
  const t = useT();
  const stato = useFetcher<DatabasePauseView>();
  const riattiva = useFetcher<ResumeResult>();

  useEffect(() => {
    if (stato.state === 'idle' && !stato.data) stato.load(PATH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fermo = stato.data ? databaseIsStopped(stato.data.availability) : false;

  useEffect(() => {
    if (!fermo) return;
    const timer = setInterval(() => {
      if (stato.state === 'idle') stato.load(PATH);
    }, RICONTROLLO_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fermo, stato.state]);

  // Dopo il clic si rilegge lo stato, una volta sola per risposta: e' quella
  // rilettura che porta a schermo il "riattivazione in corso" scritto sul
  // server — cioe' quello che sopravvive al cambio di scheda, non quello che
  // vive in questa pagina.
  const ultimaRisposta = useRef<ResumeResult | null>(null);
  useEffect(() => {
    if (riattiva.state !== 'idle' || !riattiva.data) return;
    if (riattiva.data === ultimaRisposta.current) return;
    ultimaRisposta.current = riattiva.data;
    stato.load(PATH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riattiva.state, riattiva.data]);

  if (!stato.data || !databaseIsStopped(stato.data.availability)) return null;

  const riattivando = stato.data.availability === 'in-riattivazione';
  // A premere e' stata l'app: e' un'altra notizia, e va data. Il merchant non
  // ha chiesto niente, quindi "stiamo facendo quel che hai chiesto" qui sarebbe
  // falso — e soprattutto gli toglierebbe l'unica occasione di sapere che l'app
  // gli ha riacceso il database.
  const riaccesoDaNoi = riattivando && stato.data.resumedByApp;
  const avviso = riaccesoDaNoi ? t.databasePaused.autoResumed : t.databasePaused.resuming;
  const esito = riattiva.data;
  const errore =
    esito && esito.ok === false ? messaggioErrore(esito.code, t.databasePaused.errors) : null;

  // Il pulsante c'e' solo se puo' funzionare davvero. Quando non puo' —
  // permesso mancante, collegamento da rifare, riattivazione gia' in corso —
  // resta la strada che riesce, che e' la pagina del database su Supabase. Un
  // pulsante che non riattiva niente e' peggio di nessun pulsante.
  const mostraPulsante = stato.data.canResume && !riattivando;
  const dashboardUrl = stato.data.dashboardUrl ?? esito?.dashboardUrl ?? null;

  return (
    <Banner
      tone="warning"
      title={riattivando ? avviso.title : t.databasePaused.title}
    >
      <BlockStack gap="200">
        {riattivando ? (
          <>
            <Text as="p">{avviso.body}</Text>
            <Text as="p">{avviso.stillStopped}</Text>
          </>
        ) : (
          <>
            <Text as="p">{t.databasePaused.dataSafe}</Text>
            <Text as="p">{t.databasePaused.syncStopped}</Text>
            {/* La data di scadenza e' l'informazione che il merchant non puo'
                permettersi di non vedere: dopo quella il database non torna
                piu'. La data esatta non la sappiamo — inventarla sarebbe peggio
                che non darla — quindi si dice che il tempo e' limitato e dove
                la data e' scritta. */}
            <Text as="p" fontWeight="semibold">
              {t.databasePaused.deadline}
            </Text>
            {/* Che l'app lo riaccendera' da sola va detto QUI, mentre il
                database e' ancora fermo e prima che succeda: dopo sarebbe una
                giustificazione, non un avviso. Compare solo se l'interruttore
                e' acceso davvero — promettere un intervento che non arrivera'
                sarebbe peggio che non prometterlo. */}
            {stato.data.autoResumeOn && (
              <Text as="p">{t.databasePaused.willAutoResume}</Text>
            )}
          </>
        )}

        {errore && <Text as="p">{errore}</Text>}

        <InlineStack gap="300" blockAlign="center">
          {mostraPulsante && (
            <Button
              onClick={() => riattiva.submit({}, { method: 'post', action: PATH })}
              loading={riattiva.state !== 'idle'}
            >
              {t.databasePaused.action}
            </Button>
          )}
          {dashboardUrl && (
            // Button e non Link: dentro un Banner, Polaris spegne i Link
            // rendendoli monocromatici. Stessa ragione di `PlanLimitBanner`.
            <Button variant="plain" url={dashboardUrl} target="_blank">
              {t.databasePaused.openDashboard}
            </Button>
          )}
        </InlineStack>
      </BlockStack>
    </Banner>
  );
}

/**
 * Un rifiuto, un messaggio: sono situazioni opposte per chi legge.
 *
 * "Non abbiamo il permesso" vuol dire che premere ancora non servira' mai e il
 * gesto va fatto altrove; "troppe richieste" vuol dire aspettare qualche
 * minuto. Un unico "non riuscito" manderebbe meta' dei merchant ad aspettare
 * una cosa che non arriva.
 */
function messaggioErrore(
  code: ResumeResult['code'],
  errors: {
    noPermission: string;
    reconnect: string;
    rateLimited: string;
    failed: string;
  },
): string {
  switch (code) {
    case 'no_permission':
      return errors.noPermission;
    case 'reconnect':
      return errors.reconnect;
    case 'rate_limited':
      return errors.rateLimited;
    default:
      // 'not_connected' compreso: non dovrebbe arrivarci nessuno (senza un
      // database collegato questo avviso non compare), e se ci arriva la cosa
      // utile da dire e' comunque quella generica con la strada alternativa.
      return errors.failed;
  }
}
