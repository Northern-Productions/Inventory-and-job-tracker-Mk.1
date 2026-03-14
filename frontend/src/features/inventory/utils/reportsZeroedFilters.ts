import type { ZeroedBoxRow } from '../../../domain';

export interface ZeroedBoxesFilters {
  manufacturer: string;
  q: string;
  width: string;
}

function normalizeText(value: unknown): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeLookup(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function parseWidth(value: unknown): number | null {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesManufacturer(row: ZeroedBoxRow, manufacturer: string): boolean {
  const target = normalizeLookup(manufacturer);
  if (!target) {
    return true;
  }
  return normalizeLookup(row.manufacturer) === target;
}

function matchesSearchQuery(row: ZeroedBoxRow, query: string): boolean {
  const normalizedQuery = normalizeLookup(query);
  if (!normalizedQuery) {
    return true;
  }
  const haystack = normalizeLookup([row.boxId, row.manufacturer, row.filmName].join(' '));
  return haystack.includes(normalizedQuery);
}

function matchesWidth(row: ZeroedBoxRow, width: string): boolean {
  const targetWidth = parseWidth(width);
  if (targetWidth === null) {
    return true;
  }
  const rowWidth = parseWidth(row.widthIn);
  if (rowWidth === null) {
    return false;
  }
  return rowWidth === targetWidth;
}

function compareZeroedRows(left: ZeroedBoxRow, right: ZeroedBoxRow): number {
  if (left.zeroedDate !== right.zeroedDate) {
    return left.zeroedDate > right.zeroedDate ? -1 : 1;
  }
  return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
}

export function filterZeroedBoxes(rows: ZeroedBoxRow[], filters: ZeroedBoxesFilters): ZeroedBoxRow[] {
  const source = Array.isArray(rows) ? rows : [];
  const filtered = source.filter((row) => {
    if (!matchesManufacturer(row, filters.manufacturer)) {
      return false;
    }
    if (!matchesSearchQuery(row, filters.q)) {
      return false;
    }
    if (!matchesWidth(row, filters.width)) {
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
    const normalized = normalizeText(value);
    if (!normalized) {
      return;
    }
    const key = normalizeLookup(normalized);
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
