// app/components/Shipping/option-cost.test.ts
//
// Le parti pure della modale dei costi per opzione: come si mostra il costo
// indicativo, come si controllano i valori scritti dal merchant, quali
// etichette vede nell'editor delle fasce.

import { describe, it, expect } from 'vitest';
import {
  formatIndicativeOptionCost,
  validateOptionBrackets,
  parseOptionBrackets,
  bracketEditorLabels,
  validateCostField,
  costFieldErrorWhileTyping,
  initialOptionBrackets,
  DEFAULT_OPTION_BRACKET,
  optionCostCell,
  isCarrierCalculated,
  formatIndicativeZoneCost,
} from './option-cost';
import { validateBrackets } from './brackets';
import { it as italiano } from '~/lib/i18n/it';
import { en as inglese } from '~/lib/i18n/en';

describe('formatIndicativeOptionCost', () => {
  it('flat: single rate with null range', () => {
    const rates = [{ from: null, to: null, cost: 5.5 }];
    expect(formatIndicativeOptionCost('flat', rates, 'EUR', 'it')).toBe('€ 5,50');
  });

  it('linear: single rate with null range, shows per kg', () => {
    const rates = [{ from: null, to: null, cost: 2.3 }];
    expect(formatIndicativeOptionCost('linear', rates, 'EUR', 'it')).toBe('€ 2,30/kg');
  });

  it('weight_brackets: shows min-max range', () => {
    const rates = [
      { from: 0, to: 1, cost: 3 },
      { from: 1, to: 5, cost: 6 },
      { from: 5, to: null, cost: 10 },
    ];
    expect(formatIndicativeOptionCost('weight_brackets', rates, 'EUR', 'it')).toBe('€ 3,00 – € 10,00');
  });

  it('value_brackets: shows min-max range in currency', () => {
    const rates = [
      { from: 0, to: 50, cost: 5 },
      { from: 50, to: 100, cost: 3 },
      { from: 100, to: null, cost: 0 },
    ];
    expect(formatIndicativeOptionCost('value_brackets', rates, 'EUR', 'it')).toBe('€ 0,00 – € 5,00');
  });

  it('empty rates: returns dash', () => {
    expect(formatIndicativeOptionCost('flat', [], 'EUR', 'it')).toBe('—');
  });

  it('weight_brackets with single rate: shows that cost', () => {
    const rates = [{ from: 0, to: null, cost: 7.5 }];
    expect(formatIndicativeOptionCost('weight_brackets', rates, 'EUR', 'it')).toBe('€ 7,50');
  });
});

describe('validateOptionBrackets', () => {
  it('weight_brackets: valid contiguous from 0', () => {
    const brackets = [
      { from: 0, to: 1, cost: 5 },
      { from: 1, to: 5, cost: 8 },
      { from: 5, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('weight_brackets', brackets)).toBeNull();
  });

  it('value_brackets: valid contiguous from 0', () => {
    const brackets = [
      { from: 0, to: 50, cost: 5 },
      { from: 50, to: 100, cost: 3 },
      { from: 100, to: null, cost: 0 },
    ];
    expect(validateOptionBrackets('value_brackets', brackets)).toBeNull();
  });

  it('flat/linear: skips bracket validation', () => {
    // Il fisso e il costo al kg non hanno fasce: non c'e' niente da controllare
    expect(validateOptionBrackets('flat', [])).toBeNull();
    expect(validateOptionBrackets('linear', [])).toBeNull();
  });

  it('brackets: rejects empty list', () => {
    expect(validateOptionBrackets('weight_brackets', [])).toBe('shipping.errors.atLeastOneBracket');
  });

  it('brackets: rejects first not starting at 0', () => {
    const brackets = [
      { from: 1, to: 5, cost: 8 },
      { from: 5, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('weight_brackets', brackets)).toBe('shipping.errors.firstBracketMustStartAtZero');
  });

  it('brackets: rejects gap', () => {
    const brackets = [
      { from: 0, to: 1, cost: 5 },
      { from: 2, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('value_brackets', brackets)).toBe('shipping.errors.bracketsHaveGaps');
  });

  it('brackets: rejects overlap', () => {
    const brackets = [
      { from: 0, to: 2, cost: 5 },
      { from: 1, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('weight_brackets', brackets)).toBe('shipping.errors.bracketsOverlap');
  });

  it('brackets: rejects negative cost', () => {
    const brackets = [
      { from: 0, to: 1, cost: -5 },
      { from: 1, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('weight_brackets', brackets)).toBe('shipping.errors.costMustBeNonNegative');
  });

  it('brackets: rejects non-last unlimited', () => {
    const brackets = [
      { from: 0, to: null, cost: 5 },
      { from: 1, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('value_brackets', brackets)).toBe('shipping.errors.onlyLastBracketCanBeUnlimited');
  });

  it('brackets: rejects from > to', () => {
    const brackets = [
      { from: 0, to: 1, cost: 5 },
      { from: 5, to: 2, cost: 8 },
    ];
    expect(validateOptionBrackets('weight_brackets', brackets)).toBe('shipping.errors.weightFromGreaterThanWeightTo');
  });
});

describe('parseOptionBrackets', () => {
  it('parses valid JSON', () => {
    const json = '[{"from":0,"to":1,"cost":5},{"from":1,"to":null,"cost":10}]';
    const result = parseOptionBrackets('weight_brackets', json);
    expect(result.error).toBeNull();
    expect(result.brackets).toEqual([
      { from: 0, to: 1, cost: 5 },
      { from: 1, to: null, cost: 10 },
    ]);
  });

  it('rejects malformed JSON', () => {
    const result = parseOptionBrackets('weight_brackets', 'not json');
    expect(result.error).toBe('shipping.errors.invalidBrackets');
    expect(result.brackets).toBeNull();
  });

  it('rejects invalid brackets', () => {
    const json = '[{"from":1,"to":null,"cost":5}]'; // doesn't start at 0
    const result = parseOptionBrackets('value_brackets', json);
    expect(result.error).toBe('shipping.errors.firstBracketMustStartAtZero');
  });

  it('rejects non-array', () => {
    const result = parseOptionBrackets('weight_brackets', '{}');
    expect(result.error).toBe('shipping.errors.invalidBrackets');
  });

  it('rejects wrong shape', () => {
    const json = '[{"x":0,"y":1,"z":5}]';
    const result = parseOptionBrackets('weight_brackets', json);
    expect(result.error).toBe('shipping.errors.invalidBrackets');
  });
});

describe('validateOptionBrackets: stesse regole delle fasce di zona', () => {
  // Una sola fonte per le regole: ogni esito deve coincidere con quello di
  // validateBrackets sulle stesse fasce espresse in kg.
  const casi: unknown[] = [
    [],
    [{ from: 0, to: null, cost: 5 }],
    [{ from: 0, to: 1, cost: 5 }, { from: 1, to: null, cost: 8 }],
    [{ from: 1, to: null, cost: 5 }],
    [{ from: 0, to: 1, cost: 5 }, { from: 2, to: null, cost: 8 }],
    [{ from: 0, to: 2, cost: 5 }, { from: 1, to: null, cost: 8 }],
    [{ from: 0, to: null, cost: 5 }, { from: 1, to: null, cost: 8 }],
    [{ from: 0, to: 1, cost: -1 }],
    [{ from: 3, to: 1, cost: 1 }],
    [{ from: '0', to: null, cost: 5 }],
    [{ from: 0, to: null, cost: Infinity }],
    [null],
    'non una lista',
  ];
  for (const caso of casi) {
    it(`coincide con validateBrackets: ${JSON.stringify(caso)}`, () => {
      const inKg = Array.isArray(caso)
        ? caso.map((b) =>
            typeof b === 'object' && b !== null
              ? { weightFromKg: (b as Record<string, unknown>).from, weightToKg: (b as Record<string, unknown>).to, cost: (b as Record<string, unknown>).cost }
              : b,
          )
        : caso;
      expect(validateOptionBrackets('value_brackets', caso)).toBe(validateBrackets(inKg));
    });
  }
});

describe('bracketEditorLabels', () => {
  it('fasce di valore: importi nella valuta, non kg', () => {
    const l = bracketEditorLabels('value_brackets', italiano);
    expect(l.from).toBe(italiano.shipping.optionModal.bracketValueFrom);
    expect(l.to).toBe(italiano.shipping.optionModal.bracketValueTo);
    expect(l.from).not.toMatch(/kg/);
    expect(l.to).not.toMatch(/kg/);
    expect(l.cost).toBe(italiano.shipping.optionModal.bracketCost);
    expect(l.unlimited).toBe(italiano.shipping.optionModal.bracketUnlimited);
    expect(l.help).toBe(italiano.shipping.optionModal.valueBracketsHelp);
    expect(l.rangeStep).toBe(0.01);
  });

  it('fasce di peso: kg', () => {
    const l = bracketEditorLabels('weight_brackets', italiano);
    expect(l.from).toBe(italiano.shipping.optionModal.bracketWeightFrom);
    expect(l.to).toBe(italiano.shipping.optionModal.bracketWeightTo);
    expect(l.help).toBe(italiano.shipping.optionModal.weightBracketsHelp);
    expect(l.rangeStep).toBe(0.1);
  });

  it('in inglese le etichette arrivano dal dizionario inglese', () => {
    expect(bracketEditorLabels('value_brackets', inglese).from).toBe('From (€)');
    expect(bracketEditorLabels('weight_brackets', inglese).from).toBe('From (kg)');
  });
});

describe('errori delle fasce senza unita', () => {
  // Gli stessi errori valgono per fasce di peso e di valore: un "0 kg" davanti
  // a fasce in euro confonde il merchant.
  const chiavi = ['firstBracketMustStartAtZero', 'atLeastOneBracket', 'weightFromGreaterThanWeightTo'] as const;
  for (const dizionario of [italiano, inglese]) {
    for (const chiave of chiavi) {
      it(`${chiave} non cita kg o peso`, () => {
        expect(dizionario.shipping.errors[chiave]).not.toMatch(/kg|peso|weight/i);
      });
    }
  }
});

describe('validateCostField', () => {
  it('costo fisso non valido: errore dedicato al costo fisso', () => {
    expect(validateCostField('flat', 'abc')).toBe('shipping.errors.invalidFlatCost');
    expect(validateCostField('flat', '-1')).toBe('shipping.errors.invalidFlatCost');
    expect(validateCostField('flat', '')).toBe('shipping.errors.invalidFlatCost');
  });

  it('costo al kg non valido: errore del costo al kg', () => {
    expect(validateCostField('linear', 'abc')).toBe('shipping.errors.invalidLinearCost');
    expect(validateCostField('linear', '')).toBe('shipping.errors.invalidLinearCost');
  });

  it('valori validi, zero compreso', () => {
    expect(validateCostField('flat', '0')).toBeNull();
    expect(validateCostField('flat', '4.9')).toBeNull();
    expect(validateCostField('linear', '1.25')).toBeNull();
  });
});

describe('costFieldErrorWhileTyping', () => {
  it('un valore corretto dopo uno sbagliato toglie l errore', () => {
    expect(costFieldErrorWhileTyping('flat', '-2')).toBe('shipping.errors.invalidFlatCost');
    expect(costFieldErrorWhileTyping('flat', '2')).toBeNull();
  });

  it('il campo vuoto mentre si scrive non e ancora un errore', () => {
    expect(costFieldErrorWhileTyping('linear', '')).toBeNull();
  });
});

describe('initialOptionBrackets', () => {
  it('opzione a fasce: le fasce ordinate per inizio', () => {
    const rates = [
      { id: 'b', from: 5, to: null, cost: 9 },
      { id: 'a', from: 0, to: 5, cost: 4 },
    ];
    expect(initialOptionBrackets({ costType: 'weight_brackets', rates })).toEqual([
      { from: 0, to: 5, cost: 4 },
      { from: 5, to: null, cost: 9 },
    ]);
  });

  it('non riordina le fasce ricevute', () => {
    const rates = [
      { id: 'b', from: 5, to: null, cost: 9 },
      { id: 'a', from: 0, to: 5, cost: 4 },
    ];
    initialOptionBrackets({ costType: 'value_brackets', rates });
    expect(rates.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('opzione fissa o al kg: la stessa fascia di partenza che mostra l editor', () => {
    const rates = [{ id: 'x', from: null, to: null, cost: 7 }];
    expect(initialOptionBrackets({ costType: 'flat', rates })).toEqual([DEFAULT_OPTION_BRACKET]);
    expect(initialOptionBrackets({ costType: 'linear', rates })).toEqual([DEFAULT_OPTION_BRACKET]);
  });

  it('opzione a fasce senza fasce: la fascia di partenza, non una lista vuota', () => {
    expect(initialOptionBrackets({ costType: 'weight_brackets', rates: [] })).toEqual([DEFAULT_OPTION_BRACKET]);
  });

  it('la fascia di partenza supera la validazione, cosi Salva funziona subito', () => {
    expect(validateOptionBrackets('weight_brackets', [DEFAULT_OPTION_BRACKET])).toBeNull();
  });
});

describe('optionCostCell: cosa mostra la tabella nella colonna del costo', () => {
  const rates = [{ from: null, to: null, cost: 0 }];

  it("opzione importata e mai salvata: 'da compilare', non 0,00 €", () => {
    expect(optionCostCell({ costType: 'flat', confirmed: false, rates }, 'EUR', 'it')).toEqual({ toFill: true });
  });

  it('opzione salvata: il costo formattato, anche se zero', () => {
    expect(optionCostCell({ costType: 'flat', confirmed: true, rates }, 'EUR', 'it')).toEqual({
      toFill: false,
      text: formatIndicativeOptionCost('flat', rates, 'EUR', 'it'),
    });
    expect(formatIndicativeOptionCost('flat', rates, 'EUR', 'it')).toMatch(/0,00/);
  });

  it('opzione salvata a fasce: intervallo come prima', () => {
    const fasce = [
      { from: 0, to: 2, cost: 5 },
      { from: 2, to: null, cost: 8 },
    ];
    expect(optionCostCell({ costType: 'weight_brackets', confirmed: true, rates: fasce }, 'EUR', 'it')).toEqual({
      toFill: false,
      text: formatIndicativeOptionCost('weight_brackets', fasce, 'EUR', 'it'),
    });
  });

  it('le etichette esistono in italiano e in inglese', () => {
    expect(italiano.shipping.table.toFill).toBe('Da compilare');
    expect(inglese.shipping.table.toFill).toBe('To fill in');
    expect(italiano.shipping.table.carrierNameHelp.length).toBeGreaterThan(0);
    expect(inglese.shipping.table.carrierNameHelp.length).toBeGreaterThan(0);
  });
});

describe('isCarrierCalculated', () => {
  it('tariffa calcolata dal corriere o da un app', () => {
    expect(isCarrierCalculated('DeliveryParticipant')).toBe(true);
  });

  it('tariffe impostate nel negozio o tipo sconosciuto', () => {
    expect(isCarrierCalculated('DeliveryRateDefinition')).toBe(false);
    expect(isCarrierCalculated('DeliveryRateDefinition:TOTAL_WEIGHT')).toBe(false);
    expect(isCarrierCalculated(null)).toBe(false);
  });
});

describe('costo per pacco spedito', () => {
  const uno = [{ from: null, to: null, cost: 4.9 }];

  it('costo indicativo: "€ 4,90/pacco", in inglese "/package"', () => {
    expect(formatIndicativeOptionCost('per_package', uno, 'EUR', 'it')).toBe('€\u00a04,90/pacco');
    expect(formatIndicativeOptionCost('per_package', uno, 'EUR', 'en')).toBe('€\u00a04.90/package');
  });

  it('senza tariffe: il trattino, come gli altri tipi', () => {
    expect(formatIndicativeOptionCost('per_package', [], 'EUR', 'it')).toBe('—');
  });

  it('il campo del costo si controlla come fisso e al kg, con il suo errore', () => {
    expect(validateCostField('per_package', '4.9')).toBeNull();
    expect(validateCostField('per_package', '0')).toBeNull();
    expect(validateCostField('per_package', '-1')).toBe('shipping.errors.invalidPerPackageCost');
    expect(validateCostField('per_package', 'abc')).toBe('shipping.errors.invalidPerPackageCost');
    expect(validateCostField('per_package', '')).toBe('shipping.errors.invalidPerPackageCost');
    expect(costFieldErrorWhileTyping('per_package', '')).toBeNull();
    expect(costFieldErrorWhileTyping('per_package', '-3')).toBe('shipping.errors.invalidPerPackageCost');
  });

  it('niente fasce da leggere o controllare', () => {
    expect(validateOptionBrackets('per_package', [])).toBeNull();
    expect(parseOptionBrackets('per_package', undefined)).toEqual({ brackets: [], error: null });
    expect(initialOptionBrackets({ costType: 'per_package', rates: [{ from: null, to: null, cost: 3 }] })).toEqual([
      DEFAULT_OPTION_BRACKET,
    ]);
  });

  it('il messaggio d\'errore esiste in entrambe le lingue', () => {
    expect(italiano.shipping.errors.invalidPerPackageCost).toMatch(/pacco/);
    expect(inglese.shipping.errors.invalidPerPackageCost).toMatch(/package/);
  });
});

describe('formatIndicativeZoneCost: la tariffa generica nella tabella', () => {
  const zona = (rateType: 'linear' | 'brackets' | 'per_package', costs: number[]) => ({
    rateType,
    rates: costs.map((cost) => ({ cost })),
  });

  it('per pacco: "€ 4,90/pacco"', () => {
    expect(formatIndicativeZoneCost(zona('per_package', [4.9]), italiano, 'it')).toBe('€\u00a04,90/pacco');
    expect(formatIndicativeZoneCost(zona('per_package', [4.9]), inglese, 'en')).toBe('€\u00a04.90/package');
  });

  it('i tipi di prima restano come erano', () => {
    expect(formatIndicativeZoneCost(zona('linear', [1.2]), italiano, 'it')).toBe('€\u00a01,20/kg');
    expect(formatIndicativeZoneCost(zona('brackets', [5, 8]), italiano, 'it')).toBe('€\u00a05 – €\u00a08');
    expect(formatIndicativeZoneCost(zona('brackets', [5, 5]), italiano, 'it')).toBe('€\u00a05');
    expect(formatIndicativeZoneCost(zona('per_package', []), italiano, 'it')).toBe('—');
  });
});
