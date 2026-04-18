import { describe, expect, it } from 'vitest';
import { formatJobDisplayNumber } from './jobDisplay';

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
