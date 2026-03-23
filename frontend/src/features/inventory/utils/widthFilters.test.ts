import { describe, expect, it } from 'vitest';
import {
  applyCustomWidth,
  getActiveCustomWidth,
  matchesSelectedWidths,
  normalizeSelectedWidths,
  readSelectedWidths,
  removeCustomWidth,
  togglePresetWidth,
  writeSelectedWidths
} from './widthFilters';

describe('widthFilters', () => {
  it('normalizes, dedupes, and keeps widths in stable chip order', () => {
    expect(normalizeSelectedWidths(['48', '36', '72.5', '48', '60'])).toEqual([
      '36',
      '48',
      '60',
      '72.5'
    ]);
  });

  it('reads and writes repeated width params in stable order', () => {
    const searchParams = new URLSearchParams('width=48&width=36&width=72.5&width=36');

    expect(readSelectedWidths(searchParams)).toEqual(['36', '48', '72.5']);

    const nextParams = new URLSearchParams('warehouse=IL1');
    writeSelectedWidths(nextParams, ['48', '36', '72.5']);

    expect(nextParams.toString()).toBe('warehouse=IL1&width=36&width=48&width=72.5');
  });

  it('toggles preset widths on and off', () => {
    const activated = togglePresetWidth([], '48');
    const deactivated = togglePresetWidth(activated, '48');

    expect(activated).toEqual(['48']);
    expect(deactivated).toEqual([]);
  });

  it('adds a custom width without dropping active preset widths', () => {
    const nextSelection = applyCustomWidth(['36', '48'], '72.5');

    expect(nextSelection).toEqual({
      widths: ['36', '48', '72.5'],
      rememberedCustomWidth: '72.5'
    });
    expect(getActiveCustomWidth(nextSelection.widths)).toBe('72.5');
  });

  it('normalizes custom widths that match presets into the preset chip', () => {
    const nextSelection = applyCustomWidth(['48'], '36.0');

    expect(nextSelection).toEqual({
      widths: ['36', '48'],
      rememberedCustomWidth: ''
    });
  });

  it('removes only the active custom width when toggled off', () => {
    expect(removeCustomWidth(['36', '48', '72.5'])).toEqual(['36', '48']);
  });

  it('matches widths numerically and treats no selected widths as all widths', () => {
    expect(matchesSelectedWidths(48, ['48.0', '72'])).toBe(true);
    expect(matchesSelectedWidths('72.5', ['48', '72.5'])).toBe(true);
    expect(matchesSelectedWidths(60, ['48', '72.5'])).toBe(false);
    expect(matchesSelectedWidths(60, ['', 'bad-value'])).toBe(true);
  });
});
