// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearNavigationSessionRecords,
  createDetailNavigationState,
  getNavigationScope,
  getPendingListPosition,
  hasValidDetailNavigationState,
  LIST_ROUTE_KINDS,
  markListReturnPending,
  saveListPosition
} from './navigationSession';

describe('navigationSession', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    clearNavigationSessionRecords();
  });

  it('keeps provenance scoped to one authenticated user and organization without storing raw scope values', () => {
    const firstScope = getNavigationScope('user-alpha', 'org-alpha');
    expect(firstScope).not.toBeNull();

    saveListPosition(firstScope, LIST_ROUTE_KINDS.INVENTORY, 'origin-key', {
      scrollY: 420,
      anchorToken: 'opaque-anchor',
      anchorOffset: 12
    });
    markListReturnPending(firstScope, LIST_ROUTE_KINDS.INVENTORY, 'origin-key');
    const detailState = createDetailNavigationState(
      firstScope,
      LIST_ROUTE_KINDS.INVENTORY,
      'origin-key'
    );

    expect(
      hasValidDetailNavigationState(
        detailState,
        firstScope,
        LIST_ROUTE_KINDS.INVENTORY
      )
    ).toBe(true);

    const storedValues = Array.from(
      { length: window.sessionStorage.length },
      (_, index) => window.sessionStorage.getItem(window.sessionStorage.key(index) || '') || ''
    ).join('');
    expect(storedValues).not.toContain('user-alpha');
    expect(storedValues).not.toContain('org-alpha');

    const nextScope = getNavigationScope('user-beta', 'org-beta');
    expect(
      hasValidDetailNavigationState(
        detailState,
        nextScope,
        LIST_ROUTE_KINDS.INVENTORY
      )
    ).toBe(false);
    expect(
      getPendingListPosition(
        nextScope,
        LIST_ROUTE_KINDS.INVENTORY,
        'origin-key'
      )
    ).toBeNull();
  });

  it('keeps Jobs List and Calendar restoration records independent', () => {
    const scope = getNavigationScope('user-one', 'org-one');
    saveListPosition(scope, LIST_ROUTE_KINDS.JOBS_LIST, 'list-key', {
      scrollY: 120,
      anchorToken: '',
      anchorOffset: 0
    });
    saveListPosition(scope, LIST_ROUTE_KINDS.JOBS_CALENDAR, 'calendar-key', {
      scrollY: 640,
      anchorToken: '',
      anchorOffset: 0
    });
    markListReturnPending(scope, LIST_ROUTE_KINDS.JOBS_LIST, 'list-key');
    markListReturnPending(scope, LIST_ROUTE_KINDS.JOBS_CALENDAR, 'calendar-key');

    clearNavigationSessionRecords(LIST_ROUTE_KINDS.JOBS_LIST);

    expect(
      getPendingListPosition(scope, LIST_ROUTE_KINDS.JOBS_LIST, 'list-key')
    ).toBeNull();
    expect(
      getPendingListPosition(
        scope,
        LIST_ROUTE_KINDS.JOBS_CALENDAR,
        'calendar-key'
      )?.scrollY
    ).toBe(640);
  });
});
