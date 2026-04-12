import test from 'node:test';
import assert from 'node:assert/strict';

import { isFilmOrderNeedingAttention } from '../../src/app/services/runtime/runtimeFilmOrderSchedule.mjs';

test('treats scheduled FILM_ORDER entries with remaining feet as needing attention', () => {
  assert.equal(
    isFilmOrderNeedingAttention({
      status: 'FILM_ORDER',
      remainingToOrderFeet: 24,
      installDate: '2026-04-13',
    }),
    true,
  );
});

test('does not treat unscheduled FILM_ORDER entries as needing attention', () => {
  assert.equal(
    isFilmOrderNeedingAttention({
      status: 'FILM_ORDER',
      remainingToOrderFeet: 24,
    }),
    false,
  );
});

test('does not treat FILM_ORDER entries with no remaining feet as needing attention', () => {
  assert.equal(
    isFilmOrderNeedingAttention({
      status: 'FILM_ORDER',
      remainingToOrderFeet: 0,
      installDate: '2026-04-13',
    }),
    false,
  );
});

test('ignores FILM_ON_THE_WAY and resolved statuses', () => {
  assert.equal(
    isFilmOrderNeedingAttention({
      status: 'FILM_ON_THE_WAY',
      remainingToOrderFeet: 0,
      installDate: '2026-04-13',
    }),
    false,
  );
  assert.equal(
    isFilmOrderNeedingAttention({
      status: 'FULFILLED',
      remainingToOrderFeet: 0,
      installDate: '2026-04-13',
    }),
    false,
  );
});
