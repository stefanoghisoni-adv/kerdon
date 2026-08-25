import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionList,
  Box,
  Button,
  DatePicker,
  Divider,
  InlineStack,
  Popover,
  Scrollable,
  TextField,
} from '@shopify/polaris';
import { CalendarIcon, ArrowRightIcon, ArrowsInHorizontalIcon } from '@shopify/polaris-icons';
import {
  comparisonRange,
  formatRange,
  fromIso,
  iso,
  matchPreset,
  orderRange,
  presetRange,
  type ComparisonId,
  type DateRange,
  type PresetId,
} from '~/lib/dates/ranges';
import { useLocale, useT } from '~/lib/i18n/context';

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  disabled?: boolean;
}

/** I periodi offerti, nell'ordine e nei gruppi in cui si leggono. */
const PRESET_GROUPS: PresetId[][] = [
  ['today', 'yesterday'],
  ['last7', 'last30', 'last90'],
  ['monthToDate', 'quarterToDate', 'yearToDate'],
  ['lastMonth', 'lastQuarter', 'lastYear'],
];

/**
 * La scelta del periodo.
 *
 * A sinistra i periodi che si chiedono per nome, a destra il calendario per le
 * due date che nome non hanno. Sono due modi di rispondere alla stessa domanda,
 * e stanno insieme perche' chi apre non sa ancora quale dei due gli serve:
 * apre per "il mese scorso" e si accorge che gli servono i primi dieci giorni.
 *
 * Niente si applica finche' non si preme Applica. Un calendario che ricarica i
 * numeri al primo clic li ricarica sempre due volte — con la data d'inizio da
 * sola non si e' ancora chiesto niente.
 */
export function DateRangePicker({ value, onChange, disabled }: DateRangePickerProps) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  // Bozza: quello che si sta scegliendo, finche' non si conferma.
  const [draft, setDraft] = useState<DateRange>(value);
  const [{ month, year }, setVisible] = useState(() => {
    const start = fromIso(value.from);
    return { month: start.getUTCMonth(), year: start.getUTCFullYear() };
  });

  // Riaprendo si riparte da quello che c'e' adesso, non da dove si era rimasti:
  // la tendina chiusa senza applicare non deve lasciare tracce.
  useEffect(() => {
    if (!open) return;
    setDraft(value);
    const start = fromIso(value.from);
    setVisible({ month: start.getUTCMonth(), year: start.getUTCFullYear() });
  }, [open, value]);

  const selectedPreset = useMemo(() => matchPreset(draft), [draft]);

  const choosePreset = useCallback((preset: PresetId) => {
    const range = presetRange(preset);
    if (!range) return;
    setDraft(range);
    const start = fromIso(range.from);
    setVisible({ month: start.getUTCMonth(), year: start.getUTCFullYear() });
  }, []);

  const apply = () => {
    onChange(draft);
    setOpen(false);
  };

  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      preferredAlignment="left"
      activator={
        <Button
          icon={CalendarIcon}
          disclosure
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          {formatRange(value, locale)}
        </Button>
      }
    >
      <InlineStack wrap={false} blockAlign="stretch">
        {/* I periodi con un nome. In una colonna che scorre da sola: sono
            undici, e allungare il riquadro fino a contenerli tutti lo
            farebbe uscire dallo schermo dentro l'admin. */}
        <Box borderInlineEndWidth="025" borderColor="border" minWidth="200px">
          <Scrollable style={{ maxHeight: 340 }}>
            <Box padding="200">
              {PRESET_GROUPS.map((group, index) => (
                <Box key={index} paddingBlockStart={index === 0 ? '0' : '100'}>
                  {index > 0 && (
                    <Box paddingBlockEnd="100">
                      <Divider />
                    </Box>
                  )}
                  <ActionList
                    actionRole="menuitem"
                    items={group.map((preset) => ({
                      content: t.dates.presets[preset],
                      active: selectedPreset === preset,
                      onAction: () => choosePreset(preset),
                    }))}
                  />
                </Box>
              ))}
            </Box>
          </Scrollable>
        </Box>

        <Box padding="300" minWidth="620px">
          {/* Le due date anche scritte: chi le conosce gia' le batte a
              macchina piu' in fretta di quanto sfogli i mesi. */}
          <Box paddingBlockEnd="300">
            <InlineStack gap="200" blockAlign="center" wrap={false}>
              <DateField
                value={draft.from}
                onCommit={(next) => setDraft(orderRange(next, draft.to))}
              />
              <Box paddingInline="100">
                <Button icon={ArrowRightIcon} variant="tertiary" disabled accessibilityLabel="" />
              </Box>
              <DateField
                value={draft.to}
                onCommit={(next) => setDraft(orderRange(draft.from, next))}
              />
            </InlineStack>
          </Box>

          <DatePicker
            month={month}
            year={year}
            multiMonth
            allowRange
            // Lunedi': e' il primo giorno della settimana ovunque l'app parli,
            // e una settimana che parte di domenica sposta di un giorno la
            // lettura di "questa settimana".
            weekStartsOn={1}
            selected={{ start: fromIso(draft.from), end: fromIso(draft.to) }}
            onMonthChange={(nextMonth, nextYear) =>
              setVisible({ month: nextMonth, year: nextYear })
            }
            onChange={({ start, end }) =>
              setDraft(orderRange(iso(toUtc(start)), iso(toUtc(end))))
            }
          />

          <Box paddingBlockStart="300">
            <InlineStack align="end" gap="200">
              <Button onClick={() => setOpen(false)}>{t.common.cancel}</Button>
              <Button variant="primary" onClick={apply}>
                {t.dates.apply}
              </Button>
            </InlineStack>
          </Box>
        </Box>
      </InlineStack>
    </Popover>
  );
}

/**
 * Il calendario di Polaris ragiona in date locali, il resto dell'app in UTC.
 *
 * Senza questa conversione, chi vive a est di Greenwich sceglie il 25 e ottiene
 * il 24: la Date locale a mezzanotte, letta in UTC, e' il giorno prima.
 */
function toUtc(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

/**
 * Una data scritta a mano.
 *
 * Si applica quando si esce dal campo o si preme Invio, non a ogni lettera:
 * mentre si scrive "2026-08" la data e' incompleta, e reagire a ogni battuta
 * farebbe saltare il calendario a mesi che nessuno ha chiesto.
 */
function DateField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const commit = () => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(fromIso(text).getTime())) {
      onCommit(text);
    } else {
      // Non e' una data: si torna a quella buona invece di lasciare a schermo
      // qualcosa che non verrebbe applicato.
      setText(value);
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
        label=""
        labelHidden
        value={text}
        onChange={setText}
        onBlur={commit}
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
