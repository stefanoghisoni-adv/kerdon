import sorgenteInglese from '../../../docs/legal/privacy-policy.md?raw';
import sorgenteItaliana from '../../../docs/legal/privacy-policy.it.md?raw';
import { FALLBACK_LOCALE, LOCALES, type Locale } from '~/lib/i18n/locales';
import { renderMarkdown, type DocumentoReso } from './markdown';
import { STILE_DOCUMENTO } from './stile-documento';

/**
 * L'informativa sulla privacy, servita dal documento che sta in repository.
 *
 * IL DIFETTO CHE QUESTO FILE TOGLIE. L'informativa viveva in `docs/legal/`, ma
 * la copia che il merchant e il revisore Shopify leggevano stava altrove, e a
 * ogni modifica andava ripubblicata a mano. Le due cose sono gia' divergute
 * una volta, e una divergenza qui non e' un refuso: e' un documento legale che
 * dichiara un trattamento diverso da quello che l'app fa davvero. Ora la
 * pagina pubblica NASCE dal file: cambiarlo e fare il deploy sono lo stesso
 * gesto, e non esiste piu' una seconda copia che possa restare indietro.
 *
 * PERCHE' DAL MARKDOWN E NON DA `privacy-policy.html`. Perche' l'HTML curato a
 * mano esiste in inglese soltanto, e servirlo avrebbe lasciato l'italiano
 * senza pagina — oppure avrebbe creato una terza copia del testo italiano. Il
 * Markdown invece c'e' in tutte e due le lingue ed e' la fonte che viene
 * aggiornata per prima. La VESTE dell'HTML non si butta via: e' copiata in
 * `stile-documento.ts` ed e' quella che si vede qui. Quel che resta di
 * `privacy-policy.html` e' un artefatto autonomo, e perche' non possa
 * divergere in silenzio ci pensa `privacy-policy.test.ts`, che confronta
 * versione, data e titoli delle sezioni fra i tre file.
 *
 * PERCHE' `?raw` E NON `fs.readFileSync`. Perche' l'app gira su Vercel, dove
 * la funzione serverless porta con se' il proprio bundle e NON la cartella
 * `docs/`: una lettura da disco a runtime compilerebbe, passerebbe i test in
 * locale — dove il repository c'e' tutto — e fallirebbe la prima volta in
 * produzione, cioe' nel momento peggiore, con la pagina dell'informativa in
 * errore davanti al revisore. Con `?raw` il contenuto e' una stringa dentro il
 * bundle, messa li' da Vite al momento del build: a runtime non c'e' nessun
 * file da trovare. Che ci sia davvero si verifica cercando una frase del
 * documento dentro `build/server/index.js` dopo `npm run build`.
 */

/** Le fonti, una per lingua: e' l'unico posto in cui il testo esiste. */
export const SORGENTI: Readonly<Record<Locale, string>> = {
  en: sorgenteInglese,
  it: sorgenteItaliana,
};

/**
 * Le poche parole che stanno intorno al documento e non dentro.
 *
 * Non nel dizionario dell'app: quello raccoglie i testi che il merchant legge
 * DENTRO l'app, e questa non e' una schermata dell'app — e' un documento
 * pubblico, che legge anche chi non ha nessun negozio. Tenerle qui vuol dire
 * che chi tocca la pagina le trova nel file che sta guardando.
 */
const CORNICE: Record<Locale, { indice: string; altraLingua: string }> = {
  it: { indice: 'Indice', altraLingua: 'English' },
  en: { indice: 'Contents', altraLingua: 'Italiano' },
};

/** La lingua richiesta apertamente, quando il link la nomina. */
export function linguaEsplicita(valore: string | null): Locale | null {
  const pulito = (valore ?? '').trim().toLowerCase();
  return (LOCALES as readonly string[]).includes(pulito) ? (pulito as Locale) : null;
}

/**
 * La lingua che il browser dichiara di preferire.
 *
 * PERCHE' L'INTESTAZIONE E NON IL MECCANISMO DI LINGUA DELL'APP. Perche'
 * quello parte dal negozio: legge la scelta salvata su `Shop`, o in mancanza
 * la lingua che l'admin di Shopify dichiara. Qui non c'e' nessun negozio — chi
 * apre questa pagina puo' non averne uno, ed e' proprio il caso del revisore
 * Shopify — quindi non c'e' niente da leggere. L'unica cosa che chi arriva
 * porta con se' e' `Accept-Language`, ed e' esattamente la domanda "in che
 * lingua leggi?".
 *
 * Si guardano i valori di qualita': un browser che dichiara
 * `fr, it;q=0.9, en;q=0.8` vuole il francese, che non abbiamo, e poi
 * l'italiano — e l'ordine di scrittura da solo non lo direbbe.
 */
export function linguaDallIntestazione(intestazione: string | null): Locale {
  const preferenze = (intestazione ?? '')
    .split(',')
    .map((voce) => {
      const [tag, ...parametri] = voce.trim().split(';');
      const q = parametri
        .map((p) => /^\s*q=([\d.]+)\s*$/.exec(p))
        .find((trovato) => trovato !== null);
      return { base: tag.trim().toLowerCase().split('-')[0], peso: q ? Number(q[1]) : 1 };
    })
    .filter((voce) => voce.base !== '')
    .sort((a, b) => b.peso - a.peso);

  const trovata = preferenze.find((voce) =>
    (LOCALES as readonly string[]).includes(voce.base),
  );
  // Nessuna delle nostre: si ripiega sull'inglese, per la stessa ragione per
  // cui e' la lingua di riserva dell'app — chi non legge in italiano legge in
  // inglese molto piu' probabilmente del contrario.
  return trovata ? (trovata.base as Locale) : FALLBACK_LOCALE;
}

/** In che lingua servire la pagina, e se qualcuno l'ha chiesto per nome. */
export function linguaDellaPagina(
  parametro: string | null,
  intestazione: string | null,
): { locale: Locale; esplicita: boolean } {
  const scelta = linguaEsplicita(parametro);
  if (scelta) return { locale: scelta, esplicita: true };
  return { locale: linguaDallIntestazione(intestazione), esplicita: false };
}

/** Il documento di una lingua, gia' letto. */
export function documento(locale: Locale): DocumentoReso {
  return renderMarkdown(SORGENTI[locale]);
}

/**
 * Versione e data di aggiornamento, come il documento le dichiara.
 *
 * Servono al test che sorveglia le tre copie, e servono all'intestazione della
 * pagina. Si leggono dalle righe `**Etichetta:** valore` in cima, che sono le
 * uniche due righe di quella forma prima della sezione 1.
 */
export function versioneEData(sorgente: string): { versione: string; data: string } {
  const voci = renderMarkdown(sorgente).intestazione;
  // Si riconoscono dalla FORMA del valore e non dalla posizione ne' dalla
  // etichetta: l'etichetta cambia con la lingua ("Version" / "Versione") e
  // l'ordine e' una consuetudine che un giorno qualcuno invertira'.
  const conForma = (regola: RegExp) => voci.find((v) => regola.test(v.valore))?.valore ?? '';
  return {
    data: conForma(/^\d{1,2}-\d{1,2}-\d{4}$/),
    versione: conForma(/^\d+(\.\d+)*$/),
  };
}

/** L'indirizzo pubblico della pagina, con la lingua scritta dentro. */
export function indirizzoInformativa(base: string, locale: Locale): string {
  return `${base.replace(/\/+$/, '')}/policies/privacy-policy?lang=${locale}`;
}

/** Il testo, gia' innocuo, dentro un attributo. */
function attributo(testo: string): string {
  return testo
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * La pagina intera, pronta da servire.
 *
 * NESSUNO SCRIPT E NESSUNA RICHIESTA VERSO TERZI. Il documento originale
 * caricava i font di Google e teneva un piccolo script per evidenziare nella
 * colonna dell'indice la sezione in lettura. Tutti e due sono spariti: su una
 * pagina che spiega quali dati raccogliamo, il primo mandava l'indirizzo IP di
 * chi legge a un terzo prima ancora della prima riga, e il secondo era
 * JavaScript in linea su una pagina che di JavaScript non ha bisogno. Quel che
 * resta e' HTML e CSS, e si legge anche con gli script spenti.
 */
export function paginaInformativa(locale: Locale): string {
  const doc = documento(locale);
  const cornice = CORNICE[locale];
  const altra: Locale = locale === 'it' ? 'en' : 'it';

  const stampa = doc.intestazione
    .map((voce) => `<span>${attributo(voce.etichetta)} <b>${attributo(voce.valore)}</b></span>`)
    .join('\n        ');

  const indice = doc.indice
    .map((voce) => `<li><a href="#${voce.id}">${attributo(voce.titolo)}</a></li>`)
    .join('\n        ');

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Tema chiaro e basta, come in tutto il resto dell'app. -->
<meta name="color-scheme" content="light">
<title>${attributo(doc.titolo)}</title>
<!-- Le due lingue si dichiarano a chi indicizza: senza, la pagina italiana e
     quella inglese sembrano due documenti diversi con lo stesso contenuto. -->
<link rel="alternate" hreflang="it" href="/privacy-policy?lang=it">
<link rel="alternate" hreflang="en" href="/privacy-policy?lang=en">
<link rel="alternate" hreflang="x-default" href="/privacy-policy?lang=${FALLBACK_LOCALE}">
<style>${STILE_DOCUMENTO}</style>
</head>
<body>
<div class="shell">

  <header class="masthead">
    <p class="wordmark">Kerdon</p>
    <h1>${attributo(doc.titolo.replace(/^Kerdon\s*[—-]\s*/, ''))}</h1>
    <div class="stamp">
        ${stampa}
        <span><a href="?lang=${altra}" hreflang="${altra}" lang="${altra}">${cornice.altraLingua}</a></span>
    </div>
  </header>

  <nav class="rail" aria-label="${attributo(cornice.indice)}">
    <div class="rail-inner">
      <h2>${attributo(cornice.indice)}</h2>
      <ol>
        ${indice}
      </ol>
    </div>
  </nav>

  <main>
${doc.preambolo}

${doc.corpo}
  </main>

</div>
</body>
</html>
`;
}
