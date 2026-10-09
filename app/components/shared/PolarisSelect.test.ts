// app/components/shared/PolarisSelect.test.ts

import { describe, it, expect, vi } from 'vitest';
import { getSelectedLabel, mapOptionsForList, reduceEscapeGuard, type EscapeGuardState, type PolarisSelectOption } from './PolarisSelect';

describe('getSelectedLabel', () => {
  const options: PolarisSelectOption[] = [
    { label: 'Opzione A', value: 'a' },
    { label: 'Opzione B', value: 'b' },
    { label: 'Opzione C', value: 'c', disabled: true },
  ];

  it('restituisce la label dell\'opzione selezionata', () => {
    expect(getSelectedLabel(options, 'a')).toBe('Opzione A');
    expect(getSelectedLabel(options, 'b')).toBe('Opzione B');
    expect(getSelectedLabel(options, 'c')).toBe('Opzione C');
  });

  it('restituisce il placeholder quando value non corrisponde', () => {
    expect(getSelectedLabel(options, '', 'Seleziona...')).toBe('Seleziona...');
    expect(getSelectedLabel(options, 'xyz', 'Nessuna opzione')).toBe('Nessuna opzione');
  });

  it('restituisce la prima opzione se nessun placeholder e value non corrisponde', () => {
    expect(getSelectedLabel(options, '')).toBe('Opzione A');
    expect(getSelectedLabel(options, 'xyz')).toBe('Opzione A');
  });

  it('gestisce array vuoto', () => {
    expect(getSelectedLabel([], 'a', 'Vuoto')).toBe('Vuoto');
    expect(getSelectedLabel([], 'a')).toBe('');
  });
});

describe('mapOptionsForList', () => {
  it('converte le opzioni nel formato OptionList', () => {
    const options: PolarisSelectOption[] = [
      { label: 'Prima', value: '1' },
      { label: 'Seconda', value: '2', disabled: true },
      { label: 'Terza', value: '3' },
    ];

    const result = mapOptionsForList(options);

    expect(result).toEqual([
      { label: 'Prima', value: '1', disabled: undefined },
      { label: 'Seconda', value: '2', disabled: true },
      { label: 'Terza', value: '3', disabled: undefined },
    ]);
  });

  it('gestisce array vuoto', () => {
    expect(mapOptionsForList([])).toEqual([]);
  });

  it('mantiene disabled undefined quando non specificato', () => {
    const options: PolarisSelectOption[] = [{ label: 'Test', value: 't' }];
    const result = mapOptionsForList(options);
    expect(result[0].disabled).toBeUndefined();
  });
});

describe('reduceEscapeGuard', () => {
  const closed: EscapeGuardState = { open: false, swallowEscapeKeyup: false };
  const open: EscapeGuardState = { open: true, swallowEscapeKeyup: false };

  it('menu aperto + keydown Escape: blocca, chiude e attende il keyup', () => {
    const r = reduceEscapeGuard(open, { type: 'keydown', key: 'Escape' });
    expect(r.block).toBe(true);
    expect(r.close).toBe(true);
    expect(r.nextState).toEqual({ open: false, swallowEscapeKeyup: true });
  });

  it('sequenza completa: il keyup dello stesso Escape è bloccato, il successivo arriva alla Modal', () => {
    let state = open;
    const down = reduceEscapeGuard(state, { type: 'keydown', key: 'Escape' });
    expect(down.block && down.close).toBe(true);
    state = down.nextState;

    // Tra keydown e keyup React ri-renderizza: i listener restano (stato in ref),
    // la guardia vede solo lo stato aggiornato.
    const up = reduceEscapeGuard(state, { type: 'keyup', key: 'Escape' });
    expect(up.block).toBe(true);
    expect(up.close).toBe(false);
    state = up.nextState;
    expect(state).toEqual(closed);

    // Secondo Escape a menu chiuso: passa, la Modal può chiudersi.
    const down2 = reduceEscapeGuard(state, { type: 'keydown', key: 'Escape' });
    expect(down2.block).toBe(false);
    const up2 = reduceEscapeGuard(down2.nextState, { type: 'keyup', key: 'Escape' });
    expect(up2.block).toBe(false);
    expect(up2.close).toBe(false);
  });

  it('un keyup di un altro tasto in mezzo non consuma il flag', () => {
    let state = reduceEscapeGuard(open, { type: 'keydown', key: 'Escape' }).nextState;
    const shift = reduceEscapeGuard(state, { type: 'keyup', key: 'Shift' });
    expect(shift.block).toBe(false);
    expect(shift.nextState.swallowEscapeKeyup).toBe(true);
    state = shift.nextState;
    expect(reduceEscapeGuard(state, { type: 'keyup', key: 'Escape' }).block).toBe(true);
  });

  it('blur della finestra azzera il flag', () => {
    const state = reduceEscapeGuard(open, { type: 'keydown', key: 'Escape' }).nextState;
    const blurred = reduceEscapeGuard(state, { type: 'blur' });
    expect(blurred.block).toBe(false);
    expect(blurred.nextState.swallowEscapeKeyup).toBe(false);
    expect(reduceEscapeGuard(blurred.nextState, { type: 'keyup', key: 'Escape' }).block).toBe(false);
  });

  it('autorepeat del keydown dopo la chiusura resta bloccato senza richiudere', () => {
    const state = reduceEscapeGuard(open, { type: 'keydown', key: 'Escape' }).nextState;
    const repeat = reduceEscapeGuard(state, { type: 'keydown', key: 'Escape' });
    expect(repeat.block).toBe(true);
    expect(repeat.close).toBe(false);
    expect(repeat.nextState.swallowEscapeKeyup).toBe(true);
  });

  it('menu chiuso: non blocca mai', () => {
    for (const type of ['keydown', 'keyup'] as const) {
      for (const key of ['Escape', 'Enter', 'Tab']) {
        const r = reduceEscapeGuard(closed, { type, key });
        expect(r.block).toBe(false);
        expect(r.close).toBe(false);
        expect(r.nextState).toEqual(closed);
      }
    }
    expect(reduceEscapeGuard(closed, { type: 'blur' }).block).toBe(false);
  });

  it('menu aperto: gli altri tasti non vengono toccati', () => {
    const r = reduceEscapeGuard(open, { type: 'keydown', key: 'ArrowDown' });
    expect(r.block).toBe(false);
    expect(r.close).toBe(false);
    expect(r.nextState).toEqual(open);
  });
});
