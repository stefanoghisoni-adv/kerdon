import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchFileForDownload } from './download-file';

function risposta(init: {
  ok?: boolean;
  status?: number;
  tipo?: string;
  disposition?: string | null;
  corpo?: string;
}) {
  const headers = new Headers();
  headers.set('Content-Type', init.tipo ?? 'application/json; charset=utf-8');
  if (init.disposition) headers.set('Content-Disposition', init.disposition);
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers,
    blob: async () => new Blob([init.corpo ?? '{}']),
  };
}

describe('chiedere un file da dentro l admin', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('restituisce il file col nome che il server ha dichiarato', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      risposta({ disposition: 'attachment; filename="coreward-demo.json"' }),
    );

    const esito = await fetchFileForDownload('/privacy/my-data', 'riserva.json');
    expect(esito.nome).toBe('coreward-demo.json');
  });

  it('senza intestazione usa il nome di riserva', async () => {
    (global.fetch as any).mockResolvedValueOnce(risposta({ disposition: null }));

    const esito = await fetchFileForDownload('/privacy/my-data', 'riserva.json');
    expect(esito.nome).toBe('riserva.json');
  });

  // Il caso che ha rotto il download la prima volta: la rotta protetta rimanda
  // all'accesso, la fetch segue il redirect, e senza questo controllo si
  // salverebbe la pagina di login col nome di un JSON.
  it('una pagina HTML non diventa un file scaricato', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      risposta({ tipo: 'text/html; charset=utf-8', corpo: '<html>accedi</html>' }),
    );

    await expect(fetchFileForDownload('/privacy/my-data', 'riserva.json')).rejects.toThrow(
      'risposta inattesa',
    );
  });

  it('un errore del server non diventa un file vuoto', async () => {
    (global.fetch as any).mockResolvedValueOnce(risposta({ ok: false, status: 404 }));

    await expect(fetchFileForDownload('/privacy/export/x', 'riserva.json')).rejects.toThrow('404');
  });
});
