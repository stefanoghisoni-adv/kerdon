// app/lib/privacy/download-filename.ts

/**
 * Il nome del file dall'intestazione con cui il server lo consegna.
 *
 * Serve perche' il file non si scarica piu' con un link: dentro l'admin di
 * Shopify l'app vive in un iframe e si autentica con il gettone di sessione,
 * non con un cookie — una navigazione verso una rotta protetta esce dalla
 * sessione e finisce sulla pagina di accesso, che e' esattamente cio' che
 * succedeva (302 su /privacy/my-data, poi /auth/login, e l'iframe vuoto).
 *
 * Quindi il file si chiede con una fetch, che il gettone ce l'ha, e si salva
 * da un blob. Ma un blob non ha nome: il nome sta nell'intestazione, e va
 * ripescato da li'.
 */
export function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const nome = match?.[1]?.trim();
  if (!nome) return null;
  // Mai un percorso: il nome arriva dal nostro server, ma e' il browser a
  // scrivere sul disco di chi scarica e non e' il posto dove fidarsi.
  return decodeURIComponent(nome).replace(/[/\\]/g, '-');
}
