import { Badge, InlineStack, Link, Text } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';

interface BirthdateStatusRowProps {
  /** C'e' un campo collegato da cui leggere la data di nascita? */
  active: boolean;
  /** Apre il riquadro di scelta, quello con l'elenco dei campi. */
  onOpen: () => void;
}

/**
 * Come sta messa la data di nascita, in una riga sola sopra la tabella.
 *
 * E' cio' che resta quando l'avviso di conferma e' stato chiuso, o non e' mai
 * comparso: senza, la configurazione sparirebbe dalla pagina e per rimetterci
 * mano bisognerebbe indovinare dove. Una riga, non un riquadro, perche' qui non
 * c'e' niente da decidere — c'e' da sapere com'e' messa e, se si vuole,
 * cambiarla.
 *
 * Il comando e' un `Link` e non un `Button variant="plain"`: senza `url` Polaris
 * rende comunque un `<button>` vero — quindi tastiera e lettori di schermo lo
 * trattano per quello che e' — ma con lo stile del collegamento, cioe' il blu.
 * Un `Button` plain, accanto a un badge, prende il grigio del testo e in mezzo
 * a una riga di stato smette di sembrare qualcosa su cui si clicca. E' l'unico
 * modo di avere quel blu senza scriverci sopra del CSS nostro.
 */
export function BirthdateStatusRow({ active, onOpen }: BirthdateStatusRowProps) {
  const t = useT();

  return (
    <InlineStack gap="200" blockAlign="center" wrap>
      <Text as="span">{t.customers.birthdate.statusLabel}</Text>
      {/* Verde solo quando il dato arriva davvero. Il grigio non e' un
          allarme: non e' un guasto non avere questo campo, e' una cosa che si
          puo' ancora fare. */}
      <Badge tone={active ? 'success' : undefined}>
        {active ? t.customers.birthdate.statusOn : t.customers.birthdate.statusOff}
      </Badge>
      {/* Due parole diverse per due gesti diversi: chi non ha niente aggiunge,
          chi ha gia' un campo lo cambia. La stessa parola per entrambi
          lascerebbe credere di poterne collegare due. */}
      <Link onClick={onOpen} removeUnderline>
        {active ? t.customers.birthdate.statusChange : t.customers.birthdate.statusAdd}
      </Link>
    </InlineStack>
  );
}
