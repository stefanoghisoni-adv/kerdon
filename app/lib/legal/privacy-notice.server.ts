// app/lib/legal/privacy-notice.server.ts
//
// L'avviso in app delle modifiche sostanziali all'informativa.
//
// La sezione 10 dell'informativa promette che una modifica sostanziale viene
// annunciata dentro l'app prima di valere. Questo file ricorda, per negozio,
// l'ultima versione per cui il merchant ha detto "Ho capito"; la Dashboard
// confronta quella con `PRIVACY_POLICY_VERSION` e decide se mostrare l'avviso.
//
// PERCHE' SUL SERVER E NON NEL BROWSER. Per le stesse due ragioni scritte in
// `customers/birthdate-dismissal.server.ts`: dentro l'admin l'app vive in un
// iframe di un'altra origine, quindi il suo storage e' di terze parti (Safari
// lo blocca, Chrome lo partiziona), e cambiando dominio la memoria resterebbe
// su quello vecchio. Qui in piu' c'e' una ragione legale: che il negozio abbia
// visto l'avviso e' un fatto da poter dimostrare, non una preferenza.

import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { PRIVACY_POLICY_VERSION, avvisoInformativaDovuto } from './policy-version';

/**
 * La tabella non c'e' ancora: la migrazione la lancia una persona, a mano, su
 * Live e su Test, e fra il rilascio del codice e quel momento manca.
 */
function tabellaAssente(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return e.code === 'P2021' || e.code === 'P2022';
  }
  return e instanceof Error && /does not exist|relation .* does not exist/i.test(e.message);
}

/**
 * Se a questo negozio va mostrato l'avviso.
 *
 * QUANDO NON SI PUO' SAPERE si mostra. E' la scelta opposta a quella degli
 * avvisi della data di nascita e del peso, e va detto perche': quelli sono
 * cortesie, e un avviso che il merchant non riesce a chiudere e' peggio di uno
 * che non si vede. Questo e' l'annuncio che l'informativa promette: non
 * vederlo e' la promessa non mantenuta, vederlo una volta di troppo costa un
 * clic. E non blocca niente — e' un Banner in cima alla Dashboard, il resto
 * della pagina funziona lo stesso.
 */
export async function privacyNoticeDue(shop: {
  id: string;
  installedAt: Date | null;
}): Promise<boolean> {
  let seenVersion: string | null = null;
  try {
    const riga = await prisma.privacyNoticeAcknowledgement.findUnique({
      where: { shopId: shop.id },
      select: { versionSeen: true },
    });
    seenVersion = riga?.versionSeen ?? null;
  } catch (e) {
    if (!tabellaAssente(e)) {
      console.warn(
        '[privacy-notice] lettura non riuscita:',
        e instanceof Error ? e.message : 'errore sconosciuto',
      );
    }
  }
  return avvisoInformativaDovuto({ seenVersion, installedAt: shop.installedAt });
}

/**
 * Registra che il negozio ha visto l'avviso della versione corrente.
 *
 * Idempotente: una riga per negozio, sovrascritta. Due clic, due richieste
 * ripetute dalla rete, la stessa riga con la stessa versione. La versione e'
 * sempre quella del server, mai una che arriva dal browser: un modulo
 * riscritto a mano non puo' far risultare vista una versione futura.
 *
 * Risponde se ha potuto scrivere: chi chiama lo dice al merchant, e l'avviso
 * torna invece di far credere registrato un "Ho capito" che non lo e'.
 */
export async function acknowledgePrivacyNotice(shopId: string): Promise<boolean> {
  try {
    await prisma.privacyNoticeAcknowledgement.upsert({
      where: { shopId },
      create: { shopId, versionSeen: PRIVACY_POLICY_VERSION },
      update: { versionSeen: PRIVACY_POLICY_VERSION, seenAt: new Date() },
    });
    return true;
  } catch (e) {
    if (!tabellaAssente(e)) {
      console.error(
        '[privacy-notice] scrittura non riuscita:',
        e instanceof Error ? e.message : 'errore sconosciuto',
      );
    }
    return false;
  }
}
