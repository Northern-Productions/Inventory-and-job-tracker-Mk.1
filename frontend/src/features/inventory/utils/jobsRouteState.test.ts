import { describe, expect, it } from 'vitest';
import {
  getDefaultJobsRouteState,
  patchJobsRouteState,
  readJobsRouteState,
  writeJobsRouteState
} from './jobsRouteState';

const WAREHOUSES = [
  { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
  { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
];

const OPTIONS = {
  defaultWarehouse: 'IL1',
  warehouseEntries: WAREHOUSES,
  warehouseRegistrySettled: true,
  today: '2026-07-25'
};

describe('jobsRouteState', () => {
  it('keeps inactive List and Calendar state while ordinary view changes use one URL', () => {
    const state = readJobsRouteState(
      new URLSearchParams(
        'view=list&lifecycle=completed&warehouse=MS1&q=00123&sort=ready&calendarView=month&date=2026-09-17'
      ),
      OPTIONS
    );
    const calendarState = patchJobsRouteState(state, { view: 'calendar' });

    expect(writeJobsRouteState(calendarState, OPTIONS).toString()).toBe(
      'lifecycle=completed&warehouse=MS1&q=00123&sort=ready&calendarView=month&date=2026-09-17'
    );
  });

  it('retains valid pending warehouse syntax and scrubs it after registry settlement', () => {
    const pending = readJobsRouteState(new URLSearchParams('warehouse=MI1'), {
      ...OPTIONS,
      warehouseEntries: [],
      warehouseRegistrySettled: false
    });
    const settled = readJobsRouteState(new URLSearchParams('warehouse=MI1'), OPTIONS);

    expect(pending.warehouse).toBe('MI1');
    expect(writeJobsRouteState(pending, OPTIONS).get('warehouse')).toBe('MI1');
    expect(settled.warehouse).toBe('IL1');
    expect(writeJobsRouteState(settled, OPTIONS).toString()).toBe('');
  });

  it('defines bare allocations as the complete Jobs default state', () => {
    const defaults = getDefaultJobsRouteState(OPTIONS);
    const dirty = {
      ...defaults,
      view: 'list' as const,
      workflow: 'completed' as const,
      search: '123',
      sort: 'film_order' as const,
      calendarView: 'month' as const,
      calendarDate: '2026-10-01'
    };

    expect(writeJobsRouteState(defaults, OPTIONS).toString()).toBe('');
    expect(writeJobsRouteState(dirty, OPTIONS).toString()).not.toBe('');
    expect(readJobsRouteState(new URLSearchParams(), OPTIONS)).toEqual(defaults);
  });
});
