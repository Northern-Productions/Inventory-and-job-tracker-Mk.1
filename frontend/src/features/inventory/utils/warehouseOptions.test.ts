import { describe, expect, it } from 'vitest';
import {
  ALL_WAREHOUSES_OPTION_VALUE,
  getWarehousePrefix,
  normalizeWarehouseCode,
  parseWarehouseFilterValue,
  toWarehouseFilterOptionValue,
  toWarehouseFilterSelectOptions,
  toWarehouseSelectOptions
} from './warehouseOptions';

describe('warehouseOptions', () => {
  it('parses warehouse filter values with ALL and normalized codes', () => {
    expect(parseWarehouseFilterValue('ALL')).toBe('');
    expect(parseWarehouseFilterValue(' tx ')).toBe('TX');
    expect(parseWarehouseFilterValue('x')).toBe('');
  });

  it('maps warehouse filter values back to select values', () => {
    expect(toWarehouseFilterOptionValue('')).toBe(ALL_WAREHOUSES_OPTION_VALUE);
    expect(toWarehouseFilterOptionValue('TX')).toBe('TX');
  });

  it('builds select options from warehouse entries', () => {
    const entries = [
      { code: 'IL', name: 'Wauconda Illinois', boxIdPrefix: '' },
      { code: 'TX', name: 'Texas', boxIdPrefix: 'T' }
    ];

    expect(toWarehouseSelectOptions(entries)).toEqual([
      { label: 'Wauconda Illinois', value: 'IL' },
      { label: 'Texas', value: 'TX' }
    ]);

    expect(toWarehouseFilterSelectOptions(entries)).toEqual([
      { label: 'All', value: ALL_WAREHOUSES_OPTION_VALUE },
      { label: 'Wauconda Illinois', value: 'IL' },
      { label: 'Texas', value: 'TX' }
    ]);
  });

  it('normalizes warehouse codes and resolves prefixes', () => {
    const entries = [
      { code: 'IL', name: 'Wauconda Illinois', boxIdPrefix: '' },
      { code: 'MS', name: 'Ridgeland Mississippi', boxIdPrefix: 'M' },
      { code: 'TX', name: 'Texas', boxIdPrefix: 'TX-' }
    ];

    expect(normalizeWarehouseCode(' tx ')).toBe('TX');
    expect(normalizeWarehouseCode('1')).toBe('');
    expect(getWarehousePrefix(entries, 'TX')).toBe('TX-');
    expect(getWarehousePrefix(entries, 'IL')).toBe('');
  });
});
