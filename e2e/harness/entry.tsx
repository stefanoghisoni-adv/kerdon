// e2e/harness/entry.tsx
//
// Il banco di prova: un componente vero, dentro la sua cornice vera, in un
// browser vero.
//
// COSA NON E'. Non e' una copia semplificata del selettore del periodo ne' una
// riscrittura per i test. Monta `DateRangePicker` come lo monta la dashboard,
// con lo stesso Polaris, lo stesso dizionario, gli stessi tre fogli di stile e
// nello stesso ordine — force-light DOPO Polaris, dashboard per ultimo, che e'
// l'ordine da cui dipendono meta' delle regole di `.range-picker__*`. Un banco
// che carica gli stessi file in un ordine diverso proverebbe un'altra pagina.
//
// COSA CI FA QUI E NON NELLA DASHBOARD. La dashboard vive dentro l'iframe
// dell'admin di Shopify e non si apre senza un gettone di sessione firmato:
// portarcela dentro vorrebbe dire o le credenziali vere — mai — o simulare
// meta' App Bridge, cioe' provare la simulazione invece del componente. Qui
// non c'e' niente da simulare: l'impaginazione, il fuoco, la tastiera e le
// sovrapposizioni non sanno di essere in un iframe.
//
// TUTTO ARRIVA DALLA URL, e non da un pannello di comandi: `?now=` ferma
// l'orologio, `?locale=` sceglie la lingua, `?from=`/`?to=` il periodo gia'
// applicato, `?tz=` il fuso del negozio. Cosi' una prova e' un indirizzo, e un
// fallimento si riapre a mano incollandolo nel browser.

import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { freezeClock } from './clock';

// Nello stesso ordine di root.tsx: Polaris, il tema chiaro forzato, e per
// ultimo il foglio dell'app. Invertirli qui renderebbe verdi prove che nella
// pagina vera sarebbero rosse.
import '@shopify/polaris/build/esm/styles.css';
import '~/force-light.css';
import '~/dashboard.css';

const params = new URLSearchParams(window.location.search);

// Prima di ogni altra cosa: un componente che ha gia' letto l'ora non la
// rilegge. Per questo i moduli dell'app si caricano DOPO, con un import
// dinamico — gli import statici verrebbero eseguiti prima di questa riga.
freezeClock(params.get('now') ?? '2026-08-26T10:00:00.000Z');

const [{ AppProvider }, { I18nProvider }, { polarisTranslations }, picker] = await Promise.all([
  import('@shopify/polaris'),
  import('~/lib/i18n/context'),
  import('~/lib/i18n/polaris'),
  import('~/components/Dashboard/DateRangePicker'),
]);
const { DateRangePicker, ComparisonSelect } = picker;

const locale = params.get('locale') === 'en' ? 'en' : 'it';
const timeZone = params.get('tz') ?? 'Europe/Rome';

function Banco() {
  const [range, setRange] = useState({
    from: params.get('from') ?? '2026-07-28',
    to: params.get('to') ?? '2026-08-26',
  });
  const [comparison, setComparison] = useState<'none' | 'previousPeriod' | 'previousYear' | 'previousYearWeekday'>(
    'none',
  );
  // Quante volte il selettore ha applicato: distingue "ha applicato lo stesso
  // periodo" da "non ha applicato niente", che guardando le sole due date sono
  // indistinguibili.
  const [applications, setApplications] = useState(0);

  return (
    <div style={{ padding: 16 }}>
      {/* Un elemento da mettere a fuoco PRIMA dell'attivatore: serve alle prove
          di Shift+Tab, che senza un "prima" non hanno un posto dove tornare. */}
      <button type="button" data-testid="before">
        prima
      </button>

      <div style={{ display: 'flex', gap: 8, marginBlock: 12 }} data-testid="filters">
        <DateRangePicker value={range} timeZone={timeZone} onChange={(next) => {
          setRange(next);
          setApplications((n) => n + 1);
        }} />
        <ComparisonSelect value={comparison} range={range} onChange={setComparison} />
      </div>

      <button type="button" data-testid="after">
        dopo
      </button>

      {/* Cio' che il filtro di fuori sta usando davvero: e' l'unica prova che
          "Applica" ha applicato, e che Annulla non ha applicato. */}
      <output data-testid="applied-range">{`${range.from}..${range.to}`}</output>
      <output data-testid="applied-count">{applications}</output>
      <output data-testid="applied-comparison">{comparison}</output>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider i18n={polarisTranslations(locale)}>
      <I18nProvider locale={locale}>
        <Banco />
      </I18nProvider>
    </AppProvider>
  </StrictMode>,
);
