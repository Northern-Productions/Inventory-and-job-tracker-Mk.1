import { describe, expect, it } from 'vitest';
import {
  formatFilmOrderOriginLabel,
  getFilmOrderOrigin,
  getFilmOrderOriginSourceBoxId,
  hasFilmOrdersNeedingAttention,
  hasFilmOrderInstallDate,
  isFilmOrderNeedingAttention
} from './filmOrders';

describe('filmOrders helpers', () => {
  it('treats scheduled film orders that still need ordering as needing attention', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FILM_ORDER',
        remainingToOrderFeet: 24,
        installDate: '2026-04-13'
      })
    ).toBe(true);
  });

  it('does not treat unscheduled film orders as needing attention', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FILM_ORDER',
        remainingToOrderFeet: 24
      })
    ).toBe(false);
    expect(
      hasFilmOrderInstallDate({
        installDate: '   '
      })
    ).toBe(false);
  });

  it('does not treat film that is already on the way as needing attention', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FILM_ON_THE_WAY',
        remainingToOrderFeet: 0,
        installDate: '2026-04-13'
      })
    ).toBe(false);
  });

  it('ignores resolved film orders even when they still have an install date', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FULFILLED',
        remainingToOrderFeet: 0,
        installDate: '2026-04-13'
      })
    ).toBe(false);
    expect(
      hasFilmOrdersNeedingAttention([
        {
          status: 'CANCELLED',
          remainingToOrderFeet: 0,
          installDate: '2026-04-13'
        }
      ])
    ).toBe(false);
  });

  it('does not treat zero remaining film-order shortages as needing attention', () => {
    expect(
      isFilmOrderNeedingAttention({
        status: 'FILM_ORDER',
        remainingToOrderFeet: 0,
        installDate: '2026-04-13'
      })
    ).toBe(false);
  });

  it('derives auto-shortage origin from the source box when the API payload does not spell it out', () => {
    expect(getFilmOrderOrigin({ sourceBoxId: 'IL1-6923' })).toBe('AUTO_SHORTAGE');
    expect(formatFilmOrderOriginLabel({ sourceBoxId: 'IL1-6923' })).toBe('Auto shortage');
    expect(getFilmOrderOriginSourceBoxId({ sourceBoxId: 'IL1-6923' })).toBe('IL1-6923');
  });

  it('preserves explicit manual origin and hides the source box helper text', () => {
    expect(getFilmOrderOrigin({ origin: 'MANUAL', sourceBoxId: 'IL1-6923' })).toBe('MANUAL');
    expect(formatFilmOrderOriginLabel({ origin: 'MANUAL', sourceBoxId: '' })).toBe('Manual');
    expect(getFilmOrderOriginSourceBoxId({ origin: 'MANUAL', sourceBoxId: '' })).toBe('');
  });
});
