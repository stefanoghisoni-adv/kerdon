import { Box, InlineStack, Pagination, Text } from '@shopify/polaris';
import { PER_PAGE, pageCount, visibleRange } from '~/lib/table/pagination';

interface Props {
  /** Quante righe restano DOPO filtri e ricerca: e' quello che si vede. */
  total: number;
  page: number;
  onPage: (page: number) => void;
}

/**
 * Il piede di una tabella: le frecce e l'intervallo che si sta guardando.
 *
 * Un componente solo per tutte le tabelle, e non e' pignoleria: due copie
 * divergono, e due elenchi che si sfogliano in modo diverso dentro la stessa
 * app fanno dubitare di aver capito male l'uno o l'altro.
 *
 * L'INTERVALLO E NON IL NUMERO DI PAGINA. "1-50" dice quante righe si stanno
 * guardando e a che punto dell'elenco si e'; "pagina 1 di 3" dice solo la
 * seconda cosa, e per sapere la prima bisogna moltiplicare. Sopra una ricerca
 * che ha lasciato dodici righe, poi, "pagina 1 di 1" non dice proprio niente,
 * mentre "1-12" dice quante ne ha trovate.
 *
 * A DESTRA. Le frecce stanno dove finisce la tabella, non dove comincia: si
 * arriva in fondo all'elenco leggendo, e il comando per continuare deve essere
 * li'. Il numero segue le frecce invece di stare in mezzo — la label integrata
 * di `Pagination` cadrebbe fra i due pulsanti e li separerebbe.
 *
 * Sotto la soglia di una pagina sola il piede non c'e': niente frecce spente e
 * niente "1-12" sotto dodici righe che si contano guardandole.
 */
export function TablePagination({ total, page, onPage }: Props) {
  const pages = pageCount(total, PER_PAGE);
  const range = visibleRange(total, page, PER_PAGE);

  if (pages <= 1 || !range) return null;

  return (
    <Box padding="300" borderBlockStartWidth="025" borderColor="border">
      <InlineStack align="end" blockAlign="center" gap="200" wrap={false}>
        <Pagination
          hasPrevious={page > 1}
          onPrevious={() => onPage(page - 1)}
          hasNext={page < pages}
          onNext={() => onPage(page + 1)}
        />
        {/* Piccolo, medio e smorzato: accompagna le frecce, non le annuncia. */}
        <Text as="span" variant="bodySm" fontWeight="medium" tone="subdued">
          {`${range.from}-${range.to}`}
        </Text>
      </InlineStack>
    </Box>
  );
}
