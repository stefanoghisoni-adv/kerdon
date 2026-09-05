// app/lib/consent/revocation-subject.server.ts
//
// Come il soggetto di una revoca sta scritto sul registro: cifrato per poterlo
// riusare, firmato per poterlo riconoscere senza leggerlo.
//
// IL PARADOSSO DA CUI NASCE QUESTO FILE. Per ritentare una cancellazione serve
// sapere COSA cancellare, cioe' proprio l'identificativo del browser che la
// revoca deve far sparire. Tenerlo in chiaro in una tabella dell'applicazione
// vorrebbe dire che una revoca in attesa e' un dato personale in piu', non uno
// in meno. Non tenerlo vorrebbe dire che una revoca fallita non si puo'
// riprovare — che e' il guasto di partenza.
//
// La risposta e' in due pezzi, e servono tutti e due:
//
//  - il TESTO CIFRATO, che si puo' rileggere solo con la chiave e che si
//    cancella appena il lavoro riesce;
//  - l'IMPRONTA HMAC, che non si puo' rileggere affatto e che resta: e' su
//    quella che si deduplica, ed e' quella che rimane come prova quando il
//    testo cifrato non c'e' piu'.
//
// PERCHE' NON `utils/crypto.server`. Quello pretende un `ENCRYPTION_SECRET` di
// 64 caratteri esadecimali e lo usa tale e quale come chiave. Qui la chiave si
// DERIVA, con un'etichetta sua: cosi' la cifratura di un soggetto di revoca non
// e' la stessa cosa che cifrare un token di negozio — chi arrivasse a una non
// arriva all'altra — e non si aggiunge una variabile d'ambiente obbligatoria
// che, mancando, spegnerebbe le revoche in produzione. E' la stessa scelta gia'
// fatta per le impronte GDPR in `gdpr/audit.server`.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import type { RevocationScope } from './revocation-model';

const ALGORITMO = 'aes-256-gcm';
const IV_BYTES = 12;

/** Le due etichette con cui si derivano le due chiavi. Non si toccano. */
const CIPHER_KEY_LABEL = 'coreward:consent-revocation-cipher:v1';
const DIGEST_KEY_LABEL = 'coreward:consent-revocation-digest:v1';

/**
 * Il segreto di base.
 *
 * `CONSENT_REVOCATION_SECRET`, se c'e', vince: serve a poter ruotare queste due
 * chiavi da sole, senza toccare quella con cui sono cifrati i token dei negozi.
 * Altrimenti si deriva da `ENCRYPTION_SECRET`, che c'e' sempre.
 */
function segretoBase(): string {
  const dedicato = process.env.CONSENT_REVOCATION_SECRET;
  if (dedicato) return dedicato;

  const base = process.env.ENCRYPTION_SECRET;
  if (!base) {
    throw new Error(
      'ne CONSENT_REVOCATION_SECRET ne ENCRYPTION_SECRET sono configurati: impossibile registrare una revoca',
    );
  }
  return base;
}

function chiave(etichetta: string): Buffer {
  return createHmac('sha256', segretoBase()).update(etichetta).digest();
}

/**
 * Chiude il soggetto.
 *
 * `iv:tag:testo`, tutto esadecimale, nella stessa forma di
 * `utils/crypto.server`: chi guarda una colonna cifrata di questo progetto
 * trova sempre la stessa cosa, e non deve indovinare quale delle due sia.
 */
export function sealSubject(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITMO, chiave(CIPHER_KEY_LABEL), iv);

  const chiuso = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${chiuso.toString('hex')}`;
}

/**
 * Riapre il soggetto, o dice di no.
 *
 * Restituisce `null` invece di sollevare, e non e' pigrizia: chi chiama e' il
 * processore, e un testo cifrato illeggibile — chiave ruotata, colonna gia'
 * potata — non e' un guasto passeggero. Deve diventare una lettera morta con un
 * motivo scritto, non un'eccezione che finisce in un ritentativo che dara' lo
 * stesso risultato per cinque volte.
 */
export function openSubject(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;

  const parti = ciphertext.split(':');
  if (parti.length !== 3) return null;

  try {
    const [ivHex, tagHex, testoHex] = parti;
    const decipher = createDecipheriv(ALGORITMO, chiave(CIPHER_KEY_LABEL), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

    const aperto = Buffer.concat([
      decipher.update(Buffer.from(testoHex, 'hex')),
      decipher.final(),
    ]);
    return aperto.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * L'identita' di una revoca, e l'unica cosa su cui si deduplica.
 *
 * Negozio, scopo e soggetto, firmati. Il negozio ci sta dentro apposta: senza,
 * lo stesso identificativo varrebbe per la stessa revoca in negozi diversi. Lo
 * scopo pure: la stessa persona puo' revocare due cose distinte, e fonderle in
 * un lavoro solo vorrebbe dire farne una sola.
 *
 * A senso unico: chi apre la tabella non ci legge nessun identificativo, ma chi
 * arriva con una domanda precisa — "la revoca di questo browser e' stata presa
 * in carico?" — puo' ricalcolarlo e trovare la riga. Verificabile senza essere
 * leggibile, esattamente come le impronte del registro GDPR.
 */
export function revocationIdempotencyKey(params: {
  shopId: string;
  scope: RevocationScope;
  subject: string;
}): string {
  const payload = `${params.shopId}:${params.scope}:${params.subject}`;
  const firma = createHmac('sha256', chiave(DIGEST_KEY_LABEL)).update(payload).digest('base64url');
  return `v1:${firma}`;
}
