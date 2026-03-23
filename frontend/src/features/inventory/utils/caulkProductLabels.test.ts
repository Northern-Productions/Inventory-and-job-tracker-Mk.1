import { describe, expect, it } from 'vitest';
import { buildCaulkProductLabel } from './caulkProductLabels';

describe('buildCaulkProductLabel', () => {
  it('removes duplicated manufacturer prefixes from product names', () => {
    expect(buildCaulkProductLabel('3M', '3M Bronze Caulk', '')).toBe('3M Bronze Caulk');
    expect(buildCaulkProductLabel('DOW', 'DOW 791 Black', '')).toBe('DOW 791 Black');
    expect(buildCaulkProductLabel('Tremco', 'Tremco Spectrum 2 Clear', '')).toBe('Tremco Spectrum 2 Clear');
  });

  it('preserves product codes after normalizing the title', () => {
    expect(buildCaulkProductLabel('DOW', 'DOW 995 Gray', 'DOW-995')).toBe('DOW 995 Gray (DOW-995)');
  });

  it('leaves already-normalized names unchanged', () => {
    expect(buildCaulkProductLabel('GE', 'SCS2003 Black', '')).toBe('GE SCS2003 Black');
  });
});
