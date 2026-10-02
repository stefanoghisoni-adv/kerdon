import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * L'avviso dell'informativa e' cablato davvero nella Dashboard.
 *
 * Come `dashboard-sync-truth.test.ts`, legge il codice invece di eseguirlo:
 * la regola (quando l'avviso e' dovuto, come si registra) e' provata accanto
 * alle sue funzioni; qui si prova che la pagina la chiami, e nel punto giusto.
 * Senza, la promessa della sezione 10 resterebbe scritta in un modulo che
 * nessuno usa.
 */

const SORGENTE = readFileSync(resolve(__dirname, '_index.tsx'), 'utf8');
const BANNER = readFileSync(
  resolve(__dirname, '..', 'components', 'Dashboard', 'PrivacyNoticeBanner.tsx'),
  'utf8',
);

const azione = SORGENTE.slice(SORGENTE.indexOf('export async function action('));

describe('avviso delle modifiche all\'informativa', () => {
  it('il loader lo chiede dentro il Promise.all, senza un giro in piu\'', () => {
    const promiseAll = SORGENTE.slice(
      SORGENTE.indexOf('await Promise.all(['),
      SORGENTE.indexOf('// La valuta che il merchant si aspetta'),
    );
    expect(promiseAll).toContain('privacyNoticeDue(shop)');
    expect(SORGENTE).toContain('privacyNotice: { show: privacyNoticeShow }');
  });

  it('la pagina lo mostra quando il loader lo dice', () => {
    expect(SORGENTE).toContain('{privacyNotice.show && <PrivacyNoticeBanner />}');
  });

  it('"Ho capito" si registra prima del cancello dei permessi', () => {
    // Un negozio sospeso vede l'avviso: deve poterlo anche chiudere.
    const presaDatto = azione.indexOf('intent === ACKNOWLEDGE_PRIVACY_NOTICE_INTENT');
    const cancello = azione.indexOf("denialOf(await shopCapabilities(shop), 'use_app')");
    expect(presaDatto).toBeGreaterThan(-1);
    expect(cancello).toBeGreaterThan(-1);
    expect(presaDatto).toBeLessThan(cancello);
    expect(azione).toContain('acknowledgePrivacyNotice(shop.id)');
  });

  it('il corpo della richiesta si legge una volta sola', () => {
    expect(azione.match(/request\.formData\(\)/g)).toHaveLength(1);
  });

  it('il banner e\' Polaris, tono info, con il link all\'informativa dall\'helper', () => {
    expect(BANNER).toContain('tone="info"');
    expect(BANNER).toContain('linkInformativa(locale)');
    expect(BANNER).not.toMatch(/<div|style=/);
    // Nessuna X: si chiude solo con "Ho capito", che e' quello che registra.
    expect(BANNER).not.toContain('onDismiss');
  });
});
