import { describe, expect, it } from 'vitest';
import {
  patchInventoryRouteState,
  readInventoryRouteState,
  writeInventoryRouteState
} from './inventoryRouteState';

const WAREHOUSES = [
  { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
  { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
];

describe('inventoryRouteState', () => {
  it('retains a syntactically valid warehouse while the authorized registry is pending', () => {
    const params = new URLSearchParams('warehouse=MI1&q=visible%20typing');
    const state = readInventoryRouteState(params, {
      defaultWarehouse: 'IL1',
      warehouseEntries: [],
      warehouseRegistrySettled: false
    });

    expect(state.filters.warehouse).toBe('MI1');
    expect(writeInventoryRouteState(state, { defaultWarehouse: 'IL1' }).toString()).toBe(
      'warehouse=MI1&q=visible+typing'
    );
  });

  it('scrubs an unauthorized warehouse only after registry resolution', () => {
    const state = readInventoryRouteState(new URLSearchParams('warehouse=MI1&q=123'), {
      defaultWarehouse: 'IL1',
      warehouseEntries: WAREHOUSES,
      warehouseRegistrySettled: true
    });

    expect(state.filters.warehouse).toBe('IL1');
    expect(writeInventoryRouteState(state, { defaultWarehouse: 'IL1' }).toString()).toBe(
      'q=123'
    );
  });

  it('preserves visible search text immediately and serializes canonical filter order', () => {
    const initial = readInventoryRouteState(new URLSearchParams(), {
      defaultWarehouse: 'IL1',
      warehouseEntries: WAREHOUSES,
      warehouseRegistrySettled: true
    });
    const next = patchInventoryRouteState(initial, {
      inventoryView: 'caulk',
      filters: {
        warehouse: '',
        manufacturer: '3M',
        status: 'IN_STOCK',
        q: '  live search  ',
        widths: ['60', '48']
      }
    });

    expect(writeInventoryRouteState(next, { defaultWarehouse: 'IL1' }).toString()).toBe(
      'inventoryView=caulk&warehouse=ALL&manufacturer=3M+Solar&status=IN_STOCK&q=++live+search++&width=48&width=60'
    );
  });

  it('restores the latest visible search value when a refresh interrupts typing', () => {
    const initial = readInventoryRouteState(new URLSearchParams(), {
      defaultWarehouse: 'IL1',
      warehouseEntries: WAREHOUSES,
      warehouseRegistrySettled: true
    });
    const typed = patchInventoryRouteState(initial, {
      filters: { q: 'matte 2080' }
    });
    const visibleUrl = writeInventoryRouteState(typed, {
      defaultWarehouse: 'IL1'
    });
    const refreshed = readInventoryRouteState(visibleUrl, {
      defaultWarehouse: 'IL1',
      warehouseEntries: WAREHOUSES,
      warehouseRegistrySettled: true
    });

    expect(refreshed.filters.q).toBe('matte 2080');
  });
});
