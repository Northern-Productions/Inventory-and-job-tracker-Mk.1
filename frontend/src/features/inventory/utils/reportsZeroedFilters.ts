import type { ZeroedBoxRow } from '../../../domain';
import {
  canonicalizeManufacturerLabel,
  normalizeManufacturerLookupKey
} from '../../../lib/manufacturerCanonicalization';
import { matchesSelectedWidths, normalizeSelectedWidths } from './widthFilters';

export interface ZeroedBoxesFilters {
  manufacturer: string;
  q: string;
  widths: string[];
}

function normalizeText(value: unknown): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeLookup(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function normalizeManufacturerLookup(value: unknown): string {
  return normalizeManufacturerLookupKey(normalizeText(value));
}

function matchesManufacturer(row: ZeroedBoxRow, manufacturer: string): boolean {
  const target = normalizeManufacturerLookup(manufacturer);
  if (!target) {
    return true;
  }
  return normalizeManufacturerLookup(row.manufacturer) === target;
}

function matchesSearchQuery(row: ZeroedBoxRow, query: string): boolean {
  const rawQuery = normalizeLookup(query);
  if (!rawQuery) {
    return true;
  }

  const canonicalQuery = normalizeLookup(canonicalizeManufacturerLabel(normalizeText(query)));
  const haystack = normalizeLookup([
    row.boxId,
    row.manufacturer,
    canonicalizeManufacturerLabel(row.manufacturer),
    row.filmName
  ].join(' '));
  if (haystack.includes(rawQuery)) {
    return true;
  }

  return canonicalQuery !== rawQuery ? haystack.includes(canonicalQuery) : false;
}

function matchesWidth(row: ZeroedBoxRow, normalizedWidths: string[]): boolean {
  return matchesSelectedWidths(row.widthIn, normalizedWidths);
}

function compareZeroedRows(left: ZeroedBoxRow, right: ZeroedBoxRow): number {
  if (left.zeroedDate !== right.zeroedDate) {
    return left.zeroedDate > right.zeroedDate ? -1 : 1;
  }
  return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
}

export function filterZeroedBoxes(rows: ZeroedBoxRow[], filters: ZeroedBoxesFilters): ZeroedBoxRow[] {
  const source = Array.isArray(rows) ? rows : [];
  const normalizedWidths = normalizeSelectedWidths(filters.widths);
  const filtered = source.filter((row) => {
    if (!matchesManufacturer(row, filters.manufacturer)) {
      return false;
    }
    if (!matchesSearchQuery(row, filters.q)) {
      return false;
    }
    if (!matchesWidth(row, normalizedWidths)) {
      return false;
    }
    return true;
  });

  filtered.sort(compareZeroedRows);
  return filtered;
}

export function buildZeroedManufacturerOptions(
  rows: ZeroedBoxRow[],
  knownOptions: string[] = [],
  selectedValue = ''
): string[] {
  const byKey = new Map<string, string>();

  const add = (value: string) => {
    const normalized = canonicalizeManufacturerLabel(normalizeText(value));
    if (!normalized) {
      return;
    }
    const key = normalizeManufacturerLookup(normalized);
    if (!byKey.has(key)) {
      byKey.set(key, normalized);
    }
  };

  for (let index = 0; index < knownOptions.length; index += 1) {
    add(knownOptions[index]);
  }
  for (let index = 0; index < rows.length; index += 1) {
    add(rows[index].manufacturer);
  }
  add(selectedValue);

  return Array.from(byKey.values()).sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base' })
  );
}
