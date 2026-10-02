import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES } from '~/lib/i18n/locales';
import { SORGENTI, versioneEData } from './privacy-policy';
import {
  PRIVACY_POLICY_DATE,
  PRIVACY_POLICY_VERSION,
  avvisoInformativaDovuto,
  confrontaVersioni,
} from './policy-version';

/**
 * La versione che l'app annuncia e' quella che i documenti dichiarano.
 *
 * IL DIFETTO CHE QUESTO TEST IMPEDISCE. Alzare la testata dell'informativa e
 * dimenticare la costante vorrebbe dire una modifica sostanziale MAI
 * annunciata in app — esattamente la promessa della sezione 10 che l'avviso
 * esiste per mantenere. Il contrario, la costante alzata e i documenti no,
 * annuncerebbe una versione che nessuno puo' leggere.
 */
describe('la versione corrente', () => {
  it.each(LOCALES)('coincide con la testata di privacy-policy (%s)', (locale) => {
    expect(versioneEData(SORGENTI[locale])).toEqual({
      versione: PRIVACY_POLICY_VERSION,
      data: PRIVACY_POLICY_DATE,
    });
  });

  it('coincide con la testata di privacy-policy.html', () => {
    const html = readFileSync(join(process.cwd(), 'docs', 'legal', 'privacy-policy.html'), 'utf-8');
    expect(/Version\s*<b>([^<]+)<\/b>/.exec(html)?.[1].trim()).toBe(PRIVACY_POLICY_VERSION);
  });

  it('il DPA porta la stessa data', () => {
    // La forma del DPA e' "Last updated: 2 October 2026": si confronta il giorno.
    const [g, m, a] = PRIVACY_POLICY_DATE.split('-').map(Number);
    const atteso = new Date(Date.UTC(a, m - 1, g)).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const dpa = readFileSync(join(process.cwd(), 'docs', 'legal', 'dpa.md'), 'utf-8');
    expect(dpa).toContain(`Last updated: ${atteso}`);
    expect(dpa).toContain(`Version: ${PRIVACY_POLICY_VERSION}`);
  });
});

describe('confrontaVersioni', () => {
  it('confronta numero per numero, non come testo', () => {
    expect(confrontaVersioni('1.10', '1.9')).toBeGreaterThan(0);
    expect(confrontaVersioni('1.4', '1.5')).toBeLessThan(0);
    expect(confrontaVersioni('1.5', '1.5')).toBe(0);
    expect(confrontaVersioni('2', '1.9')).toBeGreaterThan(0);
  });
});

describe('avvisoInformativaDovuto', () => {
  const prima = new Date('2026-09-01T10:00:00Z');
  const dopo = new Date('2026-10-02T08:00:00Z');

  it('si mostra a un negozio installato prima, che non ha mai visto avvisi', () => {
    expect(avvisoInformativaDovuto({ seenVersion: null, installedAt: prima })).toBe(true);
  });

  it('si mostra a chi ha visto una versione precedente', () => {
    expect(avvisoInformativaDovuto({ seenVersion: '1.4', installedAt: prima })).toBe(true);
  });

  it('non si mostra a chi ha gia\' detto "Ho capito" per questa versione', () => {
    expect(
      avvisoInformativaDovuto({ seenVersion: PRIVACY_POLICY_VERSION, installedAt: prima }),
    ).toBe(false);
  });

  it('non si mostra a chi ha visto una versione piu\' recente', () => {
    expect(avvisoInformativaDovuto({ seenVersion: '9.0', installedAt: prima })).toBe(false);
  });

  it('non si mostra a un negozio installato dal giorno della versione in poi', () => {
    // Installando ha accettato gia' questa: non c'e' nessuna modifica da dirgli.
    expect(avvisoInformativaDovuto({ seenVersion: null, installedAt: dopo })).toBe(false);
  });

  it('una reinstallazione dopo la versione vale come averla accettata', () => {
    // Visto 1.4, poi reinstallato dopo la 1.5: reinstallando ha accettato la
    // 1.5, e il vecchio "Ho capito" non lo rende un negozio da avvisare.
    expect(avvisoInformativaDovuto({ seenVersion: '1.4', installedAt: dopo })).toBe(false);
  });

  it('senza data di installazione si mostra', () => {
    expect(avvisoInformativaDovuto({ seenVersion: null, installedAt: null })).toBe(true);
  });
});
