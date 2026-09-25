import { describe, it, expect } from 'vitest';
import { PRIVACY_POLICY_PATH, linkInformativa } from '~/lib/legal/privacy-policy';
import { LOCALES } from '~/lib/i18n/locales';

/**
 * Il modal che prepara il download dei dati del merchant porta all'informativa.
 *
 * IL DIFETTO CHE QUESTO TEST IMPEDISCE. Il link nel modal era costruito a mano
 * con un percorso sbagliato (`/policies/policies/privacy-policy`) invece di
 * usare l'helper. Chi ci cliccava trovava un 410. Ora il link passa dall'helper,
 * e questo test verifica che l'helper generi la rotta giusta — non che il
 * componente la usi, perche' TypeScript lo garantisce, ma che l'helper produca
 * un percorso che esiste.
 */
describe('PrivacyModal: il link all informativa', () => {
  it.each(LOCALES)('per %s punta alla rotta corretta', (locale) => {
    // Il componente usa `linkInformativa(locale)`, quindi questa e' la URL che
    // il Link di Polaris riceve.
    const url = linkInformativa(locale);

    expect(url).toContain(PRIVACY_POLICY_PATH);
    expect(url).toContain(`lang=${locale}`);
    // NON il vecchio percorso sbagliato
    expect(url).not.toContain('/policies/policies/');
    // NON il percorso senza il prefisso /policies/
    expect(url).not.toMatch(/^\/privacy-policy\?/);
  });

  it('ogni lingua genera un percorso che inizia con la rotta corretta', () => {
    for (const locale of LOCALES) {
      const url = linkInformativa(locale);
      expect(url).toMatch(/^\/policies\/privacy-policy\?lang=/);
    }
  });
});
