// Le regole del cancello di `npm audit`, separate dal comando che le esegue.
//
// Stanno qui, senza rete e senza processi figli, perche' sono la parte che
// decide: chi blocca, chi e' coperto, quale eccezione e' scritta male. Il
// comando (audit-gate.mjs) chiama npm, stampa e esce; queste funzioni si
// provano con rapporti finti in audit-gate.test.ts.
//
// Il punto delle regole nuove: un'eccezione copre un PACCHETTO, ma il rischio
// che si accetta e' un ADVISORY. Se nella stessa catena entra un advisory nuovo,
// un'eccezione che nominasse solo il pacchetto lo farebbe passare in silenzio,
// con la motivazione scritta per quello vecchio. Per questo ogni eccezione deve
// elencare gli advisory esatti che accetta, e un advisory che raggiunge il
// pacchetto senza essere nominato blocca come una vulnerabilita' senza eccezione.

/**
 * @typedef {{
 *   pacchetto: string,
 *   advisory: string[],
 *   motivo: string,
 *   mitigazione: string,
 *   owner: string,
 *   scadenza: string,
 *   avviso?: string,
 * }} Eccezione
 */

const FORMATO_GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}$/;

const testoPieno = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * Gli errori di forma nel file delle eccezioni. Un elenco vuoto vuol dire che
 * il file e' scritto bene; qualunque voce fa fallire il cancello, perche'
 * un'eccezione incompleta e' un'accettazione del rischio che nessuno ha
 * davvero firmato.
 */
export function validaEccezioni(eccezioni) {
  const errori = [];
  if (!Array.isArray(eccezioni)) return ["'eccezioni' deve essere un elenco"];

  const visti = new Set();
  eccezioni.forEach((e, i) => {
    const chi = testoPieno(e?.pacchetto) ? e.pacchetto : `voce ${i + 1}`;
    if (!testoPieno(e?.pacchetto)) errori.push(`${chi}: manca 'pacchetto'`);
    else if (visti.has(e.pacchetto)) errori.push(`${chi}: pacchetto ripetuto`);
    else visti.add(e.pacchetto);

    if (!Array.isArray(e?.advisory) || e.advisory.length === 0) {
      errori.push(`${chi}: 'advisory' deve elencare almeno un ID GHSA`);
    } else {
      for (const id of e.advisory) {
        if (typeof id !== "string" || !FORMATO_GHSA.test(id)) {
          errori.push(`${chi}: advisory non valido ${JSON.stringify(id)} (serve l'ID GHSA completo)`);
        }
      }
    }
    if (!testoPieno(e?.motivo)) errori.push(`${chi}: manca 'motivo'`);
    if (!testoPieno(e?.mitigazione)) errori.push(`${chi}: manca 'mitigazione'`);
    if (!testoPieno(e?.owner)) errori.push(`${chi}: manca 'owner'`);
    if (typeof e?.scadenza !== "string" || !FORMATO_DATA.test(e.scadenza)) {
      errori.push(`${chi}: 'scadenza' deve essere una data AAAA-MM-GG`);
    } else {
      // Controlla che la data sia valida (non 2026-13-45): il costruttore
      // restituisce Invalid Date o una data diversa se i valori sono impossibili.
      const parsed = new Date(e.scadenza + 'T00:00:00Z');
      if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== e.scadenza) {
        errori.push(`${chi}: 'scadenza' ${e.scadenza} non e' una data valida`);
      }
    }
  });
  return errori;
}

/**
 * Gli advisory che raggiungono un pacchetto, risalendo la catena `via` di
 * `npm audit --json` fino alle voci che portano un advisory vero (gli oggetti
 * con `url`). Un pacchetto come @remix-run/node non ha advisory suoi: e'
 * vulnerabile perche' contiene turbo-stream, e l'ID da nominare e' quello di
 * turbo-stream.
 */
export function advisoryDi(rapporto, nome, visitati = new Set()) {
  const trovati = new Set();
  if (visitati.has(nome)) return trovati;
  visitati.add(nome);

  const voce = rapporto.vulnerabilities?.[nome];
  for (const via of voce?.via ?? []) {
    if (typeof via === "string") {
      for (const id of advisoryDi(rapporto, via, visitati)) trovati.add(id);
    } else if (via && typeof via.url === "string") {
      const id = via.url.split("/").pop();
      if (id) trovati.add(id);
    }
  }
  return trovati;
}

const elenca = (rapporto, filtro) =>
  Object.entries(rapporto.vulnerabilities ?? {})
    .filter(([, v]) => filtro(v))
    .map(([nome, v]) => ({ nome, gravita: v.severity, rapporto }));

/**
 * La decisione del cancello.
 *
 * Regola 1: critiche ovunque. Regola 2: alte e critiche in produzione. Una
 * voce e' coperta solo se esiste un'eccezione non scaduta per il pacchetto E
 * l'eccezione nomina ogni advisory che lo raggiunge.
 */
/**
 * @param {{ grafoCompleto: any, grafoProduzione: any, eccezioni: Eccezione[], oggi: string }} ingresso
 */
export function valuta({ grafoCompleto, grafoProduzione, eccezioni, oggi }) {
  const perPacchetto = new Map(eccezioni.map((e) => [e.pacchetto, e]));
  const scadute = eccezioni.filter((e) => e.scadenza < oggi);

  const critiche = elenca(grafoCompleto, (v) => v.severity === "critical");
  const alteProduzione = elenca(
    grafoProduzione,
    (v) => v.severity === "high" || v.severity === "critical",
  );

  const bloccanti = new Map();
  const coperte = new Map();
  const advisoryVisti = new Map(); // pacchetto -> advisory reali che lo raggiungono

  for (const voce of [...critiche, ...alteProduzione]) {
    const reali = [...advisoryDi(voce.rapporto, voce.nome)].sort();
    const gia = advisoryVisti.get(voce.nome) ?? new Set();
    for (const id of reali) gia.add(id);
    advisoryVisti.set(voce.nome, gia);

    const eccezione = perPacchetto.get(voce.nome);
    if (!eccezione || eccezione.scadenza < oggi) {
      bloccanti.set(voce.nome, { nome: voce.nome, gravita: voce.gravita, motivo: eccezione ? "eccezione scaduta" : "nessuna eccezione" });
      continue;
    }
    const nominati = new Set(eccezione.advisory ?? []);
    const mancanti = reali.filter((id) => !nominati.has(id));
    if (mancanti.length) {
      bloccanti.set(voce.nome, {
        nome: voce.nome,
        gravita: voce.gravita,
        motivo: `advisory non nominati nell'eccezione: ${mancanti.join(", ")}`,
      });
      continue;
    }
    if (!bloccanti.has(voce.nome)) {
      coperte.set(voce.nome, { nome: voce.nome, gravita: voce.gravita, scadenza: eccezione.scadenza, advisory: reali });
    }
  }
  // Se lo stesso pacchetto e' bloccato da una delle due regole, non e' coperto.
  for (const nome of bloccanti.keys()) coperte.delete(nome);

  // "Inutile" vuol dire che il pacchetto non e' piu' fra le vulnerabilita' che
  // contano, non che l'eccezione e' incompleta: quella blocca gia' sopra.
  const inutili = eccezioni.filter((e) => !advisoryVisti.has(e.pacchetto) && e.scadenza >= oggi);

  // Advisory nominati che non raggiungono piu' il pacchetto: non bloccano, ma
  // un'eccezione che accetta un rischio che non c'e' piu' va ripulita.
  const advisoryInEccesso = [];
  for (const e of eccezioni) {
    const reali = advisoryVisti.get(e.pacchetto);
    if (!reali) continue;
    const extra = (e.advisory ?? []).filter((id) => !reali.has(id));
    if (extra.length) advisoryInEccesso.push({ pacchetto: e.pacchetto, advisory: extra });
  }

  return {
    bloccanti: [...bloccanti.values()],
    coperte: [...coperte.values()],
    scadute,
    inutili,
    advisoryInEccesso,
  };
}
