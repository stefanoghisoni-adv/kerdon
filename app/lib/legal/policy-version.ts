/**
 * La versione dell'informativa in vigore, scritta in un posto solo.
 *
 * PERCHE' UNA COSTANTE E NON LA TESTATA LETTA DAL MARKDOWN. Il documento la
 * dichiara gia', e `versioneEData()` la sa leggere. Ma chi la legge qui e' la
 * Dashboard, a ogni apertura dell'app: passare dal Markdown vorrebbe dire
 * rendere un documento intero per sapere un numero, e legare l'avviso al
 * formato della testata. La costante e' il numero e basta; che resti uguale a
 * quello dei documenti lo controlla `policy-version.test.ts`, che fallisce
 * appena uno dei due cambia senza l'altro.
 *
 * QUANDO SI CAMBIA. A ogni modifica SOSTANZIALE dell'informativa — quella che
 * la sezione 10 promette di annunciare in app — insieme alla testata dei due
 * Markdown e di `privacy-policy.html`. Alzarla e' il gesto che fa ricomparire
 * l'avviso a ogni negozio installato prima di quella data. Va aggiornata nello
 * stesso commit anche la frase dell'avviso (`dashboard.privacyNotice` nei
 * dizionari): dice cosa cambia in QUESTA versione.
 */
export const PRIVACY_POLICY_VERSION = '1.6';

/** La data in testa ai documenti, nella stessa forma (`GG-MM-AAAA`). */
export const PRIVACY_POLICY_DATE = '08-10-2026';

/**
 * Confronta due versioni a numeri (`1.4`, `1.10`): negativo, zero o positivo.
 *
 * Numero per numero e non come testo: come testo `1.10` verrebbe prima di
 * `1.9`, e un negozio che ha visto la 1.10 si vedrebbe riproporre l'avviso
 * della 1.9 come se fosse nuovo.
 */
export function confrontaVersioni(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** L'inizio (UTC) del giorno scritto come `GG-MM-AAAA`. */
function inizioDelGiorno(data: string): Date {
  const [g, m, a] = data.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(a, m - 1, g));
}

/**
 * Se l'avviso delle modifiche all'informativa va mostrato a questo negozio.
 *
 * Due casi in cui NON va mostrato:
 *
 *  - il negozio ha gia' detto "Ho capito" per questa versione o per una piu'
 *    recente;
 *  - il negozio e' stato installato per la prima volta (nuova riga) dal giorno
 *    della versione in poi: l'informativa che ha accettato installando e' gia'
 *    questa, e annunciargli una "modifica" sarebbe falso — anche se una volta,
 *    prima di disinstallare, aveva visto l'avviso di una versione vecchia.
 *
 * In tutti gli altri casi si mostra — compreso quello in cui non si sa che
 * cosa il negozio abbia visto (`seenVersion` null). Un avviso in piu' costa
 * un clic; uno in meno e' la promessa della sezione 10 non mantenuta.
 */
export function avvisoInformativaDovuto({
  seenVersion,
  installedAt,
  currentVersion = PRIVACY_POLICY_VERSION,
  currentDate = PRIVACY_POLICY_DATE,
}: {
  seenVersion: string | null;
  installedAt: Date | null;
  currentVersion?: string;
  currentDate?: string;
}): boolean {
  if (seenVersion !== null && confrontaVersioni(seenVersion, currentVersion) >= 0) return false;
  if (installedAt && installedAt.getTime() >= inizioDelGiorno(currentDate).getTime()) return false;
  return true;
}
