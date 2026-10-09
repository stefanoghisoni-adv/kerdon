// app/components/shared/PolarisSelect.test.ts

import { describe, it, expect, vi } from 'vitest';
import { getSelectedLabel, mapOptionsForList, shouldBlockEscapeEvent, setupEscapeHandling, type PolarisSelectOption } from './PolarisSelect';

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

describe('shouldBlockEscapeEvent', () => {
  it('restituisce true per evento Escape', () => {
    const event = { key: 'Escape' } as KeyboardEvent;
    expect(shouldBlockEscapeEvent(event)).toBe(true);
  });

  it('restituisce false per altri tasti', () => {
    expect(shouldBlockEscapeEvent({ key: 'Enter' } as KeyboardEvent)).toBe(false);
    expect(shouldBlockEscapeEvent({ key: 'Space' } as KeyboardEvent)).toBe(false);
    expect(shouldBlockEscapeEvent({ key: 'Tab' } as KeyboardEvent)).toBe(false);
    expect(shouldBlockEscapeEvent({ key: 'a' } as KeyboardEvent)).toBe(false);
  });

  it('funziona sia per keydown che keyup', () => {
    expect(shouldBlockEscapeEvent({ key: 'Escape' } as KeyboardEvent)).toBe(true);
    expect(shouldBlockEscapeEvent({ key: 'Escape' } as KeyboardEvent)).toBe(true);
  });
});

describe('setupEscapeHandling', () => {
  // Stub minimale di EventTarget che traccia listener e permette dispatch
  class EventTargetStub {
    private listeners = new Map<string, Array<{ fn: (e: Event) => void; options?: any }>>();

    addEventListener(event: string, fn: (e: Event) => void, options?: boolean | any) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, []);
      }
      // Normalizza options: se è boolean, è il valore di capture
      const normalizedOptions = typeof options === 'boolean' ? { capture: options } : options;
      this.listeners.get(event)!.push({ fn, options: normalizedOptions });
    }

    removeEventListener(event: string, fn: (e: Event) => void) {
      const list = this.listeners.get(event);
      if (list) {
        const index = list.findIndex((l) => l.fn === fn);
        if (index !== -1) {
          list.splice(index, 1);
        }
      }
    }

    dispatchEvent(event: Event, phase: 'capture' | 'bubble' = 'bubble') {
      const list = this.listeners.get(event.type);
      if (!list) return;

      for (const { fn, options } of list) {
        // Esegui solo listener in capture phase se richiesto
        if (phase === 'capture' && options?.capture !== true) continue;
        if (phase === 'bubble' && options?.capture === true) continue;

        fn(event);

        // Se once: true, rimuovi dopo la prima esecuzione
        if (options?.once) {
          this.removeEventListener(event.type, fn);
        }
      }
    }

    getListenerCount(event: string, capture?: boolean): number {
      const list = this.listeners.get(event);
      if (!list) return 0;
      if (capture === undefined) return list.length;
      return list.filter((l) => l.options?.capture === capture).length;
    }
  }

  function createKeyboardEvent(key: string, type: 'keydown' | 'keyup'): Event {
    const event = {
      type,
      key,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as Event;
    return event;
  }

  it('blocca keydown Escape e aggiunge one-shot listener per keyup', () => {
    const stub = new EventTargetStub();
    const onEscape = vi.fn();
    const cleanup = setupEscapeHandling(stub as any, onEscape);

    expect(stub.getListenerCount('keydown', true)).toBe(1);
    expect(stub.getListenerCount('keyup', true)).toBe(0);

    const keydownEvent = createKeyboardEvent('Escape', 'keydown');
    stub.dispatchEvent(keydownEvent, 'capture');

    expect(keydownEvent.preventDefault).toHaveBeenCalled();
    expect(keydownEvent.stopPropagation).toHaveBeenCalled();
    expect(keydownEvent.stopImmediatePropagation).toHaveBeenCalled();
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(stub.getListenerCount('keyup', true)).toBe(1);

    cleanup();
  });

  it('il one-shot listener keyup blocca Escape e si rimuove', () => {
    const stub = new EventTargetStub();
    const onEscape = vi.fn();
    const cleanup = setupEscapeHandling(stub as any, onEscape);

    const keydownEvent = createKeyboardEvent('Escape', 'keydown');
    stub.dispatchEvent(keydownEvent, 'capture');

    expect(stub.getListenerCount('keyup', true)).toBe(1);

    const keyupEvent = createKeyboardEvent('Escape', 'keyup');
    stub.dispatchEvent(keyupEvent, 'capture');

    expect(keyupEvent.preventDefault).toHaveBeenCalled();
    expect(keyupEvent.stopImmediatePropagation).toHaveBeenCalled();
    expect(stub.getListenerCount('keyup', true)).toBe(0);

    cleanup();
  });

  it('non blocca altri tasti', () => {
    const stub = new EventTargetStub();
    const onEscape = vi.fn();
    const cleanup = setupEscapeHandling(stub as any, onEscape);

    const enterEvent = createKeyboardEvent('Enter', 'keydown');
    stub.dispatchEvent(enterEvent, 'capture');

    expect(enterEvent.preventDefault).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
    expect(stub.getListenerCount('keyup', true)).toBe(0);

    cleanup();
  });

  it('cleanup rimuove tutti i listener', () => {
    const stub = new EventTargetStub();
    const onEscape = vi.fn();
    const cleanup = setupEscapeHandling(stub as any, onEscape);

    const keydownEvent = createKeyboardEvent('Escape', 'keydown');
    stub.dispatchEvent(keydownEvent, 'capture');

    expect(stub.getListenerCount('keydown', true)).toBe(1);
    expect(stub.getListenerCount('keyup', true)).toBe(1);

    cleanup();

    expect(stub.getListenerCount('keydown', true)).toBe(0);
    expect(stub.getListenerCount('keyup', true)).toBe(0);
  });

  it('keydown Escape successivi puliscono il one-shot precedente', () => {
    const stub = new EventTargetStub();
    const onEscape = vi.fn();
    const cleanup = setupEscapeHandling(stub as any, onEscape);

    // Primo keydown
    stub.dispatchEvent(createKeyboardEvent('Escape', 'keydown'), 'capture');
    expect(stub.getListenerCount('keyup', true)).toBe(1);
    expect(onEscape).toHaveBeenCalledTimes(1);

    // Secondo keydown (prima che arrivi il primo keyup)
    stub.dispatchEvent(createKeyboardEvent('Escape', 'keydown'), 'capture');
    expect(stub.getListenerCount('keyup', true)).toBe(1); // Ancora solo uno
    expect(onEscape).toHaveBeenCalledTimes(2);

    cleanup();
  });
});
