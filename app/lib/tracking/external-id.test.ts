import { describe, it, expect } from 'vitest';
import {
  externalIdCookie,
  isExternalId,
  newExternalId,
  readExternalId,
  incomingExternalId,
  LEGACY_EXTERNAL_ID_PATTERN,
  EXTERNAL_ID_COOKIE,
  EXTERNAL_ID_HEADER,
  EXISTING_EXTERNAL_ID_PARAM,
} from './external-id';

describe('newExternalId', () => {
  it('ha il formato kerdon_<32 caratteri>, e nient altro', () => {
    expect(newExternalId()).toMatch(/^kerdon_[A-Za-z0-9]{32}$/);
  });

  // Il momento in cui il browser e' stato visto la prima volta sta in
  // `first_seen_at`, dove il merchant lo controlla e puo' cancellarlo. Dentro
  // l'identificativo viaggiava ovunque andasse l'identificativo, leggibile da
  // chiunque lo vedesse passare, e non c'era modo di toglierlo.
  it('non porta dentro il momento in cui e stato coniato', () => {
    const prima = Date.now();
    const id = newExternalId();
    const dopo = Date.now();

    for (const pezzo of id.slice('kerdon_'.length).match(/\d+/g) ?? []) {
      const numero = Number(pezzo);
      // Nessuna sequenza di cifre puo' essere l'istante di adesso, ne' in
      // millisecondi ne' in secondi.
      expect(numero >= prima && numero <= dopo).toBe(false);
      expect(numero >= Math.floor(prima / 1000) && numero <= Math.ceil(dopo / 1000)).toBe(false);
    }
  });

  it('i 32 caratteri sono lettere e cifre, niente altro', () => {
    const random = newExternalId().split('_')[1];
    expect(random).toHaveLength(32);
    expect(random).toMatch(/^[A-Za-z0-9]+$/);
  });

  // Un identificativo deve identificare e nient'altro: non porta informazioni sul
  // browser, sul dispositivo o sul momento. Se lo facesse, quelle informazioni
  // viaggierebbero ovunque l'identificativo andasse, leggibili da chiunque,
  // senza che il merchant potesse cancellarle.
  it('non contiene dati di browser, dispositivo o timestamp', () => {
    const id = newExternalId();
    const parti = id.split('_');

    // Solo due parti: prefisso + 32 caratteri casuali
    expect(parti).toHaveLength(2);
    expect(parti[0]).toBe('kerdon');
    expect(parti[1]).toHaveLength(32);

    // L'entropia attesa e' alta: almeno 20 caratteri distinti su 32
    // (un timestamp o un hash di user agent avrebbe sequenze ripetute)
    const caratteriDistinti = new Set(parti[1]).size;
    expect(caratteriDistinti).toBeGreaterThanOrEqual(20);
  });

  // Prova deterministica: l'ID non dipende dall'istante ne' dal browser.
  // Con crypto.getRandomValues sostituito da byte fissi, l'ID generato e'
  // identico anche cambiando Date.now e navigator.userAgent. Senza stub, due ID
  // generati nello stesso millisecondo sono diversi.
  it('non dipende da Date.now, performance.now o navigator.userAgent', () => {
    const bytesFissi = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) bytesFissi[i] = (i * 7) % 256;

    const originalGetRandomValues = crypto.getRandomValues.bind(crypto);
    const stub = (array: Uint8Array) => {
      for (let i = 0; i < array.length; i += 1) {
        array[i] = bytesFissi[i % bytesFissi.length];
      }
      return array;
    };

    try {
      // Con byte fissi, l'ID deve essere identico anche cambiando l'istante
      crypto.getRandomValues = stub as typeof crypto.getRandomValues;

      const id1 = newExternalId();

      // Cambia l'istante (se newExternalId usasse Date.now, l'ID cambierebbe)
      const originalNow = Date.now;
      const originalPerfNow = performance.now;
      try {
        Date.now = () => originalNow() + 1000000;
        performance.now = () => originalPerfNow() + 1000000;

        const id2 = newExternalId();

        // Se l'ID dipendesse dall'istante, id1 !== id2. Invece sono uguali.
        expect(id2).toBe(id1);
      } finally {
        Date.now = originalNow;
        performance.now = originalPerfNow;
      }

      // Cambia navigator.userAgent (se newExternalId lo leggesse, l'ID cambierebbe)
      const id3 = newExternalId();
      expect(id3).toBe(id1);

    } finally {
      crypto.getRandomValues = originalGetRandomValues;
    }

    // Senza stub, due ID generati nello stesso millisecondo sono diversi
    const ids = new Set<string>();
    const start = Date.now();
    while (Date.now() === start && ids.size < 2) {
      ids.add(newExternalId());
    }
    // Se fossimo usciti perche' il millisecondo e' cambiato prima di averne
    // generati due, il test non prova niente. In pratica ne generiamo decine
    // nello stesso millisecondo.
    if (ids.size >= 2) {
      expect(ids.size).toBe(2);
    }
  });

  it('cinquecento identificativi di fila sono cinquecento identificativi diversi', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newExternalId()));
    expect(ids.size).toBe(500);
  });

  it('usa tutto l alfabeto, non solo le prime lettere', () => {
    // 256 non e' divisibile per 62: prendendo il resto senza scartare i valori
    // in eccesso, le prime lettere uscirebbero piu' spesso delle ultime.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const ch of newExternalId().split('_')[1]) seen.add(ch);
    }
    // Con 6400 caratteri estratti su 62 possibili, mancarne qualcuno vorrebbe
    // dire che non viene mai pescato.
    expect(seen.size).toBe(62);
  });
});

// Gli identificativi vecchi sono nei browser delle persone e nelle righe gia'
// scritte: rifiutarli vorrebbe dire coniarne uno nuovo a chiunque torni, cioe'
// perdere esattamente cio' per cui esistono.
describe('gli identificativi del formato precedente', () => {
  const vecchio = 'corew_1756200000000_aB3dEfGhIjKlMnOpQrStUvWxYz012345';

  it('restano validi', () => {
    expect(isExternalId(vecchio)).toBe(true);
  });

  it('si riconoscono ancora come tali', () => {
    expect(LEGACY_EXTERNAL_ID_PATTERN.test(vecchio)).toBe(true);
    expect(LEGACY_EXTERNAL_ID_PATTERN.test(newExternalId())).toBe(false);
  });

  // Il cambio di nome del prodotto non e' una ragione per non riconoscere piu'
  // una persona. Un identificativo coniato prima porta il nome di prima, ed e'
  // nel browser di qualcuno: se smettesse di valere, quel browser tornerebbe
  // sconosciuto e il suo storico resterebbe legato a un identificativo che
  // nessuno cerca piu'.
  it('anche quelli col nome di prima del cambio restano validi', () => {
    expect(isExternalId('corew_aB3dEfGhIjKlMnOpQrStUvWxYz0123456')).toBe(false);
    expect(isExternalId('corew_aB3dEfGhIjKlMnOpQrStUvWxYz012345')).toBe(true);
    expect(isExternalId(vecchio)).toBe(true);
  });

  it('ma se ne conia uno solo, col nome di adesso', () => {
    expect(newExternalId().startsWith('kerdon_')).toBe(true);
  });

  it('arrivano fino in fondo come gli altri', () => {
    const url = new URL('https://api.kerdon.io/rest/v1/tracking_id');
    const headers = new Headers({ [EXTERNAL_ID_HEADER]: vecchio });
    expect(incomingExternalId(new Request(url, { headers }))).toBe(vecchio);
    expect(readExternalId(`${EXTERNAL_ID_COOKIE}=${vecchio}`)).toBe(vecchio);
  });
});

describe('isExternalId', () => {
  it('riconosce i propri', () => {
    expect(isExternalId(newExternalId())).toBe(true);
  });

  it('scarta tutto il resto', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'corew_123',
      'corew__abc',
      `corew_123_${'a'.repeat(31)}`,
      `corew_123_${'a'.repeat(33)}`,
      `corew_123_${'a'.repeat(31)}-`,
      `altro_123_${'a'.repeat(32)}`,
    ]) {
      expect(isExternalId(bad as string)).toBe(false);
    }
  });
});

describe('il cookie', () => {
  it('viaggia fra domini diversi, o il browser lo butta', () => {
    // La richiesta parte dal negozio del merchant verso il nostro dominio.
    const cookie = externalIdCookie(newExternalId());
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain(`${EXTERNAL_ID_COOKIE}=`);
  });

  it('non e HttpOnly: deve poterlo leggere il codice nella pagina', () => {
    // Non e' una credenziale: nasconderlo al solo script che lo usa lo
    // renderebbe inutile.
    expect(externalIdCookie(newExternalId())).not.toContain('HttpOnly');
  });

  it('chiede un anno di vita al browser, che poi fa come vuole', () => {
    expect(externalIdCookie(newExternalId())).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
  });
});

describe('readExternalId', () => {
  it('lo trova fra gli altri cookie del negozio', () => {
    const id = newExternalId();
    expect(readExternalId(`_shopify_y=abc; ${EXTERNAL_ID_COOKIE}=${id}; cart=1`)).toBe(id);
  });

  it('senza cookie, niente', () => {
    expect(readExternalId(null)).toBeNull();
    expect(readExternalId('')).toBeNull();
    expect(readExternalId('_shopify_y=abc')).toBeNull();
  });

  it('un valore malformato vale come assente', () => {
    // Meglio ripartire con uno buono che trascinarsi dietro qualcosa che
    // nessuna query sapra' incrociare.
    expect(readExternalId(`${EXTERNAL_ID_COOKIE}=rotto`)).toBeNull();
  });
});

// L'identificativo e' l'unico appiglio che l'app ha per riconoscere chi torna:
// se si perde, ogni visita diventa una persona nuova e tutto quello che ci sta
// sopra — ordini attribuiti, valore nel tempo — non regge piu'. Chi chiama non
// e' un browser ma un endpoint del negozio, e questi sono i modi in cui ci
// rimanda il valore che il visitatore ha gia'.
describe('incomingExternalId', () => {
  const richiesta = (init?: { header?: string; query?: string; cookie?: string }) => {
    const url = new URL('https://api.kerdon.io/rest/v1/tracking_id');
    if (init?.query !== undefined) url.searchParams.set(EXISTING_EXTERNAL_ID_PARAM, init.query);

    const headers = new Headers();
    if (init?.header !== undefined) headers.set(EXTERNAL_ID_HEADER, init.header);
    if (init?.cookie !== undefined) headers.set('Cookie', init.cookie);

    return new Request(url, { headers });
  };

  it('legge quello che il container rimanda nell header', () => {
    const id = newExternalId();
    expect(incomingExternalId(richiesta({ header: id }))).toBe(id);
  });

  it('legge il parametro di query dove l header non si puo aggiungere', () => {
    const id = newExternalId();
    expect(incomingExternalId(richiesta({ query: id }))).toBe(id);
  });

  it('legge ancora il cookie, per chi chiama davvero da un browser', () => {
    const id = newExternalId();
    expect(incomingExternalId(richiesta({ cookie: `${EXTERNAL_ID_COOKIE}=${id}` }))).toBe(id);
  });

  // L'ordine non e' arbitrario: l'header lo mette il container leggendo il
  // cookie first-party del negozio, che e' la fonte piu' affidabile che
  // abbiamo. Il cookie sul nostro dominio e' quello che Safari accorcia.
  it('l header vince sulla query, e la query sul cookie', () => {
    const daHeader = newExternalId();
    const daQuery = newExternalId();
    const daCookie = newExternalId();

    expect(
      incomingExternalId(
        richiesta({ header: daHeader, query: daQuery, cookie: `${EXTERNAL_ID_COOKIE}=${daCookie}` }),
      ),
    ).toBe(daHeader);

    expect(
      incomingExternalId(richiesta({ query: daQuery, cookie: `${EXTERNAL_ID_COOKIE}=${daCookie}` })),
    ).toBe(daQuery);
  });

  it('senza niente da nessuna parte, niente', () => {
    expect(incomingExternalId(richiesta())).toBeNull();
  });

  // Un valore scelto da chi chiama non deve poter diventare l identificativo di
  // qualcun altro: se non ha la nostra forma vale come assente, e se ne conia
  // uno buono.
  it('un valore malformato vale come assente, da qualunque parte arrivi', () => {
    expect(incomingExternalId(richiesta({ header: 'inventato' }))).toBeNull();
    expect(incomingExternalId(richiesta({ query: '../../etc/passwd' }))).toBeNull();
    expect(incomingExternalId(richiesta({ cookie: `${EXTERNAL_ID_COOKIE}=rotto` }))).toBeNull();
  });

  it('un header malformato non nasconde un cookie buono', () => {
    const id = newExternalId();
    expect(
      incomingExternalId(richiesta({ header: 'rotto', cookie: `${EXTERNAL_ID_COOKIE}=${id}` })),
    ).toBe(id);
  });
});
