import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionList,
  Button,
  DatePicker,
  Divider,
  Icon,
  Popover,
  TextField,
} from '@shopify/polaris';
import {
  CalendarIcon,
  ArrowRightIcon,
  ArrowsInHorizontalIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@shopify/polaris-icons';
import {
  comparisonRange,
  dayPlaceholder,
  formatDayNumeric,
  formatRange,
  fromIso,
  fromLocalDate,
  groupOfLeaf,
  HEAD_LEAVES,
  leafKey,
  leafRange,
  matchLeaf,
  orderRange,
  parseDay,
  presetGroups,
  todayIn,
  toLocalDate,
  type ComparisonId,
  type DateRange,
  type GroupId,
  type PresetLeaf,
} from '~/lib/dates/ranges';
import { useLocale, useT } from '~/lib/i18n/context';
import type { Dictionary } from '~/lib/i18n/context';
import { draftVerdict } from './date-range-state';

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  disabled?: boolean;
  /**
   * Il fuso del negozio, come lo dichiara a Shopify.
   *
   * Serve a sapere che giorno e' per il merchant. Senza, "oggi" era il giorno
   * del server: a Roma dopo mezzanotte si guardava ancora ieri, a Los Angeles
   * dopo le sedici gia' domani. Assente = UTC, che e' cio' che c'era prima.
   */
  timeZone?: string | null;
}

/**
 * Il nome di una voce, quale che sia la sua forma.
 *
 * I periodi senza anno hanno un nome scritto nel dizionario; trimestri e Black
 * Friday no, perche' sono una famiglia infinita e l'anno va composto ogni volta.
 */
export function leafLabel(leaf: PresetLeaf, t: Dictionary): string {
  switch (leaf.kind) {
    case 'preset':
      return t.dates.presets[leaf.preset];
    case 'quarter':
      return t.dates.quarter(leaf.quarter, leaf.year);
    case 'bfcm':
      return t.dates.bfcm(leaf.year);
  }
}

/** L'identificativo del campo d'inizio: serve a portarci il fuoco. */
const START_FIELD_ID = 'range-picker-start';

/**
 * La scelta del periodo.
 *
 * A sinistra i periodi che si chiedono per nome, a destra il calendario per le
 * due date che nome non hanno. Sono due modi di rispondere alla stessa domanda,
 * e stanno insieme perche' chi apre non sa ancora quale dei due gli serve:
 * apre per "il mese scorso" e si accorge che gli servono i primi dieci giorni.
 *
 * I periodi stanno su due livelli, e il secondo SOSTITUISCE il primo invece di
 * aprirsi sotto. E' la differenza che tiene ferma l'altezza: un elenco che si
 * allunga aprendo un gruppo spinge il piede piu' in basso del calendario, e
 * lascia a fianco una fascia vuota alta quanto il gruppo. Cosi' invece la
 * colonna mostra sempre un pannello solo, e "Indietro" riporta all'elenco.
 *
 * Niente si applica finche' non si preme Applica, e Applica e' spento finche'
 * non c'e' qualcosa da applicare.
 */
/**
 * Il mese spostato di `delta`, con l'anno che segue.
 *
 * Polaris conta i mesi da zero, quindi dicembre + 1 fa 12 e non esiste: il
 * `Date` lo normalizza da se', ed e' il motivo per cui si passa da li' invece
 * di fare il conto a mano.
 */
function shiftMonth(month: number, year: number, delta: number): { month: number; year: number } {
  const next = new Date(year, month + delta, 1);
  return { month: next.getMonth(), year: next.getFullYear() };
}

export function DateRangePicker({
  value,
  onChange,
  disabled,
  timeZone,
}: DateRangePickerProps) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  // Due stati distinti e non uno: `value` e' cio' che il filtro di fuori sta
  // gia' usando, `draft` e' cio' che si sta scegliendo. Il primo lo cambia solo
  // apply(), e da nessun'altra parte.
  const [draft, setDraft] = useState<DateRange>(value);

  // Oggi per il negozio, in tre forme perche' tre sono i modi in cui serve: il
  // giorno di calendario per i confronti, la data UTC per i conti sui periodi,
  // la data locale per il calendario di Polaris.
  const todayIso = todayIn(timeZone);
  const todayUtc = useMemo(() => fromIso(todayIso), [todayIso]);
  const todayLocal = useMemo(() => toLocalDate(todayIso), [todayIso]);

  const [{ month, year }, setVisible] = useState(() => monthsEndingAt(value.to, todayLocal));
  // Quale pannello si sta guardando: null e' l'elenco principale.
  const [panel, setPanel] = useState<GroupId | null>(null);

  const groups = useMemo(() => presetGroups(todayUtc), [todayUtc]);
  const selectedKey = useMemo(() => {
    const leaf = matchLeaf(draft, todayUtc);
    return leaf ? leafKey(leaf) : null;
  }, [draft, todayUtc]);
  // Nessuna voce descrive la bozza: e' un intervallo personalizzato. Non e' una
  // voce come le altre, e' l'assenza di tutte.
  const isCustom = selectedKey === null;

  const verdict = draftVerdict(draft, value, todayIso);

  /**
   * Aprire azzera la bozza su cio' che e' applicato adesso.
   *
   * Si fa qui e non in un effetto legato a [open, value]: quell'effetto
   * riscriveva la bozza anche quando `value` cambiava a tendina APERTA, cioe'
   * cancellava una scelta in corso per un aggiornamento arrivato da fuori.
   * Legato al solo gesto di apertura la strada non esiste piu'.
   */
  const openPicker = useCallback(() => {
    setDraft(value);
    setVisible(monthsEndingAt(value.to, todayLocal));
    const leaf = matchLeaf(value, todayUtc);
    setPanel(leaf ? groupOfLeaf(leaf, todayUtc) : null);
    setOpen(true);
  }, [value, todayLocal, todayUtc]);

  /** Annulla, Esc e il clic fuori sono la stessa cosa: la bozza si butta via. */
  const cancel = useCallback(() => {
    setDraft(value);
    setPanel(null);
    setOpen(false);
  }, [value]);

  const chooseLeaf = useCallback(
    (leaf: PresetLeaf) => {
      const range = leafRange(leaf, todayUtc);
      if (!range) return;
      setDraft(range);
      setVisible(monthsEndingAt(range.to, todayLocal));
    },
    [todayUtc, todayLocal],
  );

  const placeholder = dayPlaceholder(locale, t.dates.dayParts);

  const apply = () => {
    // La guardia c'e' anche se il pulsante e' spento: spento e' una cosa che si
    // vede, non una che impedisce di arrivarci.
    if (!verdict.canApply) return;
    onChange(draft);
    setOpen(false);
  };

  /** Una voce che sceglie un periodo, con il suo stato detto anche a voce. */
  const leafItem = (leaf: PresetLeaf) => {
    const label = leafLabel(leaf, t);
    const active = selectedKey === leafKey(leaf);
    return {
      content: label,
      active,
      // Lo sfondo e il grassetto dicono "scelto" a chi guarda. ActionList non
      // espone aria-pressed, quindi a chi ascolta lo si dice con una parola.
      accessibilityLabel: active ? t.dates.selectedLabel(label) : undefined,
      onAction: () => chooseLeaf(leaf),
    };
  };

  /** Un capofila: apre il suo pannello, non sceglie niente. */
  const parentItem = (group: (typeof groups)[number]) => {
    const label = t.dates.groups[group.id];
    const holdsSelection = group.leaves.some((leaf) => leafKey(leaf) === selectedKey);
    return {
      content: label,
      suffix: <Icon source={ChevronRightIcon} />,
      // Il capofila resta evidenziato quando la voce scelta e' una delle sue:
      // il pannello e' chiuso, e senza questo la selezione sparirebbe dalla
      // vista e la tendina sembrerebbe senza scelta.
      active: holdsSelection,
      accessibilityLabel: holdsSelection ? t.dates.selectedLabel(label) : undefined,
      onAction: () => setPanel(group.id),
    };
  };

  const openGroup = panel ? groups.find((group) => group.id === panel) : undefined;

  return (
    <Popover
      active={open}
      onClose={cancel}
      preferredAlignment="left"
      preferredPosition="below"
      // Quello che si apre e' un riquadro con dentro dei comandi e un piede,
      // non un elenco: chi naviga con lo screen reader deve sentirlo annunciare
      // come tale prima di entrarci.
      ariaHaspopup="dialog"
      // Senza, Polaris tiene la tendina alla larghezza dell'attivatore e
      // ritaglia il resto: due mesi affiancati e una colonna di periodi non ci
      // stanno in un pulsante.
      fluidContent
      fullHeight
      activator={
        <Button
          icon={CalendarIcon}
          disclosure
          disabled={disabled}
          onClick={() => (open ? cancel() : openPicker())}
        >
          {formatRange(value, locale)}
        </Button>
      }
    >
      {/* Tre zone, come nel selettore dell'analytics di Shopify: i periodi a
          sinistra, i campi e il calendario al centro, i comandi in un piede
          separato da una riga. Il piede staccato e' la differenza che si nota
          di piu': prima Annulla e Applica galleggiavano sotto il calendario e
          si confondevano con i giorni. */}
      <div className="range-picker">
        <div className="range-picker__sidebar">
          {openGroup ? (
            /* Il pannello di un gruppo: il comando per tornare, poi le sue
               voci. Non c'e' altro — chi e' entrato in "Trimestri" sta
               scegliendo un trimestre. */
            <>
              <ActionList
                actionRole="menuitem"
                items={[
                  {
                    content: t.dates.back,
                    prefix: <Icon source={ChevronLeftIcon} />,
                    onAction: () => setPanel(null),
                  },
                ]}
              />
              <Divider />
              <ActionList actionRole="menuitem" items={openGroup.leaves.map(leafItem)} />
            </>
          ) : (
            <>
              {/* Oggi e Ieri senza capofila sopra: sono le due che si scelgono
                  di gran lunga piu' spesso, e metterle dentro un gruppo da
                  aprire costerebbe un clic proprio dove non deve costarne. */}
              <ActionList actionRole="menuitem" items={HEAD_LEAVES.map(leafItem)} />
              <Divider />
              <ActionList
                actionRole="menuitem"
                items={groups.slice(0, 2).map(parentItem)}
              />
              <Divider />
              <ActionList actionRole="menuitem" items={groups.slice(2).map(parentItem)} />
              <Divider />
              {/* Intervallo personalizzato non calcola niente: e' il nome di
                  dove ci si trova quando nessun'altra voce descrive le due
                  date. Premerlo porta il fuoco sul primo campo, che e' la cosa
                  che si voleva fare venendo qui. */}
              <ActionList
                actionRole="menuitem"
                items={[
                  {
                    content: t.dates.presets.custom,
                    active: isCustom,
                    accessibilityLabel: isCustom
                      ? t.dates.selectedLabel(t.dates.presets.custom)
                      : undefined,
                    onAction: () => document.getElementById(START_FIELD_ID)?.focus(),
                  },
                ]}
              />
            </>
          )}
        </div>

        <div className="range-picker__main">
          <div className="range-picker__body">
            {/* Le due date anche scritte: chi le conosce gia' le batte a
                macchina piu' in fretta di quanto sfogli i mesi.

                Tre celle sulla griglia, non quattro: il periodo si sceglie a
                giorni interi e un'ora non c'e' — ne' un posto vuoto dove
                metterla, che a schermo si leggerebbe come un campo mancante. */}
            <div className="range-picker__fields">
              <DateField
                id={START_FIELD_ID}
                label={t.dates.start}
                value={draft.from}
                placeholder={placeholder}
                onCommit={(next) => {
                  const range = orderRange(notInTheFuture(next, todayIso), draft.to);
                  setDraft(range);
                  // Si restituisce la data ACCETTATA, non quella letta: vedi
                  // il commento su onCommit in DateField.
                  return range.from;
                }}
              />
              {/* Una freccia, non un pulsante spento: indica il verso e basta,
                  e un pulsante disabilitato invita a premerlo. Icon senza
                  accessibilityLabel esce gia' aria-hidden: e' un disegno, e
                  ripetuto a voce fra i due campi sarebbe solo rumore. */}
              <span className="range-picker__arrow">
                <Icon source={ArrowRightIcon} tone="subdued" />
              </span>
              <DateField
                label={t.dates.end}
                value={draft.to}
                placeholder={placeholder}
                onCommit={(next) => {
                  const range = orderRange(draft.from, notInTheFuture(next, todayIso));
                  setDraft(range);
                  return range.to;
                }}
              />
            </div>

            <div className="range-picker__calendar">
              {/* La navigazione fra i mesi, nostra.

                  Quella di Polaris e' un blocco in posizione assoluta ancorato
                  in alto: dentro due calendari affiancati cade sulla riga dei
                  giorni della settimana invece che su quella del titolo, e porta
                  due frecce lunghe dove nel resto dell'admin ci sono due
                  virgolette angolari. Il componente non espone nessuna prop per
                  cambiarle, ma il mese lo governiamo noi — `month`, `year` e
                  `onMonthChange` sono gia' nostri — quindi la barra la
                  disegniamo, e quella nativa si nasconde nel foglio di stile.

                  Un mese per volta, in tutti e due i sensi: i due calendari sono
                  sempre consecutivi, e farli scorrere di uno alla volta e' cio'
                  che permette di raggiungere un intervallo a cavallo di due mesi
                  senza saltarlo. */}
              <div className="range-picker__months">
                <Button
                  variant="tertiary"
                  icon={ChevronLeftIcon}
                  accessibilityLabel={t.dates.previousMonth}
                  onClick={() => setVisible(shiftMonth(month, year, -1))}
                />
                <Button
                  variant="tertiary"
                  icon={ChevronRightIcon}
                  accessibilityLabel={t.dates.nextMonth}
                  onClick={() => setVisible(shiftMonth(month, year, 1))}
                />
              </div>

              <DatePicker
                month={month}
                year={year}
                multiMonth
                allowRange
                // Lunedi': e' il primo giorno della settimana ovunque l'app
                // parli, e una settimana che parte di domenica sposta di un
                // giorno la lettura di "questa settimana".
                weekStartsOn={1}
                // Il futuro non si sceglie: di la' non ci sono ordini, e un
                // periodo che finisce fra due settimane restituisce card vuote
                // che sembrano un guasto. Spegnerlo nel calendario e' meglio
                // che spiegarlo dopo con un messaggio d'errore.
                disableDatesAfter={todayLocal}
                selected={{ start: toLocalDate(draft.from), end: toLocalDate(draft.to) }}
                onMonthChange={(nextMonth, nextYear) =>
                  setVisible({ month: nextMonth, year: nextYear })
                }
                onChange={({ start, end }) =>
                  setDraft(orderRange(fromLocalDate(start), fromLocalDate(end)))
                }
              />
            </div>
          </div>

          <div className="range-picker__footer">
            <Divider />
            <div className="range-picker__actions">
              <Button onClick={cancel}>{t.common.cancel}</Button>
              {/* Spento finche' la bozza non dice qualcosa di nuovo e di
                  valido. Riaprire e richiudere senza toccare niente non deve
                  offrire un comando che non farebbe nulla. */}
              <Button variant="primary" disabled={!verdict.canApply} onClick={apply}>
                {t.dates.apply}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Popover>
  );
}

/**
 * Una data scritta a mano non puo' superare oggi.
 *
 * Il calendario il futuro non lo lascia nemmeno premere, ma i due campi si
 * possono battere a macchina: senza questo, quella strada resterebbe aperta e
 * la regola varrebbe solo per chi usa il mouse. Il confronto fra stringhe
 * `YYYY-MM-DD` e' un confronto fra date, in quel formato.
 */
function notInTheFuture(value: string, today: string): string {
  return value > today ? today : value;
}

/**
 * I due mesi da mostrare, ancorati alla FINE del periodo.
 *
 * Il calendario ne affianca due: quello indicato e il successivo. Ancorandolo
 * all'inizio si finiva per mostrare il mese corrente e quello dopo — cioe' una
 * meta' di calendario tutta nel futuro, da saltare ogni volta. Ci si ancora
 * invece alla fine, che e' il punto che si sta guardando, e si arretra di uno:
 * a destra il mese della fine, a sinistra quello prima.
 *
 * L'ancora non supera il mese corrente, cosi' la meta' destra non finisce mai
 * oltre l'oggi. Il conto si fa in mesi assoluti proprio per non dover trattare
 * gennaio a parte: arretrare da gennaio da' dicembre dell'anno prima da solo.
 */
export function monthsEndingAt(endIso: string, today: Date): { month: number; year: number } {
  const end = fromIso(endIso);
  const endIndex = end.getUTCFullYear() * 12 + end.getUTCMonth();
  const todayIndex = today.getFullYear() * 12 + today.getMonth();
  const shown = Math.min(endIndex, todayIndex) - 1;
  return { month: ((shown % 12) + 12) % 12, year: Math.floor(shown / 12) };
}

/**
 * Una data scritta a mano.
 *
 * A schermo e in lettura si usa la forma della lingua — 25/08/2026 per un
 * italiano — non `AAAA-MM-GG`: quella e' la forma in cui l'app conserva le
 * date, non quella in cui il merchant le scrive e le riconosce. In scrittura si
 * accettano entrambe, piu' qualunque separatore (vedi parseDay): chi copia una
 * data da altrove non deve riformattarla.
 *
 * Si applica quando si esce dal campo o si preme Invio, non a ogni lettera:
 * mentre si scrive "25/08" la data e' incompleta, e reagire a ogni battuta
 * farebbe saltare il calendario a mesi che nessuno ha chiesto.
 */
function DateField({
  id,
  label,
  value,
  placeholder,
  onCommit,
}: {
  id?: string;
  label: string;
  value: string;
  placeholder: string;
  /**
   * Consegna la data letta e restituisce quella ACCETTATA.
   *
   * Non restituiva niente, e da li' nasceva il difetto. Chi riceve la data puo'
   * cambiarla — il futuro viene riportato a oggi, una fine anteriore all'inizio
   * fa scambiare i due estremi — e il campo lo scopriva solo di rimbalzo, dal
   * cambiamento della prop `value`. Quando la data accettata coincideva con
   * quella che il campo aveva gia', `value` non cambiava, l'effetto non
   * scattava, e a schermo restava cio' che era stato battuto: il 31 dicembre in
   * un campo che vale il 26 agosto, accanto a un "Applica" spento che non
   * spiega perche'. Restituendola, il campo mostra sempre la data che verra'
   * davvero applicata.
   */
  onCommit: (value: string) => string;
}) {
  const locale = useLocale();
  const [text, setText] = useState(() => formatDayNumeric(value, locale));
  useEffect(() => setText(formatDayNumeric(value, locale)), [value, locale]);

  const commit = () => {
    const parsed = parseDay(text, locale);
    if (parsed) {
      // Si riscrive sulla data ACCETTATA e non su quella letta. Serve a due
      // casi diversi che senza questa riga si comportano male allo stesso
      // modo: la scrittura abbreviata da normalizzare ("8/1/26" invece di
      // "08/01/2026"), e la data che il selettore ha corretto — riportata a
      // oggi, o scambiata con l'altro estremo. Nel secondo caso la prop
      // `value` puo' non cambiare affatto, l'effetto qui sotto non riscatta, e
      // a schermo resterebbe una data che non verra' mai applicata.
      setText(formatDayNumeric(onCommit(parsed), locale));
    } else {
      // Non e' una data: si torna a quella buona invece di lasciare a schermo
      // qualcosa che non verrebbe applicato.
      setText(formatDayNumeric(value, locale));
    }
  };

  return (
    // L'Invio si intercetta sul contenitore: TextField di Polaris non espone
    // onKeyDown, e senza Invio si dovrebbe uscire dal campo per applicare.
    <div
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    >
      <TextField
        id={id}
        label={label}
        labelHidden
        value={text}
        onChange={setText}
        onBlur={commit}
        // Il formato atteso scritto nel campo: senza, chi lo trova vuoto non sa
        // se si scrive 03/04 o 04/03, e lo scopre solo sbagliando.
        placeholder={placeholder}
        autoComplete="off"
        inputMode="numeric"
      />
    </div>
  );
}

export interface ComparisonSelectProps {
  value: ComparisonId;
  onChange: (value: ComparisonId) => void;
  /** Il periodo scelto: serve a mostrare quali date verrebbero confrontate. */
  range: DateRange;
  disabled?: boolean;
}

const COMPARISONS: ComparisonId[] = [
  'none',
  'previousPeriod',
  'previousYear',
  'previousYearWeekday',
];

/**
 * Con che cosa confrontare il periodo.
 *
 * Separato dal calendario e non dentro: sono due domande diverse, e chi cambia
 * periodo quasi mai vuole cambiare anche il confronto. Tenerle insieme
 * costringerebbe a riconfermare ogni volta una scelta che non e' cambiata.
 */
export function ComparisonSelect({ value, onChange, range, disabled }: ComparisonSelectProps) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      preferredAlignment="left"
      activator={
        <Button
          icon={ArrowsInHorizontalIcon}
          disclosure
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          {t.dates.comparisons[value]}
        </Button>
      }
    >
      <ActionList
        actionRole="menuitem"
        items={COMPARISONS.map((id) => {
          const compared = comparisonRange(range, id);
          return {
            content: t.dates.comparisons[id],
            // Le date sotto la voce: "anno precedente" e' un'idea, quelle sono
            // i giorni che verranno davvero messi a paragone.
            helpText: compared ? formatRange(compared, locale) : undefined,
            active: value === id,
            onAction: () => {
              onChange(id);
              setOpen(false);
            },
          };
        })}
      />
    </Popover>
  );
}
