import { describe, it, expect } from 'vitest';
import {
  parseDate,
  detectFormat,
  decide,
  toMerchantDate,
  type DateFormat,
  type ParsedDate,
  type Decision,
} from './values';

describe('parseDate', () => {
  describe('empty values', () => {
    it('returns empty for null', () => {
      expect(parseDate(null, 'auto')).toEqual({ ok: false, reason: 'empty' });
    });

    it('returns empty for empty string', () => {
      expect(parseDate('', 'auto')).toEqual({ ok: false, reason: 'empty' });
    });

    it('returns empty for whitespace-only string', () => {
      expect(parseDate('   ', 'auto')).toEqual({ ok: false, reason: 'empty' });
    });

    it('returns empty for undefined', () => {
      expect(parseDate(undefined, 'auto')).toEqual({ ok: false, reason: 'empty' });
    });
  });

  describe('ISO format (always ok)', () => {
    it('parses YYYY-MM-DD', () => {
      expect(parseDate('1990-12-25', 'auto')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });

    it('parses YYYY-MM-DDTHH:mm:ss', () => {
      expect(parseDate('1990-12-25T14:30:00', 'auto')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });

    it('parses YYYY-MM-DDTHH:mm:ss.sssZ', () => {
      expect(parseDate('1990-12-25T14:30:00.000Z', 'auto')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });
  });

  describe('DMY format', () => {
    it('parses DD/MM/YYYY', () => {
      expect(parseDate('25/12/1990', 'DMY')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });

    it('parses DD-MM-YYYY', () => {
      expect(parseDate('25-12-1990', 'DMY')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });

    it('parses DD.MM.YYYY', () => {
      expect(parseDate('25.12.1990', 'DMY')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });
  });

  describe('MDY format', () => {
    it('parses MM/DD/YYYY', () => {
      expect(parseDate('12/25/1990', 'MDY')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });

    it('parses MM-DD-YYYY', () => {
      expect(parseDate('12-25-1990', 'MDY')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });

    it('parses MM.DD.YYYY', () => {
      expect(parseDate('12.25.1990', 'MDY')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });
  });

  describe('YMD format', () => {
    it('parses YYYY/MM/DD', () => {
      expect(parseDate('1990/12/25', 'YMD')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });

    it('parses YYYY-MM-DD (same as ISO)', () => {
      expect(parseDate('1990-12-25', 'YMD')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });

    it('parses YYYY.MM.DD', () => {
      expect(parseDate('1990.12.25', 'YMD')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });
  });

  describe('auto format detection', () => {
    it('returns ambiguous when both numbers are ≤12 and different', () => {
      expect(parseDate('03/04/1985', 'auto')).toEqual({
        ok: false,
        reason: 'ambiguous',
      });
    });

    it('deduces DMY when first number >12', () => {
      expect(parseDate('25/12/1990', 'auto')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });

    it('deduces MDY when second number >12', () => {
      expect(parseDate('12/25/1990', 'auto')).toEqual({
        ok: true,
        date: '1990-12-25',
      });
    });

    it('deduces format when both numbers are same', () => {
      expect(parseDate('05/05/1990', 'auto')).toEqual({
        ok: true,
        date: '1990-05-05',
      });
    });
  });

  describe('invalid dates', () => {
    it('returns invalid for 2-digit year', () => {
      expect(parseDate('25/12/90', 'DMY')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('returns invalid for impossible date (30 Feb)', () => {
      expect(parseDate('30/02/1990', 'DMY')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('returns invalid for year < 1900', () => {
      expect(parseDate('1899-12-25', 'auto')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('returns invalid for future year', () => {
      const futureYear = new Date().getFullYear() + 1;
      expect(parseDate(`${futureYear}-12-25`, 'auto')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('returns invalid for numbers', () => {
      expect(parseDate(12345, 'auto')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('returns invalid for objects', () => {
      expect(parseDate({ date: '1990-12-25' }, 'auto')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('returns invalid for malformed strings', () => {
      expect(parseDate('not a date', 'auto')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('returns invalid for month > 12', () => {
      expect(parseDate('1990-13-25', 'auto')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('returns invalid for day > 31', () => {
      expect(parseDate('1990-12-32', 'auto')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });
  });
});

describe('detectFormat', () => {
  it('detects DMY when samples are unambiguous', () => {
    expect(detectFormat(['25/12/1990', '03/04/1985'])).toEqual({
      format: 'DMY',
      ambiguous: false,
    });
  });

  it('returns ambiguous when single sample could be either', () => {
    expect(detectFormat(['03/04/1985'])).toEqual({
      format: 'auto',
      ambiguous: true,
    });
  });

  it('detects MDY when samples are unambiguous', () => {
    expect(detectFormat(['12/25/1990', '01/15/1985'])).toEqual({
      format: 'MDY',
      ambiguous: false,
    });
  });

  it('returns ambiguous when all samples are ambiguous', () => {
    expect(detectFormat(['03/04/1985', '05/06/1990'])).toEqual({
      format: 'auto',
      ambiguous: true,
    });
  });

  it('detects format when at least one sample is unambiguous', () => {
    expect(detectFormat(['03/04/1985', '25/12/1990'])).toEqual({
      format: 'DMY',
      ambiguous: false,
    });
  });

  it('handles ISO format samples', () => {
    expect(detectFormat(['1990-12-25', '1985-04-03'])).toEqual({
      format: 'YMD',
      ambiguous: false,
    });
  });

  it('handles empty samples array', () => {
    expect(detectFormat([])).toEqual({
      format: 'auto',
      ambiguous: true,
    });
  });

  it('handles null/undefined values in samples', () => {
    expect(detectFormat([null, '25/12/1990', undefined])).toEqual({
      format: 'DMY',
      ambiguous: false,
    });
  });
});

describe('decide', () => {
  it('returns fill when ours is null', () => {
    expect(decide(null, '1990-01-02', null)).toBe('fill');
  });

  it('returns fill when ours is empty string', () => {
    expect(decide('', '1990-01-02', null)).toBe('fill');
  });

  it('returns same when values are equal', () => {
    expect(decide('1990-01-01', '1990-01-01', null)).toBe('same');
  });

  it('returns decided when prior is kept_ours and theirValue matches', () => {
    expect(
      decide('1990-01-01', '1990-01-02', {
        status: 'kept_ours',
        theirValue: '1990-01-02',
      })
    ).toBe('decided');
  });

  it('returns decided when prior is used_theirs and theirValue matches', () => {
    expect(
      decide('1990-01-01', '1990-01-02', {
        status: 'used_theirs',
        theirValue: '1990-01-02',
      })
    ).toBe('decided');
  });

  it('returns conflict when prior is kept_ours but theirValue changed', () => {
    expect(
      decide('1990-01-01', '1990-01-03', {
        status: 'kept_ours',
        theirValue: '1990-01-02',
      })
    ).toBe('conflict');
  });

  it('returns conflict when prior is used_theirs but theirValue changed', () => {
    expect(
      decide('1990-01-01', '1990-01-03', {
        status: 'used_theirs',
        theirValue: '1990-01-02',
      })
    ).toBe('conflict');
  });

  it('returns conflict when prior is open and values differ', () => {
    expect(
      decide('1990-01-01', '1990-01-02', {
        status: 'open',
        theirValue: '1990-01-02',
      })
    ).toBe('conflict');
  });

  it('returns conflict when no prior and values differ', () => {
    expect(decide('1990-01-01', '1990-01-02', null)).toBe('conflict');
  });

  it('returns same when prior is open and values are equal', () => {
    expect(
      decide('1990-01-01', '1990-01-01', {
        status: 'open',
        theirValue: '1990-01-01',
      })
    ).toBe('same');
  });
});

describe('toMerchantDate', () => {
  it('converts YYYY-MM-DD to YYYYMMDD', () => {
    expect(toMerchantDate('1990-12-25')).toBe('19901225');
  });

  it('converts YYYY-M-D to YYYYMMDD with padding', () => {
    expect(toMerchantDate('1990-1-5')).toBe('19900105');
  });

  it('handles dates with leading zeros', () => {
    expect(toMerchantDate('1990-01-05')).toBe('19900105');
  });
});
