// app/lib/gdpr/erasure-proof.server.ts
//
// Come un negozio cancellato resta riconoscibile senza restare scritto.
//
// IL PARADOSSO DA CUI NASCE QUESTO FILE, ed e' lo stesso gia' risolto per il
// soggetto di una revoca di consenso: per dimostrare di aver cancellato
// `negozio.myshopify.com` bisognerebbe conservare `negozio.myshopify.com`. Il
// dominio di un negozio non e' un dato personale come un'email, ma identifica
// un titolare — e un registro delle cancellazioni che tiene l'elenco di chi ha
// chiesto di sparire e' il modo piu' elegante di non aver cancellato niente.
//
// L'impronta lo risolve. E' un'immagine a senso unico del dominio: chi apre la
// tabella non ci legge nessun negozio, ma chi arriva con una domanda precisa —
// "il negozio tal dei tali e' stato cancellato, e quando?" — puo' ricalcolarla
// e trovare la riga. Verificabile senza essere leggibile.
//
// PERCHE' UNA CHIAVE DERIVATA E NON `ENCRYPTION_SECRET` TALE E QUALE. Perche'
// l'impronta di una cancellazione non dev'essere la stessa cosa che cifrare un
// token di negozio: chi arrivasse a una non arriva all'altra. E perche' cosi'
// non si aggiunge una variabile d'ambiente obbligatoria che, mancando,
// spegnerebbe `shop/redact` in produzione — cioe' farebbe fallire per sempre
// proprio il webhook che Shopify pretende funzionante. E' la stessa scelta gia'
// fatta in `gdpr/audit.server` e in `consent/revocation-subject.server`.

import { createHmac, timingSafeEqual } from 'crypto';

/** L'etichetta con cui si deriva la chiave delle impronte. Non si tocca. */
//
// L'etichetta porta il nome di prima del cambio, e resta cosi'. Non e' una
// stringa da leggere: e' un ingrediente da cui si deriva la chiave, quindi
// cambiarla cambia la chiave. Tutto cio' che e' gia' stato cifrato o firmato
// con quella smetterebbe di potersi rileggere o verificare — e qui dentro
// finiscono le prove di una cancellazione e gli identificativi di chi ha
// revocato il consenso. Il nome del prodotto cambia, le chiavi no.
const ERASURE_KEY_LABEL = 'coreward:shop-erasure-ref:v1';

/**
 * La versione della procedura che scrive la prova.
 *
 * Sta nella riga perche' i conteggi sono un elenco di tabelle, e un elenco
 * cambia. Chi rilegge una prova di due anni fa deve poter distinguere una
 * tabella che allora non esisteva da una che nessuno ha cancellato: senza un
 * numero, quelle due assenze si scrivono nello stesso modo.
 *
 * Si alza quando cambia COSA la procedura cancella o COSA conta, non quando
 * cambia come lo fa.
 */
export const ERASURE_PROCEDURE_VERSION = 1;

/**
 * Il segreto di base.
 *
 * `SHOP_ERASURE_SECRET`, se c'e', vince: serve a poter ruotare questa chiave da
 * sola, senza toccare quella con cui sono cifrati i token dei negozi.
 * Altrimenti si deriva da `ENCRYPTION_SECRET`, che c'e' sempre.
 */
function segretoBase(): string {
  const dedicato = process.env.SHOP_ERASURE_SECRET;
  if (dedicato) return dedicato;

  const base = process.env.ENCRYPTION_SECRET;
  if (!base) {
    throw new Error(
      "ne SHOP_ERASURE_SECRET ne ENCRYPTION_SECRET sono configurati: impossibile firmare la prova di cancellazione",
    );
  }
  return base;
}

function chiave(): Buffer {
  return createHmac('sha256', segretoBase()).update(ERASURE_KEY_LABEL).digest();
}

/**
 * L'impronta del negozio, e l'unica cosa che di lui resta scritta.
 *
 * Il prefisso `v1:` c'e' dal primo giorno di proposito: le impronte GDPR sono
 * nate senza, e quando la firma e' cambiata si e' dovuto tenere in piedi un
 * ramo di verifica per le vecchie. Qui la transizione, se un giorno servira',
 * costa una riga.
 */
export function shopErasureRef(shopDomain: string): string {
  const firma = createHmac('sha256', chiave()).update(shopDomain).digest('base64url');
  return `v1:${firma}`;
}

/**
 * Verifica che una prova parli di questo negozio.
 *
 * `timingSafeEqual` pretende due buffer della stessa lunghezza e altrimenti
 * solleva: un'impronta di lunghezza diversa e' semplicemente un'impronta
 * diversa, non un errore da propagare.
 */
export function verifyShopErasureRef(ref: string, shopDomain: string): boolean {
  const atteso = Buffer.from(shopErasureRef(shopDomain));
  const dato = Buffer.from(ref);
  if (dato.length !== atteso.length) return false;
  return timingSafeEqual(dato, atteso);
}

/**
 * Quante righe per tabella la cancellazione ha tolto.
 *
 * E' il contenuto della prova: non "e' stato fatto", ma cosa e' stato fatto.
 * Le chiavi sono i nomi veri delle tabelle nel nostro database — quelli che
 * chi legge la prova puo' andare a cercare — e non ce n'e' nessuna che porti un
 * valore preso dai dati.
 */
export interface ErasureCounts {
  sessions: number;
  supabase_configs: number;
  supabase_oauth_tokens: number;
  customer_data_access_logs: number;
  shops: number;
}

export const ZERO_COUNTS: ErasureCounts = {
  sessions: 0,
  supabase_configs: 0,
  supabase_oauth_tokens: 0,
  customer_data_access_logs: 0,
  shops: 0,
};
