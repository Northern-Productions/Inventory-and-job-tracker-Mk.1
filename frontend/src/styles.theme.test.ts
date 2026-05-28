import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function luminance(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function hexToRgb(hex: string) {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16)
  };
}

function contrastRatio(foreground: string, background: string) {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  const fgLum =
    0.2126 * luminance(fg.r) +
    0.7152 * luminance(fg.g) +
    0.0722 * luminance(fg.b);
  const bgLum =
    0.2126 * luminance(bg.r) +
    0.7152 * luminance(bg.g) +
    0.0722 * luminance(bg.b);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('theme contrast styles', () => {
  it('keeps shared segmented controls readable in dark theme', () => {
    expect(css).toMatch(/--color-segmented-inactive-bg:\s*#071d22/);
    expect(css).toMatch(/--color-segmented-inactive-text:\s*#fff8e8/);
    expect(css).toMatch(/--color-segmented-inactive-hover-bg:\s*#173f47/);
    expect(css).toMatch(
      /\.inventory-view-toggle-button\s*{[^}]*background:\s*var\(--color-segmented-inactive-bg\);[^}]*color:\s*var\(--color-segmented-inactive-text\);/s
    );
    expect(css).toMatch(
      /\.inventory-view-toggle-button:hover:not\(:disabled\)\s*{[^}]*background:\s*var\(--color-segmented-inactive-hover-bg\);[^}]*color:\s*var\(--color-segmented-inactive-text\);/s
    );
  });

  it('keeps autocomplete suggestion popovers on theme-aware surfaces', () => {
    expect(css).toMatch(
      /\.film-name-autocomplete-menu\s*{[^}]*border:\s*1px solid var\(--color-border-strong\);[^}]*background:\s*var\(--color-surface-raised\);[^}]*color:\s*var\(--color-text-1\);/s
    );
    expect(css).toMatch(
      /\.film-name-autocomplete-option\s*{[^}]*color:\s*var\(--color-text-1\);/s
    );
    expect(css).toMatch(/\.film-name-autocomplete-option small\s*{[^}]*color:\s*var\(--color-text-2\);/s);
    expect(css).toMatch(
      /\.film-name-autocomplete-option:hover,\s*\.film-name-autocomplete-option-active\s*{[^}]*background:\s*var\(--color-control-bg-hover\);[^}]*color:\s*var\(--color-text-1\);/s
    );
  });

  it('has representative dark-theme contrast above WCAG normal-text threshold', () => {
    expect(contrastRatio('#12343b', '#fff0d3')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#fff8e8', '#071d22')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#fff8e8', '#173f47')).toBeGreaterThanOrEqual(4.5);
  });
});
