import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const darkThemeVariables =
  css.match(/:root\[data-theme="dark"\]\s*{(?<body>[\s\S]*?)\n}/)?.groups?.body ?? '';

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
    expect(darkThemeVariables).toMatch(/--color-segmented-inactive-bg:\s*transparent/);
    expect(darkThemeVariables).toMatch(/--color-segmented-inactive-text:\s*#fff8e8/);
    expect(darkThemeVariables).toMatch(/--color-segmented-inactive-hover-bg:\s*transparent/);
    expect(darkThemeVariables).toMatch(/--color-segmented-inactive-hover-text:\s*#fff0d3/);
    expect(css).toMatch(
      /\.inventory-view-toggle-button\s*{[^}]*background:\s*var\(--color-segmented-inactive-bg\);[^}]*color:\s*var\(--color-segmented-inactive-text\);/s
    );
    expect(css).toMatch(
      /\.inventory-view-toggle-button:hover:not\(:disabled\)\s*{[^}]*background:\s*var\(--color-segmented-inactive-hover-bg\);[^}]*color:\s*var\(--color-segmented-inactive-hover-text\);/s
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

  it('keeps Film Orders filters separated from the table content', () => {
    expect(css).toMatch(/\.film-orders-filters\s*{[^}]*margin-bottom:\s*1rem;/s);
  });

  it('keeps Add Box intro copy and warehouse selector in a responsive two-column layout', () => {
    expect(css).toMatch(
      /\.add-box-hero-layout\s*{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(15rem,\s*18rem\);/s
    );
    expect(css).toMatch(
      /\.add-box-warehouse-control\s*{[^}]*justify-self:\s*end;[^}]*width:\s*100%;/s
    );
    expect(css).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*\.add-box-hero-layout\s*{[^}]*grid-template-columns:\s*1fr;/s
    );
  });

  it('keeps the job editor dialog sections and sticky footer theme-aware', () => {
    expect(css).toMatch(
      /\.dialog-job-editor \.dialog-section\s*{[^}]*background:\s*var\(--color-surface-1\);[^}]*color:\s*var\(--color-text-1\);/s
    );
    expect(css).toMatch(
      /\.job-editor-requirement-builder\s*{[^}]*background:\s*var\(--color-surface-3\);/s
    );
    expect(css).toMatch(
      /\.dialog-job-editor \.dialog-actions-sticky-footer\s*{[^}]*bottom:\s*0;[^}]*background:\s*var\(--color-menu-bg\);/s
    );
  });

  it('keeps Phase Details grouped into two clean input rows', () => {
    expect(css).toMatch(
      /\.dialog-job-editor \.job-editor-selected-phase-fields\s*{[^}]*grid-template-areas:\s*"phase-number work-scope work-scope"\s*"install-date install-end crew-leader";/s
    );
    expect(css).toMatch(
      /@media \(max-width:\s*900px\)\s*{[\s\S]*\.dialog-job-editor \.job-editor-selected-phase-fields\s*{[^}]*grid-template-areas:\s*"phase-number"\s*"work-scope"\s*"install-date"\s*"install-end"\s*"crew-leader";/s
    );
  });

  it('keeps Film Requirements builder grouped into two clean input rows', () => {
    expect(css).toMatch(
      /\.job-editor-film-requirement-builder\s*{[^}]*grid-template-areas:\s*"manufacturer film-name"\s*"width required-feet";/s
    );
    expect(css).toMatch(
      /\.job-editor-film-requirement-builder--custom-manufacturer\s*{[^}]*grid-template-areas:\s*"manufacturer film-name"\s*"new-manufacturer new-manufacturer"\s*"width required-feet";/s
    );
    expect(css).toMatch(
      /@media \(max-width:\s*900px\)\s*{[\s\S]*\.dialog-job-editor \.job-editor-film-requirement-builder\s*{[^}]*grid-template-areas:\s*"manufacturer"\s*"film-name"\s*"width"\s*"required-feet";/s
    );
    expect(css).toMatch(
      /@media \(max-width:\s*900px\)\s*{[\s\S]*\.dialog-job-editor \.job-editor-film-requirement-builder--custom-manufacturer\s*{[^}]*grid-template-areas:\s*"manufacturer"\s*"film-name"\s*"new-manufacturer"\s*"width"\s*"required-feet";/s
    );
  });

  it('keeps selected width chips dark-filled with light text across width selectors', () => {
    expect(css).toMatch(
      /\.width-chip-active\s*{[^}]*background:\s*linear-gradient\(180deg,\s*var\(--color-primary-strong\) 0%,\s*var\(--color-primary\) 100%\);[^}]*color:\s*var\(--color-primary-contrast\);/s
    );
    expect(css).toMatch(
      /\.width-chip-active:focus-visible\s*{[^}]*box-shadow:\s*var\(--focus-ring\),/s
    );
    expect(css).not.toMatch(
      /\.button-primary,[\s\S]*?\.width-chip-active,[\s\S]*?\.label-result-button-selected/
    );
  });

  it('uses soft status color variables and lively motion for toast variants', () => {
    expect(css).toMatch(
      /\.toast\s*{[^}]*animation:\s*toast-pop-in 520ms[\s\S]*toast-radiate 2600ms/s
    );
    expect(css).toMatch(/\.toast-success\s*{[^}]*--toast-bg:\s*#effaf4;[^}]*--toast-glow:/s);
    expect(css).toMatch(/\.toast-error\s*{[^}]*--toast-bg:\s*#fff0ef;[^}]*--toast-glow:/s);
    expect(css).toMatch(/\.toast-warning\s*{[^}]*--toast-bg:\s*#fff7ec;[^}]*--toast-glow:/s);
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\.toast-success\s*{[^}]*--toast-text:\s*#e4ffec;/s);
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\.toast-error\s*{[^}]*--toast-text:\s*#ffe4de;/s);
  });

  it('respects reduced-motion preferences for toast animation', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*\.toast\s*{[^}]*animation:\s*toast-fade-in 120ms ease-out both;[\s\S]*\.toast-exit\s*{[^}]*animation:\s*none;/s
    );
  });

  it('uses a sticky desktop nav instead of compact header selectors', () => {
    expect(css).toMatch(
      /\.app-header-nav-wrap\s*{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*width:\s*auto;[^}]*margin:\s*0 calc\(50% - 50vw\) 1rem;[^}]*padding:\s*calc\(0\.45rem \+ env\(safe-area-inset-top\)\) var\(--app-shell-inline-padding\) 0\.6rem;[^}]*background:\s*var\(--color-header-pinned-bg\);/s
    );
    expect(css).not.toMatch(/\.app-header-desktop\.app-header-pinned/);
    expect(css).not.toMatch(/\.app-header-desktop\.app-header-compact/);
  });

  it('has representative dark-theme contrast above WCAG normal-text threshold', () => {
    expect(contrastRatio('#12343b', '#fff0d3')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#fff8e8', '#12343b')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#fff0d3', '#12343b')).toBeGreaterThanOrEqual(4.5);
  });
});
