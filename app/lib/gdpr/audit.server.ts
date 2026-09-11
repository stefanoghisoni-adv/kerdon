// app/lib/gdpr/audit.server.ts
//
// La traccia di una richiesta GDPR: cosa e' stato chiesto, cosa e' stato fatto
// tabella per tabella, com'e' finita.
//
// Serve a rispondere a una domanda che prima o poi arriva davvero — da un
// merchant, da un'autorita', o da chi rivede l'app — e che suona cosi': "il 14
// marzo e' arrivata una richiesta di cancellazione: dimostrate di averla
// eseguita". Un console.log che dice "redacted" non lo dimostra. L'elenco dei
// passi con le righe toccate, salvato, si'.
//
// DOVE VIENE SCRITTA. Nella tabella dei job di sincronizzazione, con un
// jobType che comincia per `gdpr_`. Con un'eccezione, ed e' quella che qui
// contava di piu': `shop/redact` riuscita non ha piu' nessun negozio a cui
// legare una riga, quindi la sua prova sta in `shop_erasure_proofs` — un
// registro senza chiavi esterne verso `shops`, che al negozio sopravvive. Non e' la sua casa ideale ed e' una scelta
// consapevole: e' l'unico registro per negozio che gia' esiste, e' gia' escluso
// dalle corse mostrate al merchant, e non richiede di aggiungere una tabella —
// che vorrebbe dire una migrazione da applicare a mano prima del rilascio, e
// una richiesta GDPR che fallisce per sempre se quella migrazione manca. Il
// dettaglio finisce nella colonna `errors` perche' e' l'unica libera; su un
// esito riuscito e' un uso improprio del nome, non del contenuto.
//
// COSA NON CI FINISCE. I dati della persona. Della richiesta si salvano il tipo,
// le tabelle, i conteggi e l'impronta di cui sotto — mai una email, un nome,
// una riga letta. Un registro di cancellazioni che conserva quello che ha
// cancellato e' il modo piu' elegante di non aver cancellato niente.

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '~/db.server';
import type { GdprStep } from './customer-record.server';
import { stepsFailed, failureMessage } from './customer-record.server';

/** I tre webhook obbligatori. I valori restano quelli storici. */
export type GdprJobType = 'gdpr_redact' | 'gdpr_data_request' | 'gdpr_shop_redact';

/**
 * La chiave con cui si firma l'impronta di un riferimento GDPR.
 *
 * Non e' `ENCRYPTION_SECRET` usato tale e quale: e' una chiave derivata da
 * quello con un'etichetta sua. Cosi' la firma di un riferimento non e' la
 * stessa cosa che cifrare un token — chi arrivasse a una non arriva all'altra —
 * ma non si aggiunge una variabile d'ambiente obbligatoria che, se un giorno
 * mancasse, spegnerebbe i webhook di conformita' in produzione.
 *
 * `GDPR_AUDIT_SECRET`, se c'e', vince: serve a poter ruotare questa chiave da
 * sola, senza toccare quella con cui sono cifrati i token dei negozi.
 */
//
// L'etichetta porta il nome di prima del cambio, e resta cosi'. Non e' una
// stringa da leggere: e' un ingrediente da cui si deriva la chiave, quindi
// cambiarla cambia la chiave. Tutto cio' che e' gia' stato cifrato o firmato
// con quella smetterebbe di potersi rileggere o verificare — e qui dentro
// finiscono le prove di una cancellazione e gli identificativi di chi ha
// revocato il consenso. Il nome del prodotto cambia, le chiavi no.
const AUDIT_KEY_LABEL = 'coreward:gdpr-audit-ref:v2';

function gdprAuditKey(): Buffer {
  const dedicated = process.env.GDPR_AUDIT_SECRET;
  if (dedicated) return Buffer.from(dedicated, 'utf8');

  const base = process.env.ENCRYPTION_SECRET;
  if (!base) {
    throw new Error(
      'ne GDPR_AUDIT_SECRET ne ENCRYPTION_SECRET sono configurati: impossibile firmare i riferimenti di controllo',
    );
  }
  return createHmac('sha256', base).update(AUDIT_KEY_LABEL).digest();
}

/**
 * L'impronta con cui una richiesta resta riconoscibile dopo la cancellazione.
 *
 * Il paradosso della traccia di controllo e' che per dimostrare di aver
 * cancellato l'id 4021 bisognerebbe conservare il 4021. L'impronta lo risolve:
 * e' un'immagine a senso unico del negozio piu' l'id, quindi chi apre la
 * tabella non ci legge nessun identificatore, ma chi arriva con una domanda
 * precisa — "il cliente 4021 e' stato cancellato?" — puo' ricalcolarla e
 * trovare la riga. Verificabile senza essere leggibile.
 *
 * Il dominio del negozio ci sta dentro apposta: senza, la stessa impronta
 * varrebbe per lo stesso id in negozi diversi.
 *
 * VERSIONE 2 (corrente): HMAC-SHA256 con segreto dedicato, in base64url.
 * Prefisso `v2:` per distinguerla dalle impronte precedenti, che erano hash
 * semplici e quindi ricalcolabili da chiunque conosca il dominio e provi gli
 * id plausibili. Chi verifica deve accettare entrambe le forme per un periodo
 * limitato — le tracce vecchie non possono essere riscritte — ma chi scrive
 * usa solo la nuova.
 */
export function createCustomerRef(shopDomain: string, customerId: string | number): string {
  const payload = `${shopDomain}:${customerId}`;
  const hmac = createHmac('sha256', gdprAuditKey()).update(payload).digest('base64url');
  return `v2:${hmac}`;
}

/**
 * Verifica che un riferimento corrisponda alla persona indicata.
 *
 * Accetta sia la v2 (HMAC firmato, corrente) sia la v1 (hash semplice, per le
 * tracce scritte prima dell'aggiornamento). La v1 resta verificabile, ma non
 * piu' generabile: il registro vecchio non puo' essere riscritto, e un
 * riferimento illeggibile renderebbe inutile una traccia ancora valida.
 *
 * FINE DELLA TRANSIZIONE: quando tutte le tracce v1 saranno oltre il termine
 * di conservazione — cioe' quando nessuna riga `gdpr_*` nel database portera'
 * piu' un riferimento senza prefisso — la verifica v1 puo' essere rimossa.
 * Non prima: una traccia ancora dentro il termine deve restare verificabile.
 */
export function verifyCustomerRef(
  ref: string,
  shopDomain: string,
  customerId: string | number,
): boolean {
  const expected = ref.startsWith('v2:')
    ? createCustomerRef(shopDomain, customerId)
    : // v1: hash semplice senza firma (accettato finche' dura la transizione)
      createHash('sha256').update(`${shopDomain}:${customerId}`).digest('hex');

  // `timingSafeEqual` pretende due buffer della stessa lunghezza e altrimenti
  // solleva: un riferimento di lunghezza diversa e' semplicemente un
  // riferimento diverso, non un errore da propagare.
  const given = Buffer.from(ref);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length) return false;
  return timingSafeEqual(given, wanted);
}

/**
 * Alias per compatibilita': chi chiama `customerRef` si aspetta di creare un
 * riferimento nuovo, quindi riceve la v2 corrente.
 */
export const customerRef = createCustomerRef;

export interface GdprOutcome {
  jobType: GdprJobType;
  shopDomain: string;
  /** Assente per shop/redact: li' non c'e' nessuna persona, c'e' un negozio. */
  ref?: string;
  steps: GdprStep[];
}

/**
 * Scrive la traccia. Un passo fallito basta a marcare l'intera richiesta come
 * fallita: e' lo stesso criterio con cui il webhook decide se rispondere 200 o
 * far ritentare Shopify, e le due cose devono dire la stessa cosa — una riga
 * "completed" accanto a una risposta 500 renderebbe il registro inservibile.
 *
 * SOLLEVA SE NON RIESCE A SCRIVERE, e prima non lo faceva: l'errore finiva in
 * un `console.error` e la richiesta proseguiva fino a dichiararsi completata.
 * Quel `catch` diceva, testualmente, "resta il log applicativo, che e'
 * esattamente il motivo per cui i due canali esistono entrambi" — ma i due
 * canali non sono equivalenti. Uno e' una riga in un registro che si conserva,
 * l'altro e' testo in un log a ritenzione breve che nessuno indicizza. Una
 * richiesta di cancellazione dichiarata eseguita la cui unica prova e' una riga
 * di `console` e' una richiesta che, davanti a chi la chiede, non risulta
 * eseguita affatto. Chi non riesce a scrivere la prova non chiude la pratica:
 * ritenta.
 */
export async function recordGdprOutcome(
  shopId: string,
  outcome: GdprOutcome,
): Promise<void> {
  const failed = stepsFailed(outcome.steps);

  await prisma.syncJob.create({
    data: {
      shopId,
      jobType: outcome.jobType,
      status: failed ? 'failed' : 'completed',
      completedAt: new Date(),
      productsSynced: 0,
      variantsSynced: 0,
      errors: {
        // `message` e' il campo che il log del merchant sa gia' leggere:
        // esiste solo quando c'e' davvero qualcosa da dire.
        ...(failed ? { message: failureMessage(outcome.steps) } : {}),
        gdpr: {
          request: outcome.jobType,
          ...(outcome.ref ? { customer_ref: outcome.ref } : {}),
          steps: outcome.steps.map((step) => ({
            table: step.table,
            outcome: step.outcome,
            rows: step.rows,
            ...(step.detail ? { detail: step.detail } : {}),
          })),
        },
      },
    },
  });
}

/**
 * La traccia scritta "se si puo'", per il solo percorso d'errore.
 *
 * Esiste per un caso e uno solo: si sta gia' registrando un fallimento, e
 * sollevare qui coprirebbe l'errore vero con un secondo errore che non aggiunge
 * niente. Ovunque altro si usa `recordGdprOutcome`, che solleva — perche' li'
 * la traccia mancante e' la differenza fra una pratica chiusa e una da
 * ritentare.
 */
export async function tryRecordGdprOutcome(
  shopId: string,
  outcome: GdprOutcome,
): Promise<void> {
  try {
    await recordGdprOutcome(shopId, outcome);
  } catch (error) {
    console.error(
      `[gdpr] traccia non salvata per ${outcome.shopDomain}:`,
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
  }
}

/**
 * La stessa traccia nel log applicativo, in una riga sola e sempre con la
 * stessa forma, cosi' da poterla ritrovare cercando `[gdpr]`.
 *
 * Non e' un doppione per abbondanza: e' il canale che si legge mentre una cosa
 * succede, mentre la riga e' quello che si legge dopo, anche molto dopo.
 *
 * PER shop/redact NON E' PIU' L'UNICA TRACCIA, ed e' bene ricordarsi perche' lo
 * era: quella richiesta cancella il negozio, e con lui — in cascata — ogni riga
 * di controllo che al negozio fosse legata. Il rimedio di allora fu affidarsi a
 * questo `console`, che pero' non e' una prova: e' testo in un log a ritenzione
 * breve. Adesso la prova sta in `shop_erasure_proofs`, che al negozio
 * sopravvive perche' non ha nessun legame con lui, e questa riga torna a essere
 * quello che deve essere — un di piu', mai un sostituto.
 */
export function logGdprOutcome(outcome: GdprOutcome): void {
  const failed = stepsFailed(outcome.steps);
  const line = JSON.stringify({
    request: outcome.jobType,
    shop: outcome.shopDomain,
    ...(outcome.ref ? { customer_ref: outcome.ref } : {}),
    status: failed ? 'failed' : 'completed',
    steps: outcome.steps,
    at: new Date().toISOString(),
  });

  if (failed) console.error(`[gdpr] ${line}`);
  else console.log(`[gdpr] ${line}`);
}

/**
 * Le due tracce insieme: e' sempre cosi' che si chiudono i tre handler.
 *
 * SOLLEVA se la traccia durevole non si scrive. Il `console` resta, e resta
 * utile — ma e' un di piu', mai un sostituto: chi chiama non deve poter
 * dichiarare eseguita una richiesta di cui non e' rimasta nessuna prova
 * conservata.
 *
 * Con `shopId` a null non c'e' nessuna riga da scrivere qui, e non e' una
 * scappatoia: e' il caso di `shop/redact` riuscita, dove il negozio non esiste
 * piu' e la prova sta nel suo registro — `shop_erasure_proofs`, che al negozio
 * sopravvive perche' non ha nessun legame con lui.
 */
export async function saveGdprOutcome(
  shopId: string | null,
  outcome: GdprOutcome,
): Promise<void> {
  logGdprOutcome(outcome);
  if (shopId) await recordGdprOutcome(shopId, outcome);
}

/** Come sopra, ma senza sollevare. Solo per il percorso d'errore. */
export async function trySaveGdprOutcome(
  shopId: string | null,
  outcome: GdprOutcome,
): Promise<void> {
  logGdprOutcome(outcome);
  if (shopId) await tryRecordGdprOutcome(shopId, outcome);
}
