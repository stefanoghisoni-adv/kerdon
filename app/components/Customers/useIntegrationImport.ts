// app/components/Customers/useIntegrationImport.ts
//
// L'avvio di un import, condiviso fra la card e il modal.
//
// Dopo la risposta non serve rileggere a mano i dati della pagina: un POST da
// fetcher fa gia' rivalidare a Remix tutti i loader della pagina e i
// `fetcher.load` attivi (nessuna rotta qui definisce `shouldRevalidate`). Il
// loader della pagina e quello dello stato espongono `running`, quindi dopo
// quella rilettura la card e il modal vedono il giro in corso e fermano il
// pulsante. Una `revalidate()` in piu' rifarebbe il report clienti due volte.

import { useCallback } from 'react';
import { useFetcher } from '@remix-run/react';

export function useIntegrationImport(provider: string) {
  const importFetcher = useFetcher<{ queued?: boolean; reason?: string }>();

  const handleImport = useCallback(() => {
    importFetcher.submit(
      {},
      { method: 'POST', action: `/api/integrations/${provider}/import` }
    );
  }, [importFetcher, provider]);

  const importReason =
    importFetcher.data?.queued === false && importFetcher.data.reason
      ? importFetcher.data.reason
      : null;

  return {
    importFetcher,
    handleImport,
    importReason,
  };
}
