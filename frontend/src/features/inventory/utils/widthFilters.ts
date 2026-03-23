import { STANDARD_WIDTH_OPTIONS } from './boxHelpers';

const STANDARD_WIDTH_SET = new Set<string>(STANDARD_WIDTH_OPTIONS);

export function normalizeWidthToken(value: unknown): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return '';
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return '';
  }

  return String(parsed);
}

export function isStandardWidthToken(value: string): boolean {
  return STANDARD_WIDTH_SET.has(value);
}

export function normalizeSelectedWidths(values: readonly unknown[]): string[] {
  const selectedStandardWidths = new Set<string>();
  let selectedCustomWidth = '';

  for (const value of values) {
    const normalizedWidth = normalizeWidthToken(value);
    if (!normalizedWidth) {
      continue;
    }

    if (isStandardWidthToken(normalizedWidth)) {
      selectedStandardWidths.add(normalizedWidth);
      continue;
    }

    if (!selectedCustomWidth) {
      selectedCustomWidth = normalizedWidth;
    }
  }

  const orderedStandardWidths = STANDARD_WIDTH_OPTIONS.filter((value) =>
    selectedStandardWidths.has(value)
  );

  return selectedCustomWidth
    ? [...orderedStandardWidths, selectedCustomWidth]
    : orderedStandardWidths;
}

export function readSelectedWidths(searchParams: URLSearchParams, key = 'width'): string[] {
  return normalizeSelectedWidths(searchParams.getAll(key));
}

export function writeSelectedWidths(
  searchParams: URLSearchParams,
  widths: readonly unknown[],
  key = 'width'
) {
  searchParams.delete(key);

  for (const width of normalizeSelectedWidths(widths)) {
    searchParams.append(key, width);
  }
}

export function getActiveCustomWidth(widths: readonly unknown[]): string {
  return normalizeSelectedWidths(widths).find((value) => !isStandardWidthToken(value)) || '';
}

export function togglePresetWidth(widths: readonly unknown[], presetWidth: string): string[] {
  const normalizedPresetWidth = normalizeWidthToken(presetWidth);
  if (!isStandardWidthToken(normalizedPresetWidth)) {
    return normalizeSelectedWidths(widths);
  }

  const normalizedWidths = normalizeSelectedWidths(widths);
  if (normalizedWidths.includes(normalizedPresetWidth)) {
    return normalizedWidths.filter((value) => value !== normalizedPresetWidth);
  }

  return normalizeSelectedWidths([...normalizedWidths, normalizedPresetWidth]);
}

export function removeCustomWidth(widths: readonly unknown[]): string[] {
  return normalizeSelectedWidths(widths).filter((value) => isStandardWidthToken(value));
}

export function applyCustomWidth(widths: readonly unknown[], nextCustomWidth: unknown) {
  const normalizedCustomWidth = normalizeWidthToken(nextCustomWidth);
  const widthsWithoutCustom = removeCustomWidth(widths);

  if (!normalizedCustomWidth) {
    return {
      widths: widthsWithoutCustom,
      rememberedCustomWidth: ''
    };
  }

  if (isStandardWidthToken(normalizedCustomWidth)) {
    return {
      widths: normalizeSelectedWidths([...widthsWithoutCustom, normalizedCustomWidth]),
      rememberedCustomWidth: ''
    };
  }

  return {
    widths: normalizeSelectedWidths([...widthsWithoutCustom, normalizedCustomWidth]),
    rememberedCustomWidth: normalizedCustomWidth
  };
}

export function matchesSelectedWidths(widthIn: unknown, selectedWidths: readonly unknown[]): boolean {
  const normalizedSelectedWidths = normalizeSelectedWidths(selectedWidths);
  if (!normalizedSelectedWidths.length) {
    return true;
  }

  const normalizedWidth = normalizeWidthToken(widthIn);
  if (!normalizedWidth) {
    return false;
  }

  return normalizedSelectedWidths.includes(normalizedWidth);
}
