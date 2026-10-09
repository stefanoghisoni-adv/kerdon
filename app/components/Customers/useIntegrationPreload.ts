// app/components/Customers/useIntegrationPreload.ts
//
// Il caricamento al clic su un riquadro integrazione: il riquadro mostra lo
// spinner mentre lo stato arriva, e la modal si apre solo a dati pronti.
//
// Lo stato si legge qui, nel genitore, e non dentro KlaviyoDetail: il Modal di
// Polaris monta i figli solo quando `open` e' vero, quindi un fetcher nel
// dettaglio non potrebbe caricare a modal chiusa. I dati arrivati passano poi
// al dettaglio come stato iniziale; dopo salvataggio, collegamento e
// scollegamento il dettaglio rilegge da se' come prima.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IntegrationId } from '~/lib/integrations/registry';
import type { StatusData } from './KlaviyoDetail';

/**
 * Funzione pura: dalla risposta del caricamento dello stato ricava i dati
 * da passare al dettaglio, oppure null se la risposta non e' usabile
 * (errore HTTP, corpo vuoto o senza `status`).
 */
export function parseIntegrationStatus(httpOk: boolean, body: unknown): StatusData | null {
  if (!httpOk || !body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.status !== 'string') return null;
  return record as unknown as StatusData;
}

export interface IntegrationPreload {
  /** Il riquadro di cui si sta caricando lo stato (null = nessuno). */
  pendingProvider: IntegrationId | null;
  /** L'integrazione la cui modal e' aperta (null = modal chiusa). */
  openProvider: IntegrationId | null;
  /** Lo stato gia' letto, da passare al dettaglio. */
  initialStatus: StatusData | null;
  /** Clic su un riquadro: carica lo stato e poi apre la modal. */
  start: (provider: IntegrationId) => void;
  /** Chiude la modal. */
  close: () => void;
}

export function useIntegrationPreload(onError: () => void): IntegrationPreload {
  const [pendingProvider, setPendingProvider] = useState<IntegrationId | null>(null);
  const [openProvider, setOpenProvider] = useState<IntegrationId | null>(null);
  const [initialStatus, setInitialStatus] = useState<StatusData | null>(null);

  // Il numero della richiesta corrente: una risposta arrivata tardi (dopo lo
  // smontaggio o superata da un'altra) viene ignorata.
  const requestRef = useRef(0);
  // Blocca un secondo clic mentre il primo carica, anche prima del re-render.
  const pendingRef = useRef<IntegrationId | null>(null);
  // L'ultimo gestore d'errore, senza farlo entrare nelle dipendenze di `start`.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  useEffect(() => {
    return () => {
      requestRef.current += 1;
    };
  }, []);

  const start = useCallback((provider: IntegrationId) => {
    if (pendingRef.current) return;
    pendingRef.current = provider;
    setPendingProvider(provider);
    const requestId = ++requestRef.current;

    void (async () => {
      let data: StatusData | null = null;
      try {
        const response = await fetch(`/api/integrations/${provider}`, {
          headers: { Accept: 'application/json' },
        });
        const body: unknown = await response.json().catch(() => null);
        data = parseIntegrationStatus(response.ok, body);
      } catch (error) {
        console.warn(
          '[integrazioni] stato non caricato:',
          error instanceof Error ? error.message : 'errore sconosciuto',
        );
      }

      if (requestId !== requestRef.current) return;
      pendingRef.current = null;
      setPendingProvider(null);

      if (data) {
        setInitialStatus(data);
        setOpenProvider(provider);
      } else {
        onErrorRef.current();
      }
    })();
  }, []);

  const close = useCallback(() => {
    setOpenProvider(null);
    setInitialStatus(null);
  }, []);

  return { pendingProvider, openProvider, initialStatus, start, close };
}
