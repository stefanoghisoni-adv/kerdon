// e2e/ambiente.ts
//
// Le variabili d'ambiente delle prove, in un posto solo.
//
// PERCHE' UN FILE A SE'. Le legge il server — che firma gli state degli
// addebiti e verifica le firme degli webhook — e le legge anche il processo di
// Playwright, che quelle stesse firme le deve comporre per poterle mandare.
// Con due copie scritte a mano i due si sarebbero disallineati al primo valore
// cambiato, e il sintomo sarebbe stato una firma "non valida" che non e'
// sbagliata: e' firmata con l'altra chiave.
//
// NON C'E' NIENTE DI VERO QUI DENTRO, e non ci puo' finire: sono valori
// inventati, e si ASSEGNANO invece di ripiegare su quelli dell'ambiente. Una
// prova che ereditasse la chiave da chi la lancia proverebbe quella macchina.

export const PORTA = Number(process.env.E2E_PORT ?? 4180);
export const PORTA_DB = Number(process.env.E2E_PG_PORT ?? 54390);
export const BASE = `http://127.0.0.1:${PORTA}`;

export const AMBIENTE_DI_PROVA: Record<string, string> = {
  NODE_ENV: 'development',
  SHOPIFY_API_KEY: 'chiave-di-prova-e2e',
  SHOPIFY_API_SECRET: 'segreto-di-prova-e2e',
  SHOPIFY_APP_URL: BASE,
  SHOPIFY_SCOPES:
    'read_products,read_inventory,write_inventory,read_customers,write_customers,read_publications,read_themes,read_orders,read_all_orders,read_shipping,read_returns',
  ENCRYPTION_SECRET: 'chiave-di-cifratura-solo-per-le-prove-e2e',
  SESSION_SECRET: 'sessione-solo-per-le-prove-e2e',
  CRON_SECRET: 'cron-solo-per-le-prove-e2e',
  SUPABASE_OAUTH_CLIENT_ID: 'client-id-di-prova',
  SUPABASE_OAUTH_CLIENT_SECRET: 'client-secret-di-prova',
};

/**
 * Scrive l'ambiente di prova, sostituendo quello che c'e'.
 *
 * Va chiamata PRIMA di caricare qualunque modulo dell'app: chi legge una
 * variabile all'importazione la legge una volta sola.
 */
export function applicaAmbienteDiProva(): void {
  for (const [nome, valore] of Object.entries(AMBIENTE_DI_PROVA)) {
    process.env[nome] = valore;
  }
  // Redis non c'e', e non deve esserci: la cache delle statistiche si arrangia
  // senza. Un indirizzo ereditato punterebbe a un Redis vero.
  delete process.env.REDIS_URL;
}
