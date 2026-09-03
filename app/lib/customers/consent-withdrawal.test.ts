import { describe, it, expect } from 'vitest';
import { WITHDRAWN_CUSTOMER_FIELDS } from './consent-withdrawal';

/**
 * La regola, decisa dal proprietario del progetto: **non si cancella niente**.
 *
 * Chi ritira il consenso al marketing non ha chiesto di sparire dagli archivi
 * del negozio: ha chiesto che non lo si usi piu' per il marketing. I dati gia'
 * sincronizzati restano dove sono; cambia l'uso, non la conservazione — la
 * sincronizzazione smette di aggiornarli e il proxy si rifiuta di servirli.
 *
 * Una versione precedente svuotava le colonne identificative. Questi test
 * esistono perche' quel comportamento non torni per sbaglio.
 */
describe('cosa comporta ritirare il consenso', () => {
  it('una colonna sola: il consenso a false', () => {
    expect(WITHDRAWN_CUSTOMER_FIELDS).toEqual({ accepts_marketing: false });
  });

  // E' quella su cui il proxy nega la lettura: senza, il rifiuto non avrebbe
  // niente su cui appoggiarsi.
  it('e proprio quella su cui si decide il rifiuto', () => {
    expect(WITHDRAWN_CUSTOMER_FIELDS.accepts_marketing).toBe(false);
  });

  it('nessun dato della persona viene toccato', () => {
    const dellaPersona = [
      'email_address',
      'phone_number',
      'first_name',
      'last_name',
      'country',
      'country_code',
      'city',
      'address',
      'zipcode',
      'region',
      'date_of_birth',
      'external_id',
      'fb_login_id',
      'google_login_id',
      'note',
    ];

    for (const colonna of dellaPersona) {
      expect(WITHDRAWN_CUSTOMER_FIELDS).not.toHaveProperty(colonna);
    }
  });

  // Senza chiave la riga non si ritrova, e i totali non raccontano la persona.
  it('nemmeno la chiave e i numeri del negozio', () => {
    for (const colonna of ['shopify_customer_id', 'total_spent', 'orders_count']) {
      expect(WITHDRAWN_CUSTOMER_FIELDS).not.toHaveProperty(colonna);
    }
  });
});
