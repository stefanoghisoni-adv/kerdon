// app/components/Customers/useIntegrationImport.ts
//
// Shared hook for integration import logic (I8 fix).

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
