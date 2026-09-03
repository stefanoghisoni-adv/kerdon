/**
 * La data di nascita che il merchant ha scritto a mano, riportata su Shopify.
 *
 * La regola, per intero, in una riga: **Shopify vince quando ha un valore; se
 * Shopify e' vuoto e il database del merchant no, quel valore resta dov'e' e
 * viene scritto sul metafield di Shopify.**
 *
 * Meta' della regola vive nel transformer (`transformers/customer.server`), che
 * quando Shopify non ha niente lascia la chiave `date_of_birth` fuori dalla riga
 * e cosi' non cancella la colonna. Quella meta' da sola pero' congela il dato:
 * resta per sempre su un solo database, dove nessun tema, nessuna automazione e
 * nessun segmento di Shopify puo' vederlo. Questa e' l'altra meta' — quella che
 * lo rimette dove tutto il resto lo cerca.
 *
 * ## Perche' e' idempotente
 *
 * Si scrive nello stesso metafield da cui si legge. Alla corsa successiva
 * Shopify quel valore ce l'ha, quindi rientra dalla porta principale — vince
 * lui, `date_of_birth` torna nella riga dell'upsert — e qui non resta niente da
 * riscrivere, perche' `planBirthdateWriteback` considera solo i clienti per cui
 * Shopify e' VUOTO. E' l'unica ragione per cui questa riscrittura non ripete
 * all'infinito la stessa mutation a ogni giro del cron.
 *
 * Da qui anche la regola che `birthdateWritebackTarget` non tradisce mai: si
 * scrive SOLTANTO nel campo da cui si legge, qualunque esso sia. Scriverne uno
 * diverso romperebbe proprio quella catena — Shopify resterebbe vuoto dalla
 * parte che guardiamo, e la stessa scrittura ripartirebbe a ogni corsa, per
 * sempre.
 *
 * ## Chi non viene mai toccato
 *
 * I clienti che il consenso non l'hanno dato, o l'hanno ritirato: non vengono
 * sincronizzati, e la loro riga viene svuotata (`consent-withdrawal`). Qui non
 * arrivano proprio, perche' chi chiama passa i soli clienti consenzienti — ed
 * e' il confine da non spostare: una riscrittura verso Shopify su una persona
 * che ha detto di no sarebbe un uso del suo dato che nessuno ha autorizzato.
 */

import { normalizeBirthdate } from '~/lib/transformers/customer-format';
import {
  BIRTHDATE_METAFIELD,
  isDateMetafieldType,
  isStandardBirthdateField,
  type MetafieldKey,
} from './birthdate-metafield';

/** Il metafield su cui si scrive, con il tipo che Shopify si aspetta. */
export interface BirthdateWriteTarget extends MetafieldKey {
  type: string;
}

/**
 * Dove riscrivere, o `null` se non si riscrive affatto.
 *
 * Tre condizioni, e servono tutte e tre:
 *
 *  - il permesso di scrittura sui clienti c'e' (senza, ogni mutation tornerebbe
 *    indietro: si salta e basta, non e' un errore);
 *  - il merchant un campo l'ha scelto (se non l'ha scelto, Shopify non lo
 *    leggiamo nemmeno: "vuoto" non lo sapremmo distinguere da "non chiesto");
 *  - di quel campo si sa il TIPO, ed e' un tipo su cui si possa scrivere una
 *    data.
 *
 * L'ultima e' quella che qui e' cambiata. `metafieldsSet` col tipo sbagliato
 * non scrive niente, rifiuta: senza tipo non si parte. Del campo standard il
 * tipo lo sappiamo per definizione — e' `date`, e `type` non serve nemmeno
 * passarlo — mentre di uno scelto dal merchant fra i suoi lo si legge
 * dall'elenco delle definizioni del negozio, la stessa risposta che riempie la
 * tendina nella tab Clienti. Chiamando questa funzione lo si passa gia' letto:
 * qui dentro non si parla con nessuno, e la domanda a Shopify resta una per
 * corsa e non una per cliente.
 *
 * `type` a `null` significa "non lo sappiamo" — elenco non leggibile, oppure
 * campo che sul negozio non c'e' (piu'). Non e' un permesso a tirare a
 * indovinare: si legge e basta, com'era prima.
 *
 * ## Perche' `date_time` no
 *
 * `date_time` contiene una data — `isDateMetafieldType` lo dice, ed e' giusto
 * cosi': di la' la data si LEGGE benissimo. Ma per scriverci dentro servirebbe
 * anche un'ora, e di una data di nascita l'ora non esiste: qualunque la
 * scegliessimo sarebbe inventata da noi. Non e' un dettaglio invisibile —
 * Shopify conserva `date_time` in UTC e lo mostra al merchant nel fuso del suo
 * negozio, quindi la mezzanotte che scrivessimo diventerebbe il giorno prima
 * per ogni negozio a ovest di Greenwich: gli scriveremmo un compleanno
 * sbagliato di un giorno, e sbagliato in modo credibile. Da un campo cosi' si
 * continua solo a leggere, che e' esattamente cio' che accadeva prima per tutti
 * i campi personalizzati.
 */
export function birthdateWritebackTarget(
  configured: MetafieldKey | null | undefined,
  canWriteCustomers: boolean,
  /**
   * Il tipo del campo, letto dalle definizioni del negozio. Si omette per il
   * campo standard, il cui tipo non e' in discussione.
   */
  type?: string | null,
): BirthdateWriteTarget | null {
  if (!canWriteCustomers) return null;
  if (!configured) return null;

  if (isStandardBirthdateField(configured)) return { ...BIRTHDATE_METAFIELD };

  const declared = (type ?? '').trim().toLowerCase();
  if (!declared) return null;
  // Un campo di testo si continua a leggere: da li' la data si ricava quando e'
  // scritta in modo riconoscibile, ma scriverci dentro il nostro formato
  // vorrebbe dire decidere noi come il merchant tiene i suoi dati.
  if (!isDateMetafieldType(declared)) return null;
  // Solo `date`: il perche' di `date_time` sta nel commento qui sopra.
  if (declared !== BIRTHDATE_METAFIELD.type) return null;

  return { namespace: configured.namespace, key: configured.key, type: declared };
}

/**
 * La data come la vuole un metafield di tipo `date`: `AAAA-MM-GG`.
 *
 * Sul database del merchant sta compatta (`19850423`), perche' e' la forma che
 * Meta e Google confrontano; Shopify la vuole con i trattini. La conversione
 * passa da `normalizeBirthdate`, che e' anche il filtro: quello che non e' una
 * data — `"boh"`, `"1985-13-45"`, una cella lasciata a meta' — torna `null` e
 * non parte. Mandare a Shopify una data inventata sarebbe peggio che non
 * mandarne nessuna, perche' poi vincerebbe lei su tutto il resto.
 */
export function toShopifyDate(value: string | null | undefined): string | null {
  const compact = normalizeBirthdate(value);
  if (!compact) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/** Un cliente e la data da scrivergli sopra. */
export interface BirthdateWrite {
  customerId: number;
  /** Gia' nella forma `AAAA-MM-GG`. */
  date: string;
}

export interface BirthdateWritebackPlan {
  writes: BirthdateWrite[];
  /**
   * I clienti la cui data sul database del merchant non e' una data.
   *
   * Non sono un errore da alzare — il merchant scrive quello che vuole nella
   * sua tabella — ma vanno nominati, perche' altrimenti quella riga resterebbe
   * per sempre a meta' senza che nessuno sappia dirgli perche'.
   */
  invalid: number[];
}

/**
 * Chi va riscritto su Shopify, deciso senza toccare la rete.
 *
 * `stored` e' quello che c'era sul database del merchant PRIMA dell'upsert:
 * dopo non servirebbe piu' a niente, perche' l'upsert e' proprio l'operazione
 * che allinea le due parti. Arriva dalla stessa lettura che gia' serve a
 * distinguere i clienti aggiunti da quelli aggiornati — una sola per pagina,
 * non una per cliente.
 *
 * `null` significa "la lettura non e' riuscita": in quel caso non si riscrive
 * niente. Non sapere cosa c'e' sul database del merchant non autorizza a
 * indovinare cosa mandare a Shopify.
 */
export function planBirthdateWriteback(
  customers: readonly { id: number; date_of_birth?: string | null }[],
  stored: ReadonlyMap<number, string | null> | null,
): BirthdateWritebackPlan {
  const writes: BirthdateWrite[] = [];
  const invalid: number[] = [];

  if (!stored) return { writes, invalid };

  for (const customer of customers) {
    // Shopify ha un valore: vince lui, e la riscrittura non ha nulla da fare.
    // E' anche il caso in cui ci si ritrova al giro dopo aver riscritto, ed e'
    // cio' che rende questa operazione idempotente.
    if (normalizeBirthdate(customer.date_of_birth) !== null) continue;

    const saved = stored.get(customer.id);
    // `undefined` = cliente non ancora sul database del merchant (lo sta
    // aggiungendo questa corsa): non c'e' niente di suo da riportare indietro.
    if (saved == null || saved.trim() === '') continue;

    const date = toShopifyDate(saved);
    if (!date) {
      invalid.push(customer.id);
      continue;
    }

    writes.push({ customerId: customer.id, date });
  }

  return { writes, invalid };
}
