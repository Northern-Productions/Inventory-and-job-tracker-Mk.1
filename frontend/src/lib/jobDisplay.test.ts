import { describe, expect, it } from 'vitest';
import { formatJobDisplayLabel, formatJobDisplayNumber } from './jobDisplay';

describe('formatJobDisplayNumber', () => {
  it('returns the raw job number when warehouse is missing', () => {
    expect(formatJobDisplayNumber('2941', '')).toBe('2941');
  });

  it('prefixes the warehouse when both values are present', () => {
    expect(formatJobDisplayNumber('2941', 'il1')).toBe('IL1-2941');
  });

  it('avoids double-prefixing job numbers that already include the warehouse', () => {
    expect(formatJobDisplayNumber('IL1-2941', 'IL1')).toBe('IL1-2941');
  });
});

describe('formatJobDisplayLabel', () => {
  it('appends work scope to the formatted job number', () => {
    expect(formatJobDisplayLabel({ jobNumber: '2941', warehouse: 'il1', workScope: 'Sections 4, 5' })).toBe(
      'IL1-2941 · Sections 4, 5'
    );
  });

  it('falls back to legacy sections when work scope is missing', () => {
    expect(formatJobDisplayLabel({ jobNumber: '2941', sections: 'Section 1' })).toBe('2941 · Section 1');
  });
});
