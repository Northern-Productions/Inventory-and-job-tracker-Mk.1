import { describe, expect, it } from 'vitest';
import {
  hasFilmOrdersNeedingAttention,
  hasFilmOrderInstallDate,
  isFilmOrderNeedingAttention
} from './filmOrders';

describe('filmOrders helpers', () => {
  it('treats unresolved film orders with an install date as needing attention', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FILM_ORDER',
        jobDate: '2026-04-13'
      })
    ).toBe(true);
  });

  it('does not treat unresolved film orders without an install date as needing attention', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FILM_ON_THE_WAY',
        jobDate: ''
      })
    ).toBe(false);
    expect(
      hasFilmOrderInstallDate({
        jobDate: '   '
      })
    ).toBe(false);
  });

  it('ignores resolved film orders even when they still have an install date', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FULFILLED',
        jobDate: '2026-04-13'
      })
    ).toBe(false);
    expect(
      hasFilmOrdersNeedingAttention([
        {
          status: 'CANCELLED',
          jobDate: '2026-04-13'
        }
      ])
    ).toBe(false);
  });
});
