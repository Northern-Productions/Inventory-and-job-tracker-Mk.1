import { describe, expect, it } from 'vitest';
import { formatDate, toDateInputValue } from './date';

describe('date helpers', () => {
  it('formats ISO calendar dates without shifting them into the prior day', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).format(new Date(2026, 1, 28));

    expect(formatDate('2026-02-28')).toBe(expected);
  });

  it('keeps ISO calendar dates unchanged for date inputs', () => {
    expect(toDateInputValue('2026-02-28')).toBe('2026-02-28');
  });
});
