import { useEffect, useState } from 'react';
import { useNavigation } from '@remix-run/react';

// Parente stretto di `nav-loading.ts`, e nato dallo stesso malinteso.
//
// I filtri della tab Prodotti vivono nell'indirizzo: premerne uno e' una
// navigazione, e per sapere quale filtro sta caricando si guardava la sola
// `useNavigation`. Ma quella dice DOVE sta andando l'app, non da dove parte e
// nemmeno chi l'ha mandata: uscendo dalla tab col menu laterale dell'admin la
// navigazione risulta ugualmente in corso, con una destinazione senza query — e
// "senza query" era esattamente la firma del filtro "Tutti". Cosi' il merchant
// che stava andando altrove vedeva i filtri spegnersi e il cerchietto accendersi
// su un pulsante che non aveva premuto, su una pagina che stava lasciando.
//
// Servono due consensi, non uno: che la destinazione sia ancora questa pagina, e
// che sia stato un filtro di questa pagina a farla partire.

export interface FilterNavInput {
  /** Un filtro di questa pagina e' stato premuto e non e' ancora arrivato. */
  requested: boolean;
  /** Stato di useNavigation. */
  navigationState: 'idle' | 'loading' | 'submitting';
  /** Percorso della navigazione in corso, se ce n'e' una. */
  navigatingTo: string | undefined;
  /** Query della navigazione in corso, se ce n'e' una. */
  navigatingSearch: string | undefined;
  /** Il percorso su cui vivono questi filtri. */
  path: string;
}

export interface FilterNavState {
  /** Un filtro sta cambiando: nessuno dei due si puo' premere nel frattempo. */
  switching: boolean;
  /** Il cerchietto sul filtro "Tutti". */
  loadingAll: boolean;
  /** Il cerchietto sul filtro "Solo prodotti negli ordini". */
  loadingSold: boolean;
}

const IDLE: FilterNavState = { switching: false, loadingAll: false, loadingSold: false };

export function filterNavState(input: FilterNavInput): FilterNavState {
  // Nessuno ha premuto: qualunque navigazione in corso e' di qualcun altro — il
  // menu dell'admin, un link, il tasto indietro.
  if (!input.requested) return IDLE;
  // Un invio di form non e' un cambio di filtro: il ricontrollo dei costi non
  // deve spegnere i filtri.
  if (input.navigationState !== 'loading') return IDLE;
  // Si sta lasciando la pagina: i filtri di questa pagina non c'entrano piu'.
  if (input.navigatingTo !== input.path) return IDLE;

  const search = input.navigatingSearch ?? '';
  return {
    switching: true,
    // Senza query si torna all'elenco completo; con `sold=1` (o con un cliente,
    // che quel filtro lo implica) si va sui soli prodotti venduti.
    loadingAll: search === '',
    loadingSold: search.includes('sold=1') || search.includes('customer='),
  };
}

export interface FilterNav extends FilterNavState {
  /** Da chiamare quando si preme un filtro, prima di navigare. */
  start: () => void;
}

/**
 * Stato di attesa dei filtri che vivono su `path`, acceso solo se e' stato un
 * filtro di questa pagina a far partire la navigazione.
 */
export function useFilterNav(path: string): FilterNav {
  const navigation = useNavigation();
  const [requested, setRequested] = useState(false);

  // A navigazione finita si riparte da zero: senza, un filtro premuto e poi
  // scavalcato dal menu laterale resterebbe armato per il giro dopo.
  useEffect(() => {
    if (navigation.state === 'idle') setRequested(false);
  }, [navigation.state]);

  return {
    ...filterNavState({
      requested,
      navigationState: navigation.state,
      navigatingTo: navigation.location?.pathname,
      navigatingSearch: navigation.location?.search,
      path,
    }),
    start: () => setRequested(true),
  };
}
