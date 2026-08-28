import { describe, it, expect } from 'vitest';
import {
  ANONYMOUS_USER_RETENTION_DAYS,
  EXTERNAL_ID_CART_ATTRIBUTE,
  MAX_TRAIT_LENGTH,
  anonymousUserCutoff,
  externalIdFromNoteAttributes,
  externalIdMintedAt,
  normalizeEmail,
  normalizePhone,
  browsersToForget,
  oldestExternalId,
  planMerge,
  postgrestFilterValue,
  sanitizeTrait,
  userSeenRow,
} from './users';

const VECCHIO = 'corew_1700000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RECENTE = 'corew_1750000000000_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TERZO = 'corew_1760000000000_cccccccccccccccccccccccccccccccc';

describe('externalIdFromNoteAttributes', () => {
  it('legge l identificativo dall attributo privato del carrello', () => {
    // E' il legame piu' forte: id cliente e identificativo del browser nella
    // stessa busta, senza che nessuno abbia dovuto fare login.
    const attrs = [
      { name: 'consegna', value: 'al piano' },
      { name: EXTERNAL_ID_CART_ATTRIBUTE, value: VECCHIO },
    ];
    expect(externalIdFromNoteAttributes(attrs)).toBe(VECCHIO);
  });

  it('l attributo comincia con un underscore, che per Shopify vuol dire privato', () => {
    // Senza, l'identificativo comparirebbe nel carrello e sulla conferma
    // d'ordine del cliente.
    expect(EXTERNAL_ID_CART_ATTRIBUTE.startsWith('_')).toBe(true);
  });

  it('scarta cio che non e un identificativo nostro ben formato', () => {
    // Nel carrello puo' scrivere chiunque: un tema, un'altra app, il cliente
    // con la console aperta. Una riga con dentro un valore inventato e' peggio
    // di nessuna riga.
    for (const value of ['', '   ', 'pippo', 'corew_abc_xyz', VECCHIO.slice(0, -1)]) {
      expect(externalIdFromNoteAttributes([{ name: EXTERNAL_ID_CART_ATTRIBUTE, value }])).toBeNull();
    }
  });

  it('senza attributi non c e niente da leggere', () => {
    expect(externalIdFromNoteAttributes(null)).toBeNull();
    expect(externalIdFromNoteAttributes(undefined)).toBeNull();
    expect(externalIdFromNoteAttributes([])).toBeNull();
    expect(externalIdFromNoteAttributes([{ name: 'altro', value: VECCHIO }])).toBeNull();
  });
});

describe('externalIdMintedAt', () => {
  it('legge i millisecondi che l identificativo porta dentro', () => {
    expect(externalIdMintedAt(VECCHIO)).toBe(1_700_000_000_000);
  });

  it('su cio che non e un identificativo nostro non inventa una data', () => {
    expect(externalIdMintedAt('pippo')).toBeNull();
  });
});

describe('sanitizeTrait', () => {
  it('taglia cio che eccede il tetto', () => {
    // Un container mal configurato potrebbe passare l'intero user agent, che
    // da solo identifica una persona molto piu' di quanto serva a dire "e' un
    // telefono".
    expect(sanitizeTrait('x'.repeat(200))).toHaveLength(MAX_TRAIT_LENGTH);
  });

  it('una stringa vuota vale come assenza', () => {
    expect(sanitizeTrait('   ')).toBeNull();
    expect(sanitizeTrait('')).toBeNull();
    expect(sanitizeTrait(null)).toBeNull();
  });

  it('toglie gli spazi ai bordi', () => {
    expect(sanitizeTrait(' Chrome ')).toBe('Chrome');
  });
});

describe('userSeenRow', () => {
  it('non manda mai first_seen_at', () => {
    // E' il punto su cui regge tutto: la colonna assente dal corpo non viene
    // toccata dall'aggiornamento e prende il DEFAULT NOW() all'inserimento.
    // Mandarla vorrebbe dire riscrivere la prima comparsa a ogni visita.
    const row = userSeenRow({ externalId: VECCHIO, seenAt: new Date('2026-08-28T10:00:00Z') });
    expect(row).not.toHaveProperty('first_seen_at');
    expect(row.last_seen_at).toBe('2026-08-28T10:00:00.000Z');
  });

  it('browser e dispositivo si scrivono solo se il container li manda', () => {
    // Scriverli come NULL cancellerebbe cio' che il container aveva detto sulla
    // pagina precedente.
    const senza = userSeenRow({ externalId: VECCHIO });
    expect(senza).not.toHaveProperty('browser');
    expect(senza).not.toHaveProperty('device_type');

    const con = userSeenRow({ externalId: VECCHIO, browser: 'Safari', deviceType: 'mobile' });
    expect(con.browser).toBe('Safari');
    expect(con.device_type).toBe('mobile');
  });

  it('non tocca ne il cliente ne l unione', () => {
    // Scrivere NULL su una riga gia' legata la slegherebbe proprio al ritorno
    // del cliente.
    const row = userSeenRow({ externalId: VECCHIO });
    expect(row).not.toHaveProperty('shopify_customer_id');
    expect(row).not.toHaveProperty('merged_into');
  });
});

describe('oldestExternalId', () => {
  it('vince il piu vecchio, che ha la storia piu lunga alle spalle', () => {
    const rows = [
      { external_id: RECENTE, first_seen_at: '2026-06-01T00:00:00Z' },
      { external_id: VECCHIO, first_seen_at: '2025-11-01T00:00:00Z' },
      { external_id: TERZO, first_seen_at: '2026-08-01T00:00:00Z' },
    ];
    expect(oldestExternalId(rows)).toBe(VECCHIO);
  });

  it('a parita di data decide il millisecondo dentro l identificativo', () => {
    // Il database scrive la data al secondo: due browser visti nello stesso
    // istante lascerebbero indeciso quale sia il piu' vecchio, e un vincitore
    // che cambia a ogni giro farebbe puntare le righe l una all altra a turno.
    const rows = [
      { external_id: RECENTE, first_seen_at: '2026-06-01T00:00:00Z' },
      { external_id: VECCHIO, first_seen_at: '2026-06-01T00:00:00Z' },
    ];
    expect(oldestExternalId(rows)).toBe(VECCHIO);
    expect(oldestExternalId([...rows].reverse())).toBe(VECCHIO);
  });

  it('una riga senza data non vince per un assenza', () => {
    const rows = [
      { external_id: TERZO, first_seen_at: null },
      { external_id: RECENTE, first_seen_at: '2026-06-01T00:00:00Z' },
    ];
    expect(oldestExternalId(rows)).toBe(RECENTE);
  });
});

describe('planMerge', () => {
  it('un browser solo non si unisce a niente', () => {
    expect(planMerge([{ external_id: VECCHIO, first_seen_at: '2025-11-01T00:00:00Z' }])).toBeNull();
  });

  it('il piu recente punta al piu vecchio, e nessuno viene cancellato', () => {
    const plan = planMerge([
      { external_id: RECENTE, first_seen_at: '2026-06-01T00:00:00Z' },
      { external_id: VECCHIO, first_seen_at: '2025-11-01T00:00:00Z' },
    ])!;
    expect(plan.canonical).toBe(VECCHIO);
    expect(plan.toMerge).toEqual([RECENTE]);
  });

  it('chi punta gia al canonico non si riscrive', () => {
    // Sarebbe una scrittura sul database del merchant che non cambia niente.
    const plan = planMerge([
      { external_id: VECCHIO, first_seen_at: '2025-11-01T00:00:00Z' },
      { external_id: RECENTE, first_seen_at: '2026-06-01T00:00:00Z', merged_into: VECCHIO },
      { external_id: TERZO, first_seen_at: '2026-08-01T00:00:00Z' },
    ])!;
    expect(plan.toMerge).toEqual([TERZO]);
  });
});

describe('normalizeEmail', () => {
  it('minuscola e senza spazi, com e nella tabella dei clienti', () => {
    expect(normalizeEmail('  Anna.Rossi@Example.COM ')).toBe('anna.rossi@example.com');
  });

  it('cio che non e un email non va a interrogare il database', () => {
    for (const bad of ['', 'anna', 'anna@', '@example.com', null, undefined]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe('normalizePhone', () => {
  it('sole cifre, com e nella colonna dalla versione 6 in poi', () => {
    // Il piu' e gli spazi della forma leggibile di Shopify non sopravvivono
    // li', e non devono sopravvivere qui o il confronto fallisce proprio sui
    // numeri scritti per esteso.
    expect(normalizePhone('+39 333 123 4567')).toBe('393331234567');
  });

  it('un campo compilato male non pesca il cliente sbagliato', () => {
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('---')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('conservazione dei browser anonimi', () => {
  it('novanta giorni, che e un conto e non un impressione', () => {
    // Cinquantamila sessioni al giorno fanno quattro milioni e mezzo di righe a
    // novanta giorni — dentro il mezzo giga del piano gratuito di Supabase — e
    // diciotto milioni a un anno, che non ci starebbero. E le finestre di
    // attribuzione vere arrivano a trenta giorni: questa e' tre volte tanto.
    expect(ANONYMOUS_USER_RETENTION_DAYS).toBe(90);
  });

  it('la soglia si calcola indietro dall istante dato', () => {
    const cutoff = anonymousUserCutoff(new Date('2026-08-28T00:00:00Z'));
    expect(cutoff.toISOString()).toBe('2026-05-30T00:00:00.000Z');
  });
});

describe('postgrestFilterValue', () => {
  it('toglie l operatore che il merchant scrive davanti al valore', () => {
    // Chi ci chiama usa un template pronto e crede di parlare con PostgREST: la
    // condizione la scrive come si scrive su Supabase.
    expect(postgrestFilterValue('eq.Safari')).toBe('Safari');
    expect(postgrestFilterValue('ilike.mobile')).toBe('mobile');
  });

  it('un valore nudo passa intatto', () => {
    expect(postgrestFilterValue('Safari')).toBe('Safari');
  });

  it('cio che resta vuoto vale come assenza', () => {
    expect(postgrestFilterValue('eq.')).toBeNull();
    expect(postgrestFilterValue('  ')).toBeNull();
    expect(postgrestFilterValue(null)).toBeNull();
  });
});

describe('browsersToForget', () => {
  const riga = (id: string, lastSeen: string, mergedInto: string | null = null) => ({
    external_id: id,
    last_seen_at: lastSeen,
    merged_into: mergedInto,
  });

  it('sotto il tetto non si lascia andare niente', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      riga(`corew_${i}`, `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    );
    expect(browsersToForget(rows)).toEqual([]);
  });

  it('oltre il tetto si tengono le piu recenti', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      riga(`corew_${i}`, `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    );
    // Le due piu' vecchie: quelle del primo e del due agosto.
    expect(browsersToForget(rows).sort()).toEqual(['corew_0', 'corew_1']);
  });

  // Il canonico di una fusione e' il piu' VECCHIO, quindi e' proprio quello che
  // un tetto "tieni le piu' recenti" porterebbe via per primo — lasciando i
  // puntatori delle altre righe nel vuoto.
  it('non si tocca una riga a cui punta un altra, per quanto vecchia', () => {
    const rows = [
      riga('canonico', '2020-01-01T00:00:00Z'),
      riga('rimando', '2026-08-28T00:00:00Z', 'canonico'),
      ...Array.from({ length: 11 }, (_, i) =>
        riga(`corew_${i}`, `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
      ),
    ];
    expect(browsersToForget(rows)).not.toContain('canonico');
  });

  it('i rimandi non si potano: sono la strada per ritrovare un id vecchio', () => {
    const rows = [
      riga('vecchio_rimando', '2019-01-01T00:00:00Z', 'canonico'),
      riga('canonico', '2026-08-28T00:00:00Z'),
      ...Array.from({ length: 11 }, (_, i) =>
        riga(`corew_${i}`, `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
      ),
    ];
    expect(browsersToForget(rows)).not.toContain('vecchio_rimando');
  });

  it('il tetto si puo stringere per i test e per un ripensamento', () => {
    const rows = [
      riga('a', '2026-08-01T00:00:00Z'),
      riga('b', '2026-08-02T00:00:00Z'),
      riga('c', '2026-08-03T00:00:00Z'),
    ];
    expect(browsersToForget(rows, 1)).toEqual(['b', 'a']);
  });
});
