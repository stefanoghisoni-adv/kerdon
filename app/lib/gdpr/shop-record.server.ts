// app/lib/gdpr/shop-record.server.ts
//
// Cosa teniamo di un negozio, e come si toglie tutto quando il negozio chiede
// di essere dimenticato (shop/redact, quarantotto ore dopo la disinstallazione).
//
// L'inventario, perche' senza inventario si cancella quello che ci si ricorda:
//
//   shops                      la riga del negozio, e a cascata tutto quello
//                              che le pende: il collegamento al progetto
//                              Supabase con la service role key cifrata, i
//                              token OAuth, gli addebiti, il registro delle
//                              sincronizzazioni e il loro dettaglio, i campi
//                              personalizzati e le mappature, gli snapshot di
//                              idoneita', i feed di catalogo con i loro token
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
// COSA NON TOCCHIAMO, e non e' una scorciatoia: il progetto Supabase del
// merchant. Quelle tabelle stanno nel suo database, sotto il suo account, con
// la sua carta di credito: di quei dati il titolare e' lui, noi eravamo solo il
// mezzo con cui ci arrivavano. Andarci a cancellare le vendite di un anno
// perche' l'app e' stata disinstallata sarebbe, alla lettera, distruggere dati
// altrui senza mandato. Quello che si toglie e' la nostra chiave d'accesso —
// che sparisce con supabase_configs — cosi' che da questo momento noi in quel
// database non possiamo piu' entrare.

import { prisma } from '~/db.server';
import type { GdprStep } from './customer-record.server';

export interface ShopErasure {
  /**
   * L'id che il negozio aveva prima di essere cancellato, o null se il negozio
   * non c'era gia'. Serve al chiamante per una domanda sola: la traccia di
   * controllo puo' ancora essere legata a questa riga, o la riga non esiste
   * piu'?
   */
  shopId: string | null;
  steps: GdprStep[];
}

/**
 * Cancella tutto quello che il negozio ci ha lasciato.
 *
 * L'ordine conta: prima le righe che il vincolo lascerebbe orfane, poi le
 * sessioni, il negozio per ultimo — che e' la cascata e chiude il resto.
 *
 * Ogni passo ha il suo try: se uno cade, gli altri devono comunque provarci
 * (meglio nove tabelle su dieci di zero), ma l'esito resta fallito e Shopify
 * ritenta. Le cancellazioni sono per chiave, quindi ritentare e' innocuo: la
 * seconda passata trova zero righe e finisce.
 */
export async function eraseShopRecord(shopDomain: string): Promise<ShopErasure> {
  const steps: GdprStep[] = [];

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (shop) {
    try {
      const logs = await prisma.customerDataAccessLog.deleteMany({
        where: { shopId: shop.id },
      });
      steps.push({ table: 'customer_data_access_logs', outcome: 'deleted', rows: logs.count });
    } catch (error) {
      steps.push({
        table: 'customer_data_access_logs',
        outcome: 'failed',
        rows: 0,
        detail: error instanceof Error ? error.message : 'errore sconosciuto',
      });
    }
  } else {
    steps.push({
      table: 'customer_data_access_logs',
      outcome: 'skipped',
      rows: 0,
      detail: 'negozio non presente',
    });
  }

  try {
    const sessions = await prisma.session.deleteMany({ where: { shop: shopDomain } });
    steps.push({ table: 'sessions', outcome: 'deleted', rows: sessions.count });
  } catch (error) {
    steps.push({
      table: 'sessions',
      outcome: 'failed',
      rows: 0,
      detail: error instanceof Error ? error.message : 'errore sconosciuto',
    });
  }

  try {
    // deleteMany e non delete: un negozio gia' cancellato — perche' la richiesta
    // e' arrivata due volte, o perche' non l'abbiamo mai avuto — deve dare zero
    // righe, non un'eccezione che farebbe ritentare Shopify all'infinito.
    const shops = await prisma.shop.deleteMany({ where: { shopDomain } });
    steps.push({
      table: 'shops',
      outcome: 'deleted',
      rows: shops.count,
      detail: shops.count > 0 ? 'con tutte le tabelle collegate, in cascata' : undefined,
    });
  } catch (error) {
    steps.push({
      table: 'shops',
      outcome: 'failed',
      rows: 0,
      detail: error instanceof Error ? error.message : 'errore sconosciuto',
    });
  }

  // Dichiarato apposta, con zero righe: il progetto del merchant e' l'unico
  // posto dove restano dati dopo questa richiesta, e chi legge la traccia deve
  // vedere scritto che e' una decisione e non una svista.
  steps.push({
    table: 'progetto Supabase del merchant',
    outcome: 'skipped',
    rows: 0,
    detail: 'database di proprieta del merchant: si revoca il nostro accesso, non i suoi dati',
  });

  return { shopId: shop?.id ?? null, steps };
}
