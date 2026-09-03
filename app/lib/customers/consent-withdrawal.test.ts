import { describe, it, expect } from 'vitest';
import {
  WITHDRAWN_CUSTOMER_FIELDS,
  WITHDRAWN_CUSTOMER_MINIMUM,
  isUnknownColumn,
} from './consent-withdrawal';

describe('cosa resta di un cliente che ritira il consenso', () => {
  it('il consenso a false: e cio su cui la lettura viene negata', () => {
    expect(WITHDRAWN_CUSTOMER_FIELDS.accepts_marketing).toBe(false);
  });

  it('tutto cio che dice chi e viene azzerato', () => {
    const identificano = [
      'email_address',
      'phone_number',
      'first_name',
      'last_name',
      'country',
      // Un indirizzo e' un dato personale per intero: la sigla del paese e la
      // citta' ne fanno parte come la via.
      'country_code',
      'address',
      'city',
      'zipcode',
      'region',
      'date_of_birth',
      'external_id',
      // Oggi sempre vuoti, il login con Meta e Google non c'e' ancora. Stanno
      // in elenco da subito perche' il giorno in cui cominceranno a riempirsi
      // il ritiro del consenso non deve dipendere da chi si ricorda di
      // aggiungerli: sono l'identita' pubblicitaria della persona.
      'fb_login_id',
      'google_login_id',
      'note',
    ] as const;

    for (const colonna of identificano) {
      expect(WITHDRAWN_CUSTOMER_FIELDS).toHaveProperty(colonna, null);
    }
  });

  // La riga deve restare, e restare ritrovabile: senza chiave, ritirare il
  // consenso due volte lascerebbe righe orfane invece di aggiornare la stessa.
  it('la chiave della riga non si tocca', () => {
    expect(WITHDRAWN_CUSTOMER_FIELDS).not.toHaveProperty('shopify_customer_id');
  });

  // Quanti clienti, quanto hanno speso: sono fatti del negozio, e restano veri
  // anche senza sapere di chi fossero.
  it('i numeri del negozio restano', () => {
    for (const colonna of [
      'total_spent',
      // Il profitto e' un numero del negozio, non della persona: resta vero
      // anche senza sapere di chi fosse.
      'total_profit',
      'orders_count',
      'created_at',
      'customer_state',
    ]) {
      expect(WITHDRAWN_CUSTOMER_FIELDS).not.toHaveProperty(colonna);
    }
  });

  it('il ripiego marca il consenso e nient altro', () => {
    expect(WITHDRAWN_CUSTOMER_MINIMUM).toEqual({ accepts_marketing: false });
  });
});

// Serve a distinguere "questa tabella e' vecchia" da un guasto vero: solo nel
// primo caso ha senso riprovare con il ripiego.
describe('isUnknownColumn', () => {
  it('riconosce il modo di PostgREST e quello di Postgres', () => {
    expect(isUnknownColumn({ code: 'PGRST204' })).toBe(true);
    expect(isUnknownColumn({ code: '42703' })).toBe(true);
    expect(
      isUnknownColumn({ message: "Could not find the 'external_id' column of 'customers'" }),
    ).toBe(true);
    expect(isUnknownColumn({ message: 'column "date_of_birth" does not exist' })).toBe(true);
  });

  it('un guasto vero non e una colonna mancante', () => {
    expect(isUnknownColumn(null)).toBe(false);
    expect(isUnknownColumn({ code: '57014', message: 'statement timeout' })).toBe(false);
    expect(isUnknownColumn({ code: '42501', message: 'permission denied' })).toBe(false);
  });
});
