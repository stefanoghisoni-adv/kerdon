import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROUTE_CAPABILITIES,
  guardCallOf,
  routeIdOf,
  routesWithoutRule,
  rulesWithoutRoute,
  type RouteCapabilityRule,
} from './route-capabilities';

/**
 * Il test che impedisce al difetto di tornare.
 *
 * Il difetto non era una rotta scritta male: era una rotta dimenticata. Cinque
 * loader autenticavano l'amministratore e servivano i dati senza mai chiedere
 * se quel negozio potesse ancora usarli, e nessuno se n'era accorto perche' non
 * c'era nessun posto in cui la mancanza si vedesse.
 *
 * Adesso c'e': i file veri si contano e si confrontano con la tabella. Una
 * rotta nuova, lasciata fuori, fa fallire qui — e chi la scrive deve dichiarare
 * o il permesso che chiede o la ragione per cui non ne chiede.
 */

const CARTELLA = join(process.cwd(), 'app', 'routes');

/** I file di rotta veri: `.tsx`, esclusi i test che dormono nella stessa cartella. */
const fileDiRotta = readdirSync(CARTELLA).filter(
  (nome) => nome.endsWith('.tsx') && !nome.includes('.test.'),
);
const rotte = fileDiRotta.map(routeIdOf);

const sorgenteDi = (id: string) => readFileSync(join(CARTELLA, `${id}.tsx`), 'utf-8');

/** La spiegazione del loader lasciato aperto, quando la regola ne ha una. */
const actionOnlyDi = (regola: RouteCapabilityRule): string | null =>
  regola.guard === 'capability' ? (regola.actionOnly ?? null) : null;

describe('la matrice rotta → capacita', () => {
  it('ogni rotta su disco ha una riga', () => {
    expect(routesWithoutRule(rotte)).toEqual([]);
  });

  it('nessuna riga descrive una rotta che non esiste piu', () => {
    expect(rulesWithoutRoute(rotte)).toEqual([]);
  });

  // La prova che il controllo qui sopra non e' una formalita': se domani
  // qualcuno aggiunge una tab di lettura e si dimentica il permesso, il test
  // deve accorgersene. Qui la rotta dimenticata la si inventa apposta.
  it('una rotta di lettura non elencata fa fallire il controllo', () => {
    const conUnaNuova = [...rotte, 'clienti.valore-per-cliente'];

    expect(routesWithoutRule(conUnaNuova)).toEqual(['clienti.valore-per-cliente']);
  });

  it('ogni rotta protetta chiama davvero il cancello che dichiara', () => {
    const scoperte = rotte.filter((id) => {
      const chiamata = guardCallOf(ROUTE_CAPABILITIES[id]);
      return chiamata !== null && !sorgenteDi(id).includes(chiamata);
    });

    expect(scoperte).toEqual([]);
  });

  // Una riga "aperta" senza motivo scritto e' una rotta dimenticata con
  // l'aspetto di una decisione. La ragione si legge, quindi dev'esserci ed
  // essere una frase, non una parola buttata li'.
  it('ogni rotta aperta dichiara per iscritto il perche', () => {
    const senzaRagione = Object.entries(ROUTE_CAPABILITIES)
      .filter(([, regola]) => regola.guard === 'open')
      .filter(([, regola]) => (regola as { reason: string }).reason.trim().length < 30)
      .map(([id]) => id);

    expect(senzaRagione).toEqual([]);
  });

  it('ogni rotta protetta solo nell action dice perche il loader resta aperto', () => {
    const senzaSpiegazione = Object.entries(ROUTE_CAPABILITIES)
      .filter(([, regola]) => actionOnlyDi(regola) !== null)
      .filter(([, regola]) => (actionOnlyDi(regola) ?? '').length < 30)
      .map(([id]) => id);

    expect(senzaSpiegazione).toEqual([]);
  });
});

/**
 * Le vie d'uscita, nominate una per una.
 *
 * Non basta che oggi siano aperte: deve restare scritto che devono restarlo.
 * Un negozio sospeso, con la prova finita o in cancellazione ha ancora tre cose
 * da poter fare — pagare, portarsi via i suoi dati, andarsene — e chiuderle
 * sarebbe peggio del buco che tutto il resto di questo giro ha tappato: un
 * merchant che non puo' aggiornare il piano non ha nessuna strada per
 * riaccendere l'app.
 */
const VIE_DI_USCITA = [
  'plan',
  'billing.subscribe',
  'billing.callback',
  'api.plan.limits',
  'privacy.my-data',
  'privacy.export.$id',
  'settings.supabase',
] as const;

describe('le vie d uscita', () => {
  it.each(VIE_DI_USCITA)('%s resta dichiarata aperta', (id) => {
    expect(ROUTE_CAPABILITIES[id].guard).toBe('open');
  });

  // Non solo la tabella: anche il file. Chi domani aggiungesse il cancello a
  // una di queste — per simmetria, con le migliori intenzioni — lascerebbe un
  // negozio a prova scaduta senza nessun modo di pagare, di scaricare i propri
  // dati o di scollegarsi.
  it.each(VIE_DI_USCITA)('%s non chiama il cancello nel codice', (id) => {
    expect(sorgenteDi(id)).not.toContain('requireShopCapability');
  });
});
