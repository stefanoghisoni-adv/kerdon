/**
 * Il poco Markdown che i documenti legali usano — e nient'altro.
 *
 * PERCHE' SCRITTO QUI E NON PRESO DA UNA LIBRERIA. Perche' il difetto che
 * questo giro toglie e' "due copie dello stesso testo che divergono", e
 * rimediarci aggiungendo un pacchetto vorrebbe dire risolvere un problema di
 * duplicazione creando un problema di dipendenze: un motore Markdown generico
 * porta dentro molte migliaia di righe, un'intera grammatica che questi
 * documenti non useranno mai, e la sanificazione dell'HTML grezzo — che qui
 * semplicemente non esiste, perche' l'unico HTML che esce da questo file lo
 * scriviamo noi. In `package.json` non c'era niente di adatto, e i due
 * documenti usano sette costrutti in tutto.
 *
 * COSA SA FARE, per esteso: titolo `#`, sezioni `## 1. Titolo`, sottosezioni
 * `### 1.1 Titolo`, paragrafi, `**grassetto**`, `` `codice` ``, elenchi `- `,
 * tabelle `| a | b |`, citazioni `> `, e gli indirizzi email che diventano
 * link. Nient'altro.
 *
 * E COSA SUCCEDE SE UN DOCUMENTO USA ALTRO. Non un errore in produzione: un
 * test. `privacy-policy.test.ts` legge le fonti e pretende che dentro non ci
 * sia nessun costrutto che questo file non sappia rendere — un link
 * `[testo](url)`, un'immagine, un elenco numerato. Senza quel controllo un
 * costrutto ignoto non si vedrebbe come un guasto: si vedrebbe come una riga
 * di testo con dentro delle parentesi quadre, cioe' come niente, ed e'
 * esattamente il modo in cui un documento legale pubblica una frase sbagliata.
 */

/** Una voce dell'indice: la sezione a cui l'ancora porta. */
export interface VoceIndice {
  /** L'ancora, ricavata dal titolo: l'indice e i titoli non possono sfasarsi. */
  readonly id: string;
  /** Il numero come lo scrive il documento ("1", "2", ...). */
  readonly numero: string;
  readonly titolo: string;
}

/** Una riga dell'intestazione: `**Versione:** 1.3`. */
export interface VoceIntestazione {
  readonly etichetta: string;
  readonly valore: string;
}

export interface DocumentoReso {
  /** Il titolo del documento, dal `#` di apertura. */
  readonly titolo: string;
  /** Versione, data di aggiornamento: quel che sta in cima, prima delle sezioni. */
  readonly intestazione: readonly VoceIntestazione[];
  /** L'indice, nell'ordine in cui le sezioni compaiono. */
  readonly indice: readonly VoceIndice[];
  /** Il corpo in HTML: una `<section>` per ogni `##`. */
  readonly corpo: string;
  /** Quel che sta fra l'intestazione e la prima sezione (la nota di traduzione). */
  readonly preambolo: string;
}

const TITOLO = /^#\s+(.+)$/;
const SEZIONE = /^##\s+(\d+)\.\s+(.+)$/;
const SOTTOSEZIONE = /^###\s+([\d.]+)\s+(.+)$/;
const INTESTAZIONE = /^\*\*(.+?):\*\*\s*(.*)$/;
const CITAZIONE = /^>\s?(.*)$/;
const ELENCO = /^-\s+(.+)$/;
const TABELLA = /^\|(.*)\|\s*$/;
const SEPARATORE_TABELLA = /^\|[\s:|-]+\|\s*$/;

/**
 * I costrutti che questo file NON sa rendere.
 *
 * Il test li cerca nelle fonti. Sono scritti qui e non li' perche' l'elenco
 * appartiene a chi rende, non a chi verifica: chi domani insegnasse i link a
 * `inline()` toglierebbe la riga da qui, nello stesso file che ha cambiato.
 */
export const COSTRUTTI_NON_SUPPORTATI: readonly { nome: string; regola: RegExp }[] = [
  { nome: 'link', regola: /\[[^\]]*\]\([^)]*\)/ },
  { nome: 'immagine', regola: /!\[[^\]]*\]/ },
  { nome: 'corsivo con underscore', regola: /(^|\s)_[^_\n]+_(\s|$)/ },
  { nome: 'barrato', regola: /~~/ },
  { nome: 'elenco numerato', regola: /^\s*\d+\.\s+/m },
  { nome: 'blocco di codice', regola: /^```/m },
  { nome: 'HTML grezzo', regola: /^\s*<[a-z]/im },
  { nome: 'titolo sottolineato', regola: /^(=|-){3,}\s*$/m },
];

/** Il testo, reso innocuo prima di diventare HTML. */
function proteggi(testo: string): string {
  return testo
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Il testo di una riga, con dentro grassetto, codice ed email.
 *
 * I frammenti di codice si tolgono PRIMA di tutto il resto e si rimettono per
 * ultimi: dentro un `` `...` `` gli asterischi e le chiocciole sono caratteri,
 * non comandi, e un documento che nominasse un `**` dentro un frammento non
 * deve vederselo trasformare in grassetto.
 */
export function inline(testo: string): string {
  const frammenti: string[] = [];
  let reso = testo.replace(/`([^`]+)`/g, (_intero, codice: string) => {
    frammenti.push(proteggi(codice));
    return `\u0000${frammenti.length - 1}\u0000`;
  });

  reso = proteggi(reso);
  reso = reso.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Gli indirizzi email nel testo diventano link: nell'informativa sono il modo
  // in cui si esercita un diritto, e un diritto che va copiato a mano si
  // esercita meno.
  reso = reso.replace(
    /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+[A-Za-z])/g,
    '<a href="mailto:$1">$1</a>',
  );

  return reso.replace(/\u0000(\d+)\u0000/g, (_intero, indice: string) => {
    return `<code>${frammenti[Number(indice)]}</code>`;
  });
}

/**
 * L'ancora di una sezione, dal suo titolo.
 *
 * Dal titolo e non da un elenco scritto a mano: l'indice e le sezioni nascono
 * dalla stessa stringa, quindi un titolo cambiato sposta l'ancora e la voce
 * dell'indice insieme. Un elenco a parte si sarebbe disallineato al primo
 * ritocco, con il sintomo peggiore che un indice possa avere — un link che non
 * porta da nessuna parte.
 */
export function ancora(titolo: string): string {
  return titolo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Il numero di sezione come lo stampa l'indice: "01", "02", ... */
function numeroIndice(numero: string): string {
  return numero.padStart(2, '0');
}

/** Le righe di una tabella, gia' divise per colonna. */
function celle(riga: string): string[] {
  return riga
    .replace(/^\||\|\s*$/g, '')
    .split('|')
    .map((cella) => cella.trim());
}

/**
 * Il documento, letto una riga per volta.
 *
 * A righe e non a espressioni regolari sull'intero testo perche' i blocchi qui
 * sono tutti delimitati da una riga vuota o da un cambio di prefisso: e' la
 * forma in cui questi documenti sono scritti, ed e' l'unica che permette di
 * dire con certezza che nessuna riga e' rimasta fuori.
 */
export function renderMarkdown(sorgente: string): DocumentoReso {
  const righe = sorgente.replace(/\r\n/g, '\n').split('\n');

  let titolo = '';
  const intestazione: VoceIntestazione[] = [];
  const indice: VoceIndice[] = [];
  const preambolo: string[] = [];
  const sezioni: string[] = [];

  /** Il corpo della sezione aperta; finche' e' `null` si sta nel preambolo. */
  let aperta: { id: string; numero: string; titolo: string; corpo: string[] } | null = null;

  const scrivi = (html: string) => {
    if (aperta) aperta.corpo.push(html);
    else preambolo.push(html);
  };

  const chiudi = () => {
    if (!aperta) return;
    sezioni.push(
      `<section id="${aperta.id}">\n` +
        `<h2><span class="num">${numeroIndice(aperta.numero)}</span>${inline(aperta.titolo)}</h2>\n` +
        `${aperta.corpo.join('\n')}\n` +
        `</section>`,
    );
    aperta = null;
  };

  for (let i = 0; i < righe.length; i++) {
    const riga = righe[i];
    if (riga.trim() === '') continue;

    const titoloTrovato = TITOLO.exec(riga);
    if (titoloTrovato && !titolo) {
      titolo = titoloTrovato[1].trim();
      continue;
    }

    const sezioneTrovata = SEZIONE.exec(riga);
    if (sezioneTrovata) {
      chiudi();
      const testo = sezioneTrovata[2].trim();
      const voce = { id: ancora(testo), numero: sezioneTrovata[1], titolo: testo };
      indice.push(voce);
      aperta = { ...voce, corpo: [] };
      continue;
    }

    const sottoTrovata = SOTTOSEZIONE.exec(riga);
    if (sottoTrovata) {
      scrivi(`<h3>${inline(sottoTrovata[2].trim())}</h3>`);
      continue;
    }

    // L'intestazione: solo in cima, prima che una sezione si apra. Piu' in
    // basso `**Qualcosa:** ...` e' un paragrafo che comincia in grassetto, e
    // ce ne sono parecchi.
    const metaTrovata = !aperta && indice.length === 0 ? INTESTAZIONE.exec(riga) : null;
    if (metaTrovata) {
      intestazione.push({ etichetta: metaTrovata[1].trim(), valore: metaTrovata[2].trim() });
      continue;
    }

    if (CITAZIONE.test(riga)) {
      const dentro: string[] = [];
      while (i < righe.length && CITAZIONE.test(righe[i])) {
        dentro.push((CITAZIONE.exec(righe[i]) as RegExpExecArray)[1].trim());
        i++;
      }
      i--;
      scrivi(`<blockquote><p>${inline(dentro.join(' '))}</p></blockquote>`);
      continue;
    }

    if (ELENCO.test(riga)) {
      const voci: string[] = [];
      while (i < righe.length && ELENCO.test(righe[i])) {
        voci.push(`<li>${inline((ELENCO.exec(righe[i]) as RegExpExecArray)[1].trim())}</li>`);
        i++;
      }
      i--;
      scrivi(`<ul>\n${voci.join('\n')}\n</ul>`);
      continue;
    }

    if (TABELLA.test(riga)) {
      const blocco: string[] = [];
      while (i < righe.length && TABELLA.test(righe[i])) {
        blocco.push(righe[i]);
        i++;
      }
      i--;
      const corpo = blocco.filter((r) => !SEPARATORE_TABELLA.test(r));
      const [intestazioneTabella, ...dati] = corpo;
      const th = celle(intestazioneTabella).map((c) => `<th>${inline(c)}</th>`);
      const tr = dati.map(
        (r) => `<tr>${celle(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`,
      );
      scrivi(
        '<div class="table-wrap">\n<table>\n' +
          `<thead><tr>${th.join('')}</tr></thead>\n` +
          `<tbody>${tr.join('')}</tbody>\n` +
          '</table>\n</div>',
      );
      continue;
    }

    // Quel che resta e' un paragrafo: righe di seguito fino alla prossima riga
    // vuota o al prossimo blocco.
    const paragrafo: string[] = [];
    while (i < righe.length && righe[i].trim() !== '' && !iniziaUnBlocco(righe[i])) {
      paragrafo.push(righe[i].trim());
      i++;
    }
    i--;
    scrivi(`<p>${inline(paragrafo.join(' '))}</p>`);
  }

  chiudi();

  return {
    titolo,
    intestazione,
    indice,
    corpo: sezioni.join('\n\n'),
    preambolo: preambolo.join('\n'),
  };
}

/** Una riga che apre un blocco diverso dal paragrafo in corso. */
function iniziaUnBlocco(riga: string): boolean {
  return (
    TITOLO.test(riga) ||
    SEZIONE.test(riga) ||
    SOTTOSEZIONE.test(riga) ||
    CITAZIONE.test(riga) ||
    ELENCO.test(riga) ||
    TABELLA.test(riga)
  );
}
