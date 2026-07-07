import { describe, expect, it } from 'vitest';
import {
  ALL_WAREHOUSES_OPTION_VALUE,
  buildWarehouseCreateDraft,
  formatWarehouseDisplayLabel,
  getNextWarehouseCodeForState,
  getSafeSpecificWarehouseValue,
  getSafeWarehouseFilterValue,
  getWarehousePrefix,
  isValidWarehouseStateCode,
  normalizeWarehouseCity,
  normalizeWarehouseStateCode,
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
      { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
      { code: 'CA1', name: 'California #1', boxIdPrefix: 'CA1' }
    ];

    expect(toWarehouseSelectOptions(entries)).toEqual([
      { label: 'Wauconda IL1', value: 'IL1' },
      { label: 'California #1 CA1', value: 'CA1' }
    ]);

    expect(toWarehouseFilterSelectOptions(entries)).toEqual([
      { label: 'All Warehouses', value: ALL_WAREHOUSES_OPTION_VALUE },
      { label: 'Wauconda IL1', value: 'IL1' },
      { label: 'California #1 CA1', value: 'CA1' }
    ]);
  });

  it('formats warehouse labels as city/name plus code without parentheses', () => {
    expect(formatWarehouseDisplayLabel({ code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' }))
      .toBe('Auburn Hills MI1');
    expect(formatWarehouseDisplayLabel({ code: 'MI1', name: 'Auburn Hills MI1', boxIdPrefix: 'MI1' }))
      .toBe('Auburn Hills MI1');
    expect(formatWarehouseDisplayLabel({ code: 'MO1', name: 'St. Louis MO1', boxIdPrefix: 'MO1' }))
      .toBe('St. Louis MO1');
    expect(formatWarehouseDisplayLabel({ code: 'CA1', name: '', boxIdPrefix: 'CA1' }))
      .toBe('CA1');
  });

  it('generates the next state-number warehouse code from active org entries', () => {
    const entries = [
      { code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' },
      { code: 'MI2', name: 'Auburn Hills MI2', boxIdPrefix: 'MI2' },
      { code: 'MO1', name: 'St. Louis MO1', boxIdPrefix: 'MO1' }
    ];

    expect(getNextWarehouseCodeForState([], 'MI')).toBe('MI1');
    expect(getNextWarehouseCodeForState(entries, 'mi')).toBe('MI3');
    expect(getNextWarehouseCodeForState(entries, 'MO')).toBe('MO2');
    expect(getNextWarehouseCodeForState(entries, 'M')).toBe('');
  });

  it('normalizes city/state inputs and builds generated warehouse create drafts', () => {
    const entries = [{ code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' }];

    expect(normalizeWarehouseCity('  St. Louis  ')).toBe('St. Louis');
    expect(normalizeWarehouseStateCode(' mi ')).toBe('MI');
    expect(isValidWarehouseStateCode('MI')).toBe(true);
    expect(isValidWarehouseStateCode('M1')).toBe(false);
    expect(buildWarehouseCreateDraft(entries, '  Auburn Hills  ', 'mi')).toEqual({
      city: 'Auburn Hills',
      stateCode: 'MI',
      code: 'MI2',
      name: 'Auburn Hills MI2',
      boxIdPrefix: 'MI2',
      label: 'Auburn Hills MI2'
    });
  });

  it('accepts only warehouses present in the active registry', () => {
    const internalEntries = [
      { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
      { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
    ];
    const michiganEntries = [
      { code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' }
    ];

    expect(getSafeWarehouseFilterValue(internalEntries, 'MI1')).toBe('');
    expect(getSafeSpecificWarehouseValue(internalEntries, 'MI1')).toBe('');
    expect(getSafeWarehouseFilterValue(michiganEntries, 'MI1')).toBe('MI1');
  });

  it('normalizes warehouse codes and resolves prefixes', () => {
    const entries = [
      { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
      { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' },
      { code: 'CA1', name: 'California #1', boxIdPrefix: 'CA1' }
    ];

    expect(normalizeWarehouseCode(' ca1 ')).toBe('CA1');
    expect(normalizeWarehouseCode('1')).toBe('');
    expect(getWarehousePrefix(entries, 'CA1')).toBe('CA1');
    expect(getWarehousePrefix(entries, 'IL1')).toBe('IL1');
  });
});
