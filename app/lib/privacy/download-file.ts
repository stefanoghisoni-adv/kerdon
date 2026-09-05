// app/lib/privacy/download-file.ts
//
// Come si scarica un file da dentro l'admin di Shopify.
//
// Non con un link, ed e' il punto. L'app vive in un iframe e si autentica con
// il gettone di sessione, non con un cookie: un <a> verso una rotta protetta e'
// una navigazione, il gettone non c'e', la rotta risponde 302 verso l'accesso e
// l'iframe resta bianco. E' successo davvero, e nei log si legge come due righe
// consecutive — 302 sulla rotta del file, poi 200 su /auth/login.
//
// La fetch invece il gettone ce l'ha: la libreria di Shopify la equipaggia da
// se', ed e' il modo in cui parlano gia' tutte le schede dell'app. Il file
// arriva come blob, e un blob non ha nome: il nome sta nell'intestazione con
// cui il server lo consegna.

import { filenameFromDisposition } from './download-filename';

/**
 * Chiede il file e lo restituisce con il suo nome.
 *
 * Il tipo si controlla prima di consegnarlo a chi salva: se la rotta tornasse a
 * rispondere con un redirect, la fetch lo seguirebbe fino alla pagina di
 * accesso e questa funzione restituirebbe dell'HTML col nome di un JSON — un
 * file inutile sul disco di qualcuno, e nessun errore da nessuna parte.
 */
export async function fetchFileForDownload(
  url: string,
  nomeDiRiserva: string,
): Promise<{ blob: Blob; nome: string }> {
  const risposta = await fetch(url);
  const tipo = risposta.headers.get('Content-Type') ?? '';
  if (!risposta.ok || !tipo.includes('application/json')) {
    throw new Error(`risposta inattesa da ${url}: ${risposta.status} ${tipo}`);
  }

  return {
    blob: await risposta.blob(),
    nome: filenameFromDisposition(risposta.headers.get('Content-Disposition')) ?? nomeDiRiserva,
  };
}

/** Salva un blob con il nome dato, e non lascia in giro l'indirizzo temporaneo. */
export function saveBlob(blob: Blob, nome: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = nome;
  // Attaccato e poi tolto: senza essere nel documento qualche browser ignora il
  // clic, e non succede niente in silenzio.
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Chiedi e salva. E' il gesto intero, quello che serve a chi preme un pulsante. */
export async function downloadFile(url: string, nomeDiRiserva: string): Promise<void> {
  const { blob, nome } = await fetchFileForDownload(url, nomeDiRiserva);
  saveBlob(blob, nome);
}
