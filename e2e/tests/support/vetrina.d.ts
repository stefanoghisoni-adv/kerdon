// e2e/tests/support/vetrina.d.ts
//
// Cosa la vetrina di prova mette a disposizione dentro la pagina.
//
// Serve al solo controllo dei tipi: `page.evaluate` esegue nel browser, e senza
// queste dichiarazioni `window.dichiara` sarebbe un errore di compilazione in
// una suite che gira con `tsc` su tutto il repository.

interface RigaDataLayer {
  event?: string;
  kerdon_external_id?: string;
  kerdon_consent?: string;
}

declare global {
  interface Window {
    dataLayer: RigaDataLayer[];
    /** Il visitatore risponde al banner: cambia il permesso e manda l'evento. */
    dichiara(risposte: Partial<Record<'analytics' | 'marketing' | 'preferences' | 'sale_of_data', string>>): void;
    /** Gli eventi finiti sul dataLayer con quel nome. */
    eventi(nome: string): RigaDataLayer[];
  }
}

export {};
