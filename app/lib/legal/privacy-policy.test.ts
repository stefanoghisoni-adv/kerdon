import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES, type Locale } from '~/lib/i18n/locales';
import { COSTRUTTI_NON_SUPPORTATI, renderMarkdown } from './markdown';
import {
  PRIVACY_POLICY_PATH,
  SORGENTI,
  documento,
  indirizzoInformativa,
  linguaDallIntestazione,
  linguaDellaPagina,
  linkInformativa,
  paginaInformativa,
  versioneEData,
} from './privacy-policy';

/**
 * L'informativa pubblicata e' quella del repository, e resta tale.
 *
 * IL DIFETTO CHE QUESTI TEST IMPEDISCONO DI RIPETERE. Il documento stava in
 * `docs/legal/` e la copia che si leggeva stava altrove: le due sono divergute,
 * e una divergenza qui vuol dire dichiarare per iscritto un trattamento diverso
 * da quello vero. Ora la pagina nasce dal file, e quel che resta da sorvegliare
 * sono i due modi in cui il testo potrebbe tornare a perdersi in silenzio:
 * un costrutto Markdown che non sappiamo rendere, e `privacy-policy.html` che
 * prende una strada sua.
 */

const CARTELLA = join(process.cwd(), 'docs', 'legal');
const htmlCurato = readFileSync(join(CARTELLA, 'privacy-policy.html'), 'utf-8');

describe('le fonti', () => {
  it('sono quelle su disco, non una copia rifatta a mano', () => {
    // La prova che `?raw` porta DAVVERO dentro il bundle quel file e non un
    // altro: si confronta con il file letto dal disco qui, dove il disco c'e'.
    // In produzione il disco non c'e' — ed e' esattamente il motivo per cui il
    // contenuto viene importato invece che letto.
    expect(SORGENTI.en).toBe(readFileSync(join(CARTELLA, 'privacy-policy.md'), 'utf-8'));
    expect(SORGENTI.it).toBe(readFileSync(join(CARTELLA, 'privacy-policy.it.md'), 'utf-8'));
  });

  it.each(LOCALES)('%s non usa un costrutto che non sappiamo rendere', (locale) => {
    const trovati = COSTRUTTI_NON_SUPPORTATI.filter(({ regola }) =>
      regola.test(SORGENTI[locale]),
    ).map(({ nome }) => nome);

    // Se questo test fallisce non e' un capriccio del renderer: vuol dire che
    // una parte del documento, in pagina, non si vedrebbe come si legge nel
    // file — e un documento legale che stampa "[testo](url)" ha gia' pubblicato
    // una frase sbagliata. O si toglie il costrutto, o lo si insegna a
    // `markdown.ts`.
    expect(trovati).toEqual([]);
  });
});

/**
 * La costante del percorso corrisponde alla rotta vera.
 *
 * IL DIFETTO CHE QUESTO TEST IMPEDISCE. Prima il percorso era scritto a mano in
 * tre posti, e due di quelli tre sbagliavano. Ora c'e' una costante
 * `PRIVACY_POLICY_PATH` usata ovunque. Questo test verifica che quella costante
 * corrisponda al file di rotta effettivo: se qualcuno rinomina
 * `policies.privacy-policy.tsx` senza aggiornare la costante, o viceversa, il
 * test fallisce. Il percorso e il file restano allineati.
 */
describe('il percorso corrisponde alla rotta', () => {
  it('PRIVACY_POLICY_PATH corrisponde al file policies.privacy-policy.tsx', () => {
    // In Remix flat-route naming, `policies.privacy-policy.tsx` diventa
    // `/policies/privacy-policy`. Si deriva il percorso dal nome del file per
    // verificare che la costante sia allineata.
    const nomeFile = 'policies.privacy-policy.tsx';
    const percorsoAtteso = '/' + nomeFile.replace('.tsx', '').replace(/\./g, '/');

    expect(PRIVACY_POLICY_PATH).toBe(percorsoAtteso);
    expect(PRIVACY_POLICY_PATH).toBe('/policies/privacy-policy');
  });

  it('il file di rotta esiste davvero', () => {
    const percorsoFile = join(process.cwd(), 'app', 'routes', 'policies.privacy-policy.tsx');
    expect(() => readFileSync(percorsoFile, 'utf-8')).not.toThrow();
  });
});

describe('le due lingue dicono la stessa cosa', () => {
  it('hanno le stesse sezioni, nello stesso ordine', () => {
    const numeri = (locale: Locale) => documento(locale).indice.map((voce) => voce.numero);

    expect(numeri('it')).toEqual(numeri('en'));
    expect(numeri('en')).toHaveLength(10);
  });

  it('dichiarano la stessa versione e la stessa data', () => {
    expect(versioneEData(SORGENTI.it)).toEqual(versioneEData(SORGENTI.en));
    expect(versioneEData(SORGENTI.en).versione).toMatch(/^\d+\.\d+$/);
  });
});

/**
 * La terza copia, quella che non nasce dal Markdown.
 *
 * `privacy-policy.html` e' un artefatto autonomo, curato a mano, che la pagina
 * pubblica NON usa: di li' viene solo la veste. Finche' quel file esiste puo'
 * divergere, e divergerebbe senza che nessuno se ne accorga — e' un file che
 * si apre due volte l'anno. Questi controlli fanno in modo che la divergenza
 * si veda qui e non davanti a un revisore.
 */
describe('privacy-policy.html non puo divergere in silenzio', () => {
  const dalHtml = (etichetta: string) =>
    new RegExp(`${etichetta}\\s*<b>([^<]+)</b>`).exec(htmlCurato)?.[1].trim() ?? '';

  const MESI = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];

  /** "18 September 2026" e "18-09-2026" sono lo stesso giorno, scritto in due modi. */
  const giorno = (testo: string): string => {
    const esteso = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(testo);
    if (esteso) {
      const mese = MESI.indexOf(esteso[2].toLowerCase()) + 1;
      return `${esteso[3]}-${String(mese).padStart(2, '0')}-${esteso[1].padStart(2, '0')}`;
    }
    const breve = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(testo);
    if (breve) return `${breve[3]}-${breve[2].padStart(2, '0')}-${breve[1].padStart(2, '0')}`;
    return testo;
  };

  it('dichiara la stessa versione dei due Markdown', () => {
    expect(dalHtml('Version')).toBe(versioneEData(SORGENTI.en).versione);
  });

  it('dichiara la stessa data dei due Markdown', () => {
    expect(giorno(dalHtml('Last updated'))).toBe(giorno(versioneEData(SORGENTI.en).data));
  });

  it('ha le stesse sezioni, con gli stessi titoli e nello stesso ordine', () => {
    const titoliHtml = [...htmlCurato.matchAll(/<h2><span class="num">\d+<\/span>([^<]+)<\/h2>/g)]
      .map((trovato) => trovato[1].trim());

    expect(titoliHtml).toEqual(documento('en').indice.map((voce) => voce.titolo));
  });
});

describe('la lingua della pagina', () => {
  it('la sceglie chi manda il link, quando la nomina', () => {
    expect(linguaDellaPagina('it', 'en-US,en;q=0.9')).toEqual({ locale: 'it', esplicita: true });
    expect(linguaDellaPagina('en', 'it-IT,it;q=0.9')).toEqual({ locale: 'en', esplicita: true });
  });

  it('un valore inventato non passa: si torna a chiedere al browser', () => {
    expect(linguaDellaPagina('klingon', 'it-IT,it;q=0.9')).toEqual({
      locale: 'it',
      esplicita: false,
    });
  });

  it('senza parametro la dice il browser', () => {
    expect(linguaDallIntestazione('it-IT,it;q=0.9,en;q=0.8')).toBe('it');
    expect(linguaDallIntestazione('en-GB,en;q=0.9')).toBe('en');
  });

  it('conta il peso dichiarato, non l ordine di scrittura', () => {
    // Un browser che chiede prima una lingua che non abbiamo: la nostra e' la
    // seconda scritta, ma e' quella che vuole di piu' fra quelle disponibili.
    expect(linguaDallIntestazione('fr-FR,fr;q=1.0,it;q=0.9,en;q=0.2')).toBe('it');
    expect(linguaDallIntestazione('fr-FR,fr;q=1.0,it;q=0.2,en;q=0.9')).toBe('en');
  });

  it('nessuna lingua nostra, o nessuna intestazione: si legge in inglese', () => {
    // E' il caso del revisore Shopify, che arriva senza niente addosso.
    expect(linguaDallIntestazione(null)).toBe('en');
    expect(linguaDallIntestazione('de-DE,de;q=0.9')).toBe('en');
  });
});

describe('la pagina resa', () => {
  it.each(LOCALES)('%s: porta dentro tutte le sezioni del documento', (locale) => {
    const pagina = paginaInformativa(locale);

    for (const voce of documento(locale).indice) {
      expect(pagina).toContain(`id="${voce.id}"`);
      expect(pagina).toContain(`href="#${voce.id}"`);
    }
  });

  it.each(LOCALES)('%s: nessun paragrafo del file resta fuori', (locale) => {
    // Il controllo che conta davvero: non "la pagina non e' vuota", ma che ogni
    // riga di testo del file compaia. Un renderer che perdesse un blocco
    // produrrebbe comunque una pagina bella e completa a vedersi.
    const testo = paginaInformativa(locale)
      .replace(/<style>[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ');

    // Fuori: i titoli (che l'indice verifica gia'), le righe di tabella (che
    // in pagina si spezzano in celle) e le due righe d'intestazione, che la
    // veste stampa senza i due punti — quelle si controllano qui sotto.
    const intestazione = documento(locale).intestazione;
    const righe = SORGENTI[locale]
      .split('\n')
      .map((riga) => riga.trim())
      .filter((riga) => riga !== '' && !riga.startsWith('#') && !riga.startsWith('|'))
      .filter((riga) => !intestazione.some((voce) => riga.startsWith(`**${voce.etichetta}:**`)));

    // Gli spazi si tolgono da tutt'e due le parti: togliendo i tag resta uno
    // spazio dove il tag stava — «privacy-policy.md ;» invece di
    // «privacy-policy.md;» — ed e' una differenza di impaginazione, non di
    // testo. Quel che si vuole sapere e' se le parole ci sono.
    const nudo = (riga: string) =>
      riga
        .replace(/^[->]\s*/, '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .replace(/\s+/g, '');

    for (const voce of intestazione) {
      expect(testo).toContain(voce.etichetta);
      expect(testo).toContain(voce.valore);
    }

    const testoNudo = testo.replace(/\s+/g, '');
    for (const riga of righe) {
      expect(testoNudo, `manca: ${riga.slice(0, 60)}`).toContain(nudo(riga));
    }
  });

  it.each(LOCALES)('%s: dichiara la lingua nel documento e offre l altra', (locale) => {
    const pagina = paginaInformativa(locale);
    const altra = locale === 'it' ? 'en' : 'it';

    expect(pagina).toContain(`<html lang="${locale}">`);
    expect(pagina).toContain(`href="?lang=${altra}"`);
    expect(pagina).toContain('hreflang="x-default"');
  });

  it('non carica niente da fuori e non esegue niente', () => {
    // Su una pagina che spiega quali dati raccogliamo, un font di terzi manda
    // l'IP di chi legge a qualcun altro prima della prima riga.
    for (const locale of LOCALES) {
      const pagina = paginaInformativa(locale);
      expect(pagina).not.toContain('<script');
      expect(pagina).not.toMatch(/(src|href)="https?:\/\//);
    }
  });

  it('il testo del documento non puo iniettare HTML', () => {
    // La fonte e' un file nostro, ma il renderer e' generico: se domani ci
    // finisse dentro un `<` andrebbe stampato, non eseguito.
    const reso = renderMarkdown('# T\n\n## 1. S\n\n<img src=x onerror=alert(1)> **ok**\n');

    expect(reso.corpo).toContain('&lt;img');
    expect(reso.corpo).not.toContain('<img');
    expect(reso.corpo).toContain('<strong>ok</strong>');
  });
});

/**
 * I link all'informativa generati dall'app portano tutti alla rotta giusta.
 *
 * IL DIFETTO CHE QUESTO TEST IMPEDISCE. Prima di questo cambio stavano tre
 * versioni sparse del percorso: una nel modal, una negli hreflang della pagina
 * stessa, e una — quella giusta — nell'helper. Due di quelle tre sbagliavano,
 * e chi le apriva trovava un 410. Ora c'e' un solo punto in cui si costruisce
 * il percorso, e questo test verifica che ogni link generato dall'app punti
 * alla rotta vera.
 */
describe('i link generati portano alla rotta giusta', () => {
  it.each(LOCALES)('linkInformativa(%s) genera la rotta corretta', (locale) => {
    const link = linkInformativa(locale);
    expect(link).toContain(PRIVACY_POLICY_PATH);
    expect(link).toContain(`lang=${locale}`);
    // Inizia con il percorso corretto, non con doppie barre ne' percorsi sbagliati
    expect(link).toMatch(/^\/policies\/privacy-policy\?lang=/);
  });

  it.each(LOCALES)('indirizzoInformativa(%s) costruisce l URL assoluto corretto', (locale) => {
    const base = 'https://api.kerdon.io';
    const url = indirizzoInformativa(base, locale);
    expect(url).toBe(`${base}${linkInformativa(locale)}`);
    expect(url).toContain(PRIVACY_POLICY_PATH);
    expect(url).not.toContain('/policies/policies/'); // il doppio che c'era prima
  });

  it('tutti i link nella pagina resa usano la rotta corretta', () => {
    for (const locale of LOCALES) {
      const pagina = paginaInformativa(locale);

      // Gli hreflang alternates devono tutti puntare alla rotta corretta
      const hreflangMatch = pagina.match(/hreflang="[^"]+"\s+href="([^"]+)"/g);
      expect(hreflangMatch).toBeTruthy();

      for (const match of hreflangMatch!) {
        const href = /href="([^"]+)"/.exec(match)?.[1];
        expect(href).toContain(PRIVACY_POLICY_PATH);
        // NON il percorso senza il prefisso /policies/ (il vecchio sbagliato)
        expect(href).not.toMatch(/^\/privacy-policy\?/);
        // NON il doppio che c'era prima
        expect(href).not.toContain('/policies/policies/');
      }

      // Il link di cambio lingua deve usare la rotta corretta
      const switchLink = /href="\?lang=(en|it)"/.exec(pagina);
      expect(switchLink).toBeTruthy(); // usa parametro relativo, che va bene
    }
  });
});
