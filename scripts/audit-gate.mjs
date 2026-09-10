// Il cancello di `npm audit` per la CI.
//
// `npm audit` da solo non serve come cancello: risponde sull'intero grafo, dove
// la meta' dei pacchetti esiste solo per costruire il progetto e non arriva mai
// in produzione. Usato cosi' e' rosso quasi sempre, e un controllo sempre rosso
// non ferma nessuno — si impara a passargli accanto. Questo script fa due
// domande separate, che e' l'unico modo per avere una risposta che significhi
// qualcosa:
//
//   1. C'e' una CRITICA da qualche parte, anche solo fra gli strumenti di
//      build? Una critica nella catena di build e' comunque codice che gira
//      sulla macchina che costruisce e firma l'artefatto.
//   2. C'e' una ALTA (o una critica) nel grafo che finisce DAVVERO in
//      produzione, cioe' `npm audit --omit=dev`?
//
// Tutto il resto — moderate, e le alte che restano confinate negli strumenti di
// sviluppo — viene stampato ma non blocca.
//
// Le eccezioni stanno in audit-exceptions.json, e ognuna ha una scadenza. Una
// scadenza passata fa fallire il controllo: senza quella regola la lista delle
// eccezioni diventa il posto dove i problemi smettono di essere guardati.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const qui = path.dirname(fileURLToPath(import.meta.url));
const radice = path.resolve(qui, "..");

// `npm audit` esce con codice diverso da zero quando trova qualcosa, che e'
// esattamente il caso normale qui: l'uscita va letta lo stesso, non trattata
// come un errore dello strumento.
function audit(soloProduzione) {
  const argomenti = ["audit", "--json"];
  if (soloProduzione) argomenti.push("--omit=dev");
  let grezzo;
  try {
    grezzo = execFileSync("npm", argomenti, {
      cwd: radice,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (errore) {
    grezzo = errore.stdout;
    // Nessun stdout vuol dire che npm non e' nemmeno partito: quello si' e' un
    // errore, e va propagato invece di passare per "nessuna vulnerabilita'".
    if (!grezzo) throw errore;
  }
  return JSON.parse(grezzo);
}

const eccezioni = JSON.parse(
  readFileSync(path.join(qui, "audit-exceptions.json"), "utf8"),
).eccezioni;

const oggi = new Date().toISOString().slice(0, 10);

const perPacchetto = new Map(eccezioni.map((e) => [e.pacchetto, e]));
const scadute = eccezioni.filter((e) => e.scadenza < oggi);
const usate = new Set();

const grafoCompleto = audit(false);
const grafoProduzione = audit(true);

const gravita = (v) => v.severity;
const elenca = (rapporto, filtro) =>
  Object.entries(rapporto.vulnerabilities ?? {})
    .filter(([, v]) => filtro(v))
    .map(([nome, v]) => ({ nome, gravita: gravita(v) }));

// Regola 1: critiche ovunque. Regola 2: alte e critiche in produzione.
const critiche = elenca(grafoCompleto, (v) => v.severity === "critical");
const alteProduzione = elenca(
  grafoProduzione,
  (v) => v.severity === "high" || v.severity === "critical",
);

const bloccanti = [];
const coperte = [];

for (const voce of [...critiche, ...alteProduzione]) {
  const eccezione = perPacchetto.get(voce.nome);
  if (eccezione && eccezione.scadenza >= oggi) {
    usate.add(voce.nome);
    coperte.push({ ...voce, scadenza: eccezione.scadenza });
  } else {
    bloccanti.push(voce);
  }
}

const riassunto = (r) => {
  const m = r.metadata.vulnerabilities;
  return `critiche ${m.critical}, alte ${m.high}, moderate ${m.moderate}, basse ${m.low}`;
};

console.log("Grafo completo   :", riassunto(grafoCompleto));
console.log("Grafo produzione :", riassunto(grafoProduzione));
console.log("");

if (coperte.length) {
  console.log("Coperte da un'eccezione ancora valida:");
  for (const c of new Map(coperte.map((c) => [c.nome, c])).values()) {
    console.log(`  - ${c.nome} (${c.gravita}) — scade il ${c.scadenza}`);
  }
  console.log("");
}

let esito = 0;

if (scadute.length) {
  console.error("Eccezioni SCADUTE — vanno rinnovate con un motivo aggiornato,");
  console.error("oppure la vulnerabilita' va finalmente corretta:");
  for (const e of scadute) {
    console.error(`  - ${e.pacchetto} — scaduta il ${e.scadenza}`);
  }
  console.error("");
  esito = 1;
}

if (bloccanti.length) {
  console.error("Vulnerabilita' che bloccano:");
  for (const b of new Map(bloccanti.map((b) => [b.nome, b])).values()) {
    console.error(`  - ${b.nome} (${b.gravita})`);
  }
  console.error("");
  console.error("Correggerle, oppure aggiungere un'eccezione motivata e con una");
  console.error("scadenza in scripts/audit-exceptions.json.");
  esito = 1;
}

// Un'eccezione che non copre piu' niente e' rumore: prima o poi qualcuno la
// legge e crede che il problema ci sia ancora. Non blocca, ma si fa notare.
const inutili = eccezioni.filter((e) => !usate.has(e.pacchetto) && e.scadenza >= oggi);
if (inutili.length) {
  console.log("Eccezioni che non servono piu' (la vulnerabilita' non c'e' piu'):");
  for (const e of inutili) console.log(`  - ${e.pacchetto} — si puo' togliere`);
  console.log("");
}

if (esito === 0) console.log("Cancello di sicurezza: passato.");
process.exit(esito);
