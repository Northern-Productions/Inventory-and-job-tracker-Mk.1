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
    expect(parseWarehouseFilterValue(' ca1 ')).toBe('CA1');
    expect(parseWarehouseFilterValue('x')).toBe('');
  });

  it('maps warehouse filter values back to select values', () => {
    expect(toWarehouseFilterOptionValue('')).toBe(ALL_WAREHOUSES_OPTION_VALUE);
    expect(toWarehouseFilterOptionValue('CA1')).toBe('CA1');
  });

  it('builds select options from warehouse entries', () => {
    const entries = [
      { code: 'IL1', name: 'Wauconda Illinois #1', boxIdPrefix: 'IL1' },
      { code: 'CA1', name: 'California #1', boxIdPrefix: 'CA1' }
    ];

    expect(toWarehouseSelectOptions(entries)).toEqual([
      { label: 'Wauconda Illinois #1', value: 'IL1' },
      { label: 'California #1', value: 'CA1' }
    ]);

    expect(toWarehouseFilterSelectOptions(entries)).toEqual([
      { label: 'All', value: ALL_WAREHOUSES_OPTION_VALUE },
      { label: 'Wauconda Illinois #1', value: 'IL1' },
      { label: 'California #1', value: 'CA1' }
    ]);
  });

  it('normalizes warehouse codes and resolves prefixes', () => {
    const entries = [
      { code: 'IL1', name: 'Wauconda Illinois #1', boxIdPrefix: 'IL1' },
      { code: 'MS1', name: 'Ridgeland Mississippi #1', boxIdPrefix: 'MS1' },
      { code: 'CA1', name: 'California #1', boxIdPrefix: 'CA1' }
    ];

    expect(normalizeWarehouseCode(' ca1 ')).toBe('CA1');
    expect(normalizeWarehouseCode('1')).toBe('');
    expect(getWarehousePrefix(entries, 'CA1')).toBe('CA1');
    expect(getWarehousePrefix(entries, 'IL1')).toBe('IL1');
  });
});
