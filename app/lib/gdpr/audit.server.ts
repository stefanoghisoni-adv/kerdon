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
// jobType che comincia per `gdpr_`. Non e' la sua casa ideale ed e' una scelta
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

import { createHash } from 'crypto';
import { prisma } from '~/db.server';
import type { GdprStep } from './customer-record.server';
import { stepsFailed, failureMessage } from './customer-record.server';

/** I tre webhook obbligatori. I valori restano quelli storici. */
export type GdprJobType = 'gdpr_redact' | 'gdpr_data_request' | 'gdpr_shop_redact';

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
 */
export function customerRef(shopDomain: string, customerId: string | number): string {
  return createHash('sha256').update(`${shopDomain}:${customerId}`).digest('hex');
}

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
 */
export async function recordGdprOutcome(
  shopId: string,
  outcome: GdprOutcome,
): Promise<void> {
  const failed = stepsFailed(outcome.steps);

  try {
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
  } catch (error) {
    // Se nemmeno la traccia si riesce a scrivere resta il log applicativo, che
    // e' esattamente il motivo per cui i due canali esistono entrambi.
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
 * Non e' un doppione per abbondanza. Per shop/redact e' l'unica traccia
 * possibile: quella richiesta cancella il negozio, e con lui — in cascata —
 * qualunque riga di controllo che al negozio fosse legata. Una prova che si
 * autodistrugge insieme a cio' che deve provare non e' una prova.
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

/** Le due tracce insieme: e' sempre cosi' che si chiudono i tre handler. */
export async function saveGdprOutcome(
  shopId: string | null,
  outcome: GdprOutcome,
): Promise<void> {
  logGdprOutcome(outcome);
  if (shopId) await recordGdprOutcome(shopId, outcome);
}
