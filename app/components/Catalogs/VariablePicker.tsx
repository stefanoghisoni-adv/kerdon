import { useMemo, useState } from 'react';
import { ActionList, Badge, Box, Button, Popover } from '@shopify/polaris';
import { VARIABLES, type Variable } from '~/lib/feeds/gmc';
import { useT } from '~/lib/i18n/context';

export interface VariablePickerProps {
  /** La variabile scelta adesso. */
  value: Variable;
  /** Quella consigliata per questo campo: sta in cima, con il suo badge. */
  suggested: Variable;
  /** Le ultime scelte fatte su QUESTO campo, dalla piu' recente. */
  recent: Variable[];
  onChange: (value: Variable) => void;
  disabled?: boolean;
}

/**
 * La scelta del dato che riempie un campo di Google.
 *
 * Tre sezioni, e l'ordine non e' estetico: in cima quella consigliata, perche'
 * nella maggior parte dei casi e' anche quella giusta e chi non ha motivo di
 * cambiarla non deve cercarla; poi le ultime provate su questo stesso campo,
 * perche' chi ne mappa venti cambia idea e torna indietro; infine tutte le
 * altre, che si guardano solo quando le prime due non bastano.
 *
 * Le recenti sono per campo e non per negozio: le variabili che si provano su
 * `gtin` non sono quelle che si provano su `title`, e mescolarle riempirebbe la
 * sezione di voci che li' non c'entrano.
 */
export function VariablePicker({
  value,
  suggested,
  recent,
  onChange,
  disabled,
}: VariablePickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const label = (variable: Variable) => t.catalogs.variables[variable];

  const sections = useMemo(() => {
    const choose = (variable: Variable) => () => {
      onChange(variable);
      setOpen(false);
    };

    // Nessuna voce compare due volte: la stessa variabile in due sezioni
    // sembrerebbe due opzioni diverse.
    const shown = new Set<Variable>([suggested]);
    const recentShown = recent.filter((variable) => {
      if (shown.has(variable)) return false;
      shown.add(variable);
      return true;
    });

    const out: {
      title: string;
      items: {
        content: string;
        active: boolean;
        onAction: () => void;
        suffix?: React.ReactNode;
      }[];
    }[] = [
      {
        title: t.catalogs.mapping.sections.default,
        items: [
          {
            content: label(suggested),
            active: value === suggested,
            onAction: choose(suggested),
            // Il badge dice perche' sta in cima: non e' la prima in ordine
            // alfabetico, e' quella che Google si aspetta li'.
            suffix: <Badge tone="info">{t.catalogs.mapping.recommended}</Badge>,
          },
        ],
      },
    ];

    if (recentShown.length > 0) {
      out.push({
        title: t.catalogs.mapping.sections.recent,
        items: recentShown.map((variable) => ({
          content: label(variable),
          active: value === variable,
          onAction: choose(variable),
        })),
      });
    }

    out.push({
      title: t.catalogs.mapping.sections.others,
      items: VARIABLES.filter((variable) => !shown.has(variable)).map((variable) => ({
        content: label(variable),
        active: value === variable,
        onAction: choose(variable),
      })),
    });

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, suggested, recent, t]);

  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      preferredAlignment="left"
      activator={
        <Button
          disclosure
          disabled={disabled}
          fullWidth
          textAlign="left"
          onClick={() => setOpen((current) => !current)}
        >
          {label(value)}
        </Button>
      }
    >
      {/* La classe serve a due ritocchi che Polaris non espone: togliere il
          grassetto alla voce selezionata — qui la scelta corrente si riconosce
          gia' dallo sfondo, e il grassetto la faceva sembrare di categoria
          diversa dalle altre — e allineare il badge alla riga del testo. */}
      <Box minWidth="260px">
        <div className="variable-picker">
          <ActionList actionRole="menuitem" sections={sections} />
        </div>
      </Box>
    </Popover>
  );
}

/**
 * L'avviso "Obbligatorio", nella sua colonna.
 *
 * Sta in una colonna sua e non accanto al nome perche' i nomi dei campi hanno
 * lunghezze molto diverse (`id` e `custom_label_0`): attaccato al nome, il
 * badge cadeva ogni volta in un punto diverso, e per sapere quali campi sono
 * obbligatori bisognava leggerli tutti. Incolonnato si contano a colpo d'occhio.
 *
 * "Obbligatorio" non vuol dire che il modulo non si invia: vuol dire che un
 * prodotto a cui quel campo manca resta fuori dal file, e quindi fuori dagli
 * annunci.
 */
export function RequiredBadge({ required }: { required: boolean }) {
  const t = useT();
  if (!required) return null;
  return <Badge tone="attention">{t.catalogs.mapping.required}</Badge>;
}
