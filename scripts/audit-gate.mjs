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
// Ognuna nomina anche gli advisory esatti (ID GHSA) che accetta, la prova di
// mitigazione e un owner: un advisory nuovo che entra nella stessa catena non
// passa sotto un'eccezione scritta per un altro. Le regole stanno in
// audit-gate-regole.mjs, provate da audit-gate.test.ts.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validaEccezioni, valuta } from "./audit-gate-regole.mjs";

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

// Prima la forma del file: un'eccezione senza advisory, owner o prova di
// mitigazione non e' un rischio accettato da qualcuno, e' un buco nel cancello.
const erroriDiForma = validaEccezioni(eccezioni);
if (erroriDiForma.length) {
  console.error("scripts/audit-exceptions.json scritto male:");
  for (const e of erroriDiForma) console.error(`  - ${e}`);
  process.exit(1);
}

const grafoCompleto = audit(false);
const grafoProduzione = audit(true);

const { bloccanti, coperte, scadute, inutili, advisoryInEccesso } = valuta({
  grafoCompleto,
  grafoProduzione,
  eccezioni,
  oggi,
});

const riassunto = (r) => {
  const m = r.metadata.vulnerabilities;
  return `critiche ${m.critical}, alte ${m.high}, moderate ${m.moderate}, basse ${m.low}`;
};

console.log("Grafo completo   :", riassunto(grafoCompleto));
console.log("Grafo produzione :", riassunto(grafoProduzione));
console.log("");

if (coperte.length) {
  console.log("Coperte da un'eccezione ancora valida:");
  for (const c of coperte) {
    console.log(`  - ${c.nome} (${c.gravita}) — ${c.advisory.join(", ")} — scade il ${c.scadenza}`);
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
  for (const b of bloccanti) {
    console.error(`  - ${b.nome} (${b.gravita}) — ${b.motivo}`);
  }
  console.error("");
  console.error("Correggerle, oppure aggiungere (o aggiornare) un'eccezione in");
  console.error("scripts/audit-exceptions.json che nomini ogni advisory, con");
  console.error("mitigazione, owner e scadenza.");
  esito = 1;
}

// Un'eccezione che non copre piu' niente e' rumore: prima o poi qualcuno la
// legge e crede che il problema ci sia ancora. Non blocca, ma si fa notare.
if (inutili.length) {
  console.log("Eccezioni che non servono piu' (la vulnerabilita' non c'e' piu'):");
  for (const e of inutili) console.log(`  - ${e.pacchetto} — si puo' togliere`);
  console.log("");
}

if (advisoryInEccesso.length) {
  console.log("Advisory nominati che non raggiungono piu' il pacchetto:");
  for (const a of advisoryInEccesso) {
    console.log(`  - ${a.pacchetto}: ${a.advisory.join(", ")} — si possono togliere`);
  }
  console.log("");
}

if (esito === 0) console.log("Cancello di sicurezza: passato.");
process.exit(esito);
