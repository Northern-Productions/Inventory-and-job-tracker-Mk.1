import { describe, expect, it } from 'vitest';
import type { ZeroedBoxRow } from '../../../domain';
import { buildZeroedManufacturerOptions, filterZeroedBoxes } from './reportsZeroedFilters';

function row(overrides: Partial<ZeroedBoxRow> & Pick<ZeroedBoxRow, 'boxId'>): ZeroedBoxRow {
  return {
    boxId: overrides.boxId,
    warehouse: overrides.warehouse || 'IL1',
    manufacturer: overrides.manufacturer || 'Llumar',
    filmName: overrides.filmName || 'V33',
    widthIn: overrides.widthIn ?? 72,
    zeroedDate: overrides.zeroedDate || '2026-01-01'
  };
}

describe('filterZeroedBoxes', () => {
  it('matches search query across box id, manufacturer, and film name', () => {
    const rows = [
      row({ boxId: 'Z-1001', manufacturer: 'Llumar', filmName: 'V33' }),
      row({ boxId: 'Z-2002', manufacturer: 'Madico', filmName: 'Optivision' }),
      row({ boxId: 'Z-3003', manufacturer: '3M', filmName: 'Prestige' })
    ];

    expect(
      filterZeroedBoxes(rows, {
        manufacturer: '',
        q: '2002',
        widths: []
      }).map((entry) => entry.boxId)
    ).toEqual(['Z-2002']);

    expect(
      filterZeroedBoxes(rows, {
        manufacturer: '',
        q: 'madico',
        widths: []
      }).map((entry) => entry.boxId)
    ).toEqual(['Z-2002']);

    expect(
      filterZeroedBoxes(rows, {
        manufacturer: '',
        q: 'prestige',
        widths: []
      }).map((entry) => entry.boxId)
    ).toEqual(['Z-3003']);
  });

  it('filters by normalized manufacturer exact match', () => {
    const rows = [
      row({ boxId: 'Z-1001', manufacturer: 'Llumar' }),
      row({ boxId: 'Z-2002', manufacturer: 'Madico' }),
      row({ boxId: 'Z-3003', manufacturer: 'llumar' })
    ];

    const filtered = filterZeroedBoxes(rows, {
      manufacturer: '  LLUMAR ',
      q: '',
      widths: []
    });

    expect(filtered.map((entry) => entry.boxId)).toEqual(['Z-1001', 'Z-3003']);
  });

  it('matches legacy manufacturer aliases to canonical rows', () => {
    const rows = [
      row({ boxId: 'Z-1001', manufacturer: 'Solar Gard' }),
      row({ boxId: 'Z-2002', manufacturer: 'Llumar' })
    ];

    const filtered = filterZeroedBoxes(rows, {
      manufacturer: 'Solar Guard',
      q: '',
      widths: []
    });

    expect(filtered.map((entry) => entry.boxId)).toEqual(['Z-1001']);
  });

  it('supports custom width filtering', () => {
    const rows = [
      row({ boxId: 'Z-1001', widthIn: 72 }),
      row({ boxId: 'Z-2002', widthIn: 72.5 }),
      row({ boxId: 'Z-3003', widthIn: 60 })
    ];

    const filtered = filterZeroedBoxes(rows, {
      manufacturer: '',
      q: '',
      widths: ['72.5']
    });

    expect(filtered.map((entry) => entry.boxId)).toEqual(['Z-2002']);
  });

  it('matches any selected width and treats no selected widths as all widths', () => {
    const rows = [
      row({ boxId: 'Z-1001', widthIn: 36 }),
      row({ boxId: 'Z-2002', widthIn: 48 }),
      row({ boxId: 'Z-3003', widthIn: 60 })
    ];

    const multiWidth = filterZeroedBoxes(rows, {
      manufacturer: '',
      q: '',
      widths: ['48', '36', '48']
    });
    const allWidths = filterZeroedBoxes(rows, {
      manufacturer: '',
      q: '',
      widths: []
    });

    expect(multiWidth.map((entry) => entry.boxId)).toEqual(['Z-1001', 'Z-2002']);
    expect(allWidths.map((entry) => entry.boxId)).toEqual(['Z-1001', 'Z-2002', 'Z-3003']);
  });

  it('sorts by zeroed date newest-first with box id tie-breaker', () => {
    const rows = [
      row({ boxId: 'Z-3003', zeroedDate: '2026-02-01' }),
      row({ boxId: 'Z-1001', zeroedDate: '2026-03-01' }),
      row({ boxId: 'Z-2002', zeroedDate: '2026-03-01' })
    ];

    const filtered = filterZeroedBoxes(rows, {
      manufacturer: '',
      q: '',
      widths: []
    });

    expect(filtered.map((entry) => entry.boxId)).toEqual(['Z-1001', 'Z-2002', 'Z-3003']);
  });
});

describe('buildZeroedManufacturerOptions', () => {
  it('dedupes and preserves selected manufacturer values', () => {
    const rows = [
      row({ boxId: 'Z-1001', manufacturer: 'Llumar' }),
      row({ boxId: 'Z-2002', manufacturer: 'madico' })
    ];

    const options = buildZeroedManufacturerOptions(rows, ['Madico'], 'SunTek');

    expect(options).toEqual(['Llumar', 'Madico', 'SunTek']);
  });

  it('rewrites legacy aliases to canonical labels', () => {
    const rows = [row({ boxId: 'Z-3003', manufacturer: 'Solar Guard' })];
    const options = buildZeroedManufacturerOptions(rows, ['Avery', '3M']);

    expect(options).toEqual(['3M Solar', 'Avery Dennison', 'Solar Gard']);
  });
});
