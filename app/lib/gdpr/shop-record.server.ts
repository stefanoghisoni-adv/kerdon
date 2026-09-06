// app/lib/gdpr/shop-record.server.ts
//
// Cosa teniamo di un negozio, e come si toglie tutto quando il negozio chiede
// di essere dimenticato (shop/redact, quarantotto ore dopo la disinstallazione).
//
// L'inventario, perche' senza inventario si cancella quello che ci si ricorda:
//
//   shops                      la riga del negozio, e a cascata tutto quello
//                              che le pende: gli addebiti, il registro delle
//                              sincronizzazioni e il loro dettaglio, i campi
//                              personalizzati e le mappature, gli snapshot di
//                              idoneita', i feed di catalogo con i loro token
//   supabase_configs           il collegamento al progetto del merchant, con la
//                              service role key cifrata. Cadrebbe in cascata,
//                              ma si cancella per nome e per prima: e' la
//                              nostra chiave d'accesso al database di un altro,
//                              e vogliamo contarla e vederla scritta nella
//                              prova, non fidarci che il vincolo se la porti via
//   supabase_oauth_tokens      il token con cui parliamo all'API di gestione di
//                              Supabase per conto suo. Stesso ragionamento
//   sessions                   NON e' in cascata: la sessione si lega al
//                              dominio, non alla riga del negozio. Dentro ci
//                              sono l'access token e nome, cognome e email di
//                              chi ha installato l'app — dati personali di una
//                              persona vera, quindi la parte che meno di tutte
//                              puo' restare indietro
//   customer_data_access_logs  la relazione e' ON DELETE SET NULL: cancellando
//                              il negozio queste righe sopravvivono con lo
//                              shop_id azzerato. Nate per non perdere i
//                              tentativi con token sconosciuti, che negozio non
//                              ne hanno — ma qui il negozio c'e', e va tolto
//                              prima, altrimenti resta un mucchietto di righe
//                              orfane che nessuno sapra' piu' a chi appartenevano
//
// COSA E' CAMBIATO, E PERCHE'. Le tre cancellazioni stavano in tre `try`
// separati, con un commento che lo motivava cosi': "se uno cade, gli altri
// devono comunque provarci — meglio nove tabelle su dieci di zero". Il
// ragionamento e' sbagliato nel modo piu' costoso possibile, perche' l'ordine
// era: prima i log, poi le sessioni, il negozio per ultimo. Se i log fallivano
// e il negozio riusciva, quelle righe restavano con lo `shop_id` azzerato dal
// vincolo — e il ritentativo, che riparte dal dominio, non trovava piu' nessun
// negozio da cui ricavare l'id. Non erano nove tabelle su dieci: erano righe
// che nessuno avrebbe piu' potuto togliere, per sempre. Adesso e' una
// transazione sola: o si cancella tutto, o non si cancella niente e l'id resta
// li' dov'era.
//
// E PRIMA DELLA TRANSAZIONE, DUE COSE. Il lucchetto del negozio, fail-closed:
// occupato o irraggiungibile vuol dire che la richiesta resta ritentabile, mai
// che si cominci lo stesso. E la marcatura del ciclo di vita, che chiude il
// negozio alle scritture con una transazione sua — vedi `erasure-guard.server`
// per il perche' vada commessa a parte.
//
// COSA NON TOCCHIAMO, e non e' una scorciatoia: il progetto Supabase del
// merchant. Quelle tabelle stanno nel suo database, sotto il suo account, con
// la sua carta di credito: di quei dati il titolare e' lui, noi eravamo solo il
// mezzo con cui ci arrivavano. Andarci a cancellare le vendite di un anno
// perche' l'app e' stata disinstallata sarebbe, alla lettera, distruggere dati
// altrui senza mandato. Quello che si toglie e' la nostra chiave d'accesso —
// che sparisce con `supabase_configs` e con la cache che la teneva in memoria —
// cosi' che da questo momento noi in quel database non possiamo piu' entrare.

import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { runWithShopLease } from '~/lib/queue/shop-lock.server';
import type { GdprStep } from './steps';
import { beginShopErasure, forgetShopEverywhere } from './erasure-guard.server';
import {
  ERASURE_PROCEDURE_VERSION,
  ZERO_COUNTS,
  shopErasureRef,
  type ErasureCounts,
} from './erasure-proof.server';

/**
 * Com'e' finita.
 *
 * Cinque esiti e non due, perche' a chi chiama servono risposte diverse. I due
 * del lucchetto dicono "non si e' fatto niente, riprova" e sono la cosa piu'
 * importante del tipo: senza distinguerli, un negozio occupato si scriverebbe
 * nella traccia come una cancellazione fallita, che e' un'altra faccenda.
 */
export type ShopErasureOutcome =
  /** Cancellato adesso, prova scritta. */
  | 'erased'
  /** La prova per questa consegna c'era gia': seconda consegna, niente da fare. */
  | 'already_erased'
  /** Negozio occupato da un altro lavoro: nessuna cancellazione, si riprova. */
  | 'busy'
  /** Lucchetto irraggiungibile: nessuna cancellazione, si riprova. */
  | 'lock_unavailable'
  /** Qualcosa e' andato storto: la transazione e' annullata, l'id e' ancora li'. */
  | 'failed';

export interface ShopErasure {
  outcome: ShopErasureOutcome;
  /**
   * L'id che il negozio aveva, o null se il negozio non c'era gia'.
   *
   * Su un fallimento e' valorizzato, ed e' il punto: la transazione annullata
   * lascia la riga `shops` dov'era, quindi il ritentativo ritrova l'id da cui
   * ripartire. Era proprio questo a mancare.
   */
  shopId: string | null;
  steps: GdprStep[];
  /** L'id della prova, quando e' stata scritta. */
  proofId?: string;
}

export interface ShopErasureRequest {
  shopDomain: string;
  /** L'id della consegna Shopify: e' la chiave su cui la prova e' idempotente. */
  webhookId: string;
  topic: string;
  now?: Date;
}

/**
 * Cancella tutto quello che il negozio ci ha lasciato.
 *
 * Non solleva: ogni modo di andare male diventa un esito piu' dei passi che lo
 * spiegano, perche' chi chiama — il processore delle richieste di conformita' —
 * deve poter decidere se ritentare guardando un valore, non intercettando
 * un'eccezione.
 */
export async function eraseShopRecord(richiesta: ShopErasureRequest): Promise<ShopErasure> {
  const now = richiesta.now ?? new Date();
  const { shopDomain, webhookId, topic } = richiesta;

  // La prova viene guardata PRIMA di tutto il resto, e questo e' l'unico modo
  // in cui la seconda consegna della stessa richiesta e' davvero idempotente:
  // il negozio non c'e' piu', quindi non c'e' niente in cui riconoscersi se non
  // la prova. Senza questa lettura la seconda consegna ripartirebbe da zero,
  // scriverebbe una seconda prova e — nel caso peggiore, con una riga `shops`
  // ricreata nel frattempo da una reinstallazione — cancellerebbe un negozio
  // vivo per conto di una richiesta gia' eseguita.
  const gia = await prisma.shopErasureProof.findUnique({
    where: { webhookId },
    select: { id: true },
  });
  if (gia) {
    return {
      outcome: 'already_erased',
      shopId: null,
      proofId: gia.id,
      steps: [
        {
          table: 'shop_erasure_proofs',
          outcome: 'skipped',
          rows: 0,
          detail: 'prova gia presente per questa consegna: richiesta gia eseguita',
        },
      ],
    };
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  // Un negozio che non abbiamo mai avuto — o che una consegna precedente ha
  // gia' tolto — non ha niente da cancellare, ma la richiesta e' arrivata lo
  // stesso e va dimostrata: la prova si scrive comunque, con i conteggi a zero.
  // Una richiesta senza prova non si puo' dichiarare eseguita, e questa lo e'.
  if (!shop) {
    return scriviProvaSenzaNegozio(shopDomain, webhookId, topic, now);
  }

  let esito: ShopErasure = {
    outcome: 'failed',
    shopId: shop.id,
    steps: [],
  };

  const lucchetto = await runWithShopLease(
    shop.id,
    async (lease) => {
      // Il possesso si verifica un istante prima di cominciare: se il lease e'
      // scaduto mentre leggevamo, un'altra corsa sta gia' lavorando questo
      // negozio e la nostra cancellazione le passerebbe sotto i piedi.
      await lease.assertHeld();

      // La marcatura, con la sua transazione. Da qui in poi la policy nega ogni
      // capacita' a questo negozio, e il gettone alzato ferma chi era gia'
      // partito un istante prima di scrivere. Fuori dalla transazione grande
      // perche' deve essere visibile MENTRE si cancella, e perche' se quella
      // fallisce questa deve restare.
      const generazione = await beginShopErasure(shop.id, shopDomain);

      esito = await cancellaInTransazione({
        shopId: shop.id,
        shopDomain,
        webhookId,
        topic,
        generazione,
        now,
      });
    },
    // La cancellazione e' l'unico lavoro che ha il diritto di alzare il
    // gettone, quindi e' anche l'unico a cui il lucchetto non deve rinfacciarlo:
    // senza questa opzione la verifica del possesso, un istante dopo la
    // marcatura, si accorgerebbe della cancellazione — la propria — e si
    // fermerebbe da sola.
    { duringErasure: true },
  );

  if (lucchetto === 'occupato' || lucchetto === 'non-disponibile') {
    // FAIL-CLOSED, ed e' la ragione per cui il lucchetto sta qui. Non si e'
    // cancellato niente e non si e' marcato niente: la richiesta resta
    // ritentabile esattamente com'era. La cosa da non fare mai e' proseguire
    // senza lucchetto "solo per stavolta", perche' il lavoro che viene dopo
    // cancella righe che non si possono riscrivere.
    return {
      outcome: lucchetto === 'occupato' ? 'busy' : 'lock_unavailable',
      shopId: shop.id,
      steps: [
        {
          table: 'richiesta',
          outcome: 'failed',
          rows: 0,
          detail:
            lucchetto === 'occupato'
              ? 'negozio occupato da un altro lavoro: si riprova'
              : 'lucchetto del negozio non disponibile: si riprova',
        },
      ],
    };
  }

  return esito;
}

interface DatiCancellazione {
  shopId: string;
  shopDomain: string;
  webhookId: string;
  topic: string;
  generazione: number;
  now: Date;
}

/**
 * La transazione: tutto quanto, o niente.
 *
 * L'ordine dentro conta ancora, ma per un motivo diverso da prima: adesso non
 * serve a limitare i danni di un fallimento — non ce ne sono piu', il
 * fallimento annulla tutto — ma a non far scattare i vincoli. Le righe che il
 * vincolo lascerebbe orfane vanno prima, le credenziali subito dopo, la prova
 * penultima e `shops` per ultima, che e' la cascata e chiude il resto.
 *
 * LA PROVA E' DENTRO, e non e' un dettaglio di comodo: fuori e prima
 * dichiarerebbe cancellato un negozio che una `shops` fallita lascerebbe li';
 * fuori e dopo, un guasto fra le due lascerebbe una cancellazione senza prova —
 * cioe' esattamente la cosa da dimostrare, non dimostrabile. Dentro, le due
 * affermazioni "il negozio non c'e' piu'" e "ecco la prova che l'abbiamo tolto"
 * diventano vere nello stesso istante o nessuna delle due.
 */
async function cancellaInTransazione(dati: DatiCancellazione): Promise<ShopErasure> {
  const { shopId, shopDomain, webhookId, topic, generazione, now } = dati;
  const counts: ErasureCounts = { ...ZERO_COUNTS };

  try {
    const proofId = await prisma.$transaction(async (tx) => {
      // I log di accesso per primi: la loro relazione e' SET NULL, quindi
      // cancellare `shops` prima li lascerebbe orfani con lo shop_id azzerato —
      // il guasto da cui e' partito tutto.
      counts.customer_data_access_logs = (
        await tx.customerDataAccessLog.deleteMany({ where: { shopId } })
      ).count;

      // Le credenziali, per nome e non lasciandole alla cascata. Non e'
      // ridondanza: sono la nostra chiave d'accesso al database di un altro e il
      // token con cui parliamo a Supabase per conto suo, e vanno contate una per
      // una perche' e' su questi due numeri che si legge, nella prova, che da
      // adesso in quel progetto non possiamo piu' entrare.
      counts.supabase_configs = (
        await tx.supabaseConfig.deleteMany({ where: { shopId } })
      ).count;
      counts.supabase_oauth_tokens = (
        await tx.supabaseOAuthToken.deleteMany({ where: { shopId } })
      ).count;

      // Le sessioni si legano al dominio, non alla riga: nessuna cascata le
      // porterebbe via, e dentro ci sono l'access token e i dati di chi ha
      // installato l'app.
      counts.sessions = (await tx.session.deleteMany({ where: { shop: shopDomain } })).count;

      const prova = await tx.shopErasureProof.create({
        data: {
          webhookId,
          topic,
          shopRef: shopErasureRef(shopDomain),
          procedureVersion: ERASURE_PROCEDURE_VERSION,
          outcome: 'completed',
          erasureGeneration: generazione,
          erasedAt: now,
          // I conteggi si leggono qui dentro, mentre la transazione e' aperta:
          // `shops` non e' ancora stata cancellata, quindi il suo numero si
          // scrive a mano. E' l'unica riga della prova che non conta un
          // `deleteMany` gia' avvenuto, ed e' vera solo perche' la `delete` qui
          // sotto sta nella stessa transazione: se fallisse, non resterebbe
          // nemmeno questa prova a dire il contrario.
          counts: { ...counts, shops: 1 } as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      // `deleteMany` e non `delete`: un negozio gia' cancellato — perche' la
      // richiesta e' arrivata due volte, o perche' non l'abbiamo mai avuto —
      // deve dare zero righe, non un'eccezione che annullerebbe la transazione
      // di una cancellazione in realta' completa.
      counts.shops = (await tx.shop.deleteMany({ where: { id: shopId } })).count;

      return prova.id;
    });

    // La seconda pulizia delle cache: la prima l'ha fatta la marcatura, e serviva
    // a chiudere la porta; questa toglie chi fosse rientrato in cache nel
    // frattempo, quando la chiave di servizio esisteva ancora.
    forgetShopEverywhere(shopId, shopDomain);

    return {
      outcome: 'erased',
      shopId: null,
      proofId,
      steps: passiDiSuccesso(counts),
    };
  } catch (error) {
    // Transazione annullata: non e' stato cancellato niente, la riga `shops` e'
    // ancora dov'era e con lei l'id da cui il ritentativo ripartira'. Il negozio
    // resta marcato 'erasing', ed e' voluto — vedi `erasure-guard.server`.
    const dettaglio = error instanceof Error ? error.message : 'errore sconosciuto';
    return {
      outcome: 'failed',
      shopId,
      steps: [
        {
          table: 'cancellazione del negozio',
          outcome: 'failed',
          rows: 0,
          detail: `transazione annullata, nessuna riga cancellata: ${dettaglio}`,
        },
      ],
    };
  }
}

/**
 * La prova quando non c'era nessun negozio da cancellare.
 *
 * Fuori transazione perche' e' una scrittura sola: non c'e' niente con cui
 * doverla tenere insieme. Se non riesce, la richiesta non si dichiara eseguita
 * — che e' la regola di questo file, e vale anche qui dove non c'era niente da
 * fare: "non avevamo nulla di questo negozio" e' una risposta, e una risposta
 * va dimostrata come le altre.
 */
async function scriviProvaSenzaNegozio(
  shopDomain: string,
  webhookId: string,
  topic: string,
  now: Date,
): Promise<ShopErasure> {
  try {
    const prova = await prisma.shopErasureProof.create({
      data: {
        webhookId,
        topic,
        shopRef: shopErasureRef(shopDomain),
        procedureVersion: ERASURE_PROCEDURE_VERSION,
        outcome: 'skipped',
        erasureGeneration: null,
        erasedAt: now,
        counts: { ...ZERO_COUNTS } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    return {
      outcome: 'erased',
      shopId: null,
      proofId: prova.id,
      steps: [
        {
          table: 'shops',
          outcome: 'skipped',
          rows: 0,
          detail: 'negozio non presente: niente da cancellare',
        },
        progettoDelMerchant(),
      ],
    };
  } catch (error) {
    return {
      outcome: 'failed',
      shopId: null,
      steps: [
        {
          table: 'shop_erasure_proofs',
          outcome: 'failed',
          rows: 0,
          detail: error instanceof Error ? error.message : 'errore sconosciuto',
        },
      ],
    };
  }
}

function passiDiSuccesso(counts: ErasureCounts): GdprStep[] {
  return [
    { table: 'customer_data_access_logs', outcome: 'deleted', rows: counts.customer_data_access_logs },
    {
      table: 'supabase_configs',
      outcome: 'deleted',
      rows: counts.supabase_configs,
      detail: 'chiave di servizio del merchant revocata',
    },
    { table: 'supabase_oauth_tokens', outcome: 'deleted', rows: counts.supabase_oauth_tokens },
    { table: 'sessions', outcome: 'deleted', rows: counts.sessions },
    {
      table: 'shops',
      outcome: 'deleted',
      rows: counts.shops,
      detail: counts.shops > 0 ? 'con tutte le tabelle collegate, in cascata' : undefined,
    },
    progettoDelMerchant(),
  ];
}

/**
 * Dichiarato apposta, con zero righe: il progetto del merchant e' l'unico posto
 * dove restano dati dopo questa richiesta, e chi legge la traccia deve vedere
 * scritto che e' una decisione e non una svista.
 */
function progettoDelMerchant(): GdprStep {
  return {
    table: 'progetto Supabase del merchant',
    outcome: 'skipped',
    rows: 0,
    detail: 'database di proprieta del merchant: si revoca il nostro accesso, non i suoi dati',
  };
}
