// app/components/shared/PolarisSelect.test.ts

import { describe, it, expect } from 'vitest';
import { getSelectedLabel, mapOptionsForList, type PolarisSelectOption } from './PolarisSelect';

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

  it('restituisce stringa vuota se nessun placeholder e value non corrisponde', () => {
    expect(getSelectedLabel(options, '')).toBe('');
    expect(getSelectedLabel(options, 'xyz')).toBe('');
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
