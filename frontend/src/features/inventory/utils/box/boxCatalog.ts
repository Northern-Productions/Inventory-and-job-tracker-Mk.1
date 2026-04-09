import type { FilmCatalogEntry } from '../../../../domain';
import {
  canonicalizeManufacturerLabel,
  normalizeManufacturerLookupKey
} from '../../../../lib/manufacturerCanonicalization';

export { canonicalizeManufacturerLabel };

function normalizeManufacturerLabel(value: string) {
  return canonicalizeManufacturerLabel(value);
}

function normalizeManufacturerKey(value: string) {
  return normalizeManufacturerLookupKey(value);
}

function dedupeManufacturerLabels(values: string[]) {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const label = normalizeManufacturerLabel(value);
    const key = normalizeManufacturerKey(label);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(label);
  }

  return deduped;
}

function compareManufacturerLabels(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

export function getManufacturerOptions(catalogEntries?: FilmCatalogEntry[]) {
  if (!catalogEntries || catalogEntries.length === 0) {
    return [];
  }

  const catalogManufacturers: string[] = [];
  for (let index = 0; index < catalogEntries.length; index += 1) {
    const label = normalizeManufacturerLabel(catalogEntries[index].manufacturer || '');
    if (label) {
      catalogManufacturers.push(label);
    }
  }

  return dedupeManufacturerLabels(catalogManufacturers).sort(compareManufacturerLabels);
}

export function getManufacturerOptionsWithCatalog(catalogEntries?: FilmCatalogEntry[]) {
  return getManufacturerOptions(catalogEntries);
}

export function hasManufacturerOption(value: string, options: string[] = []) {
  const key = normalizeManufacturerKey(value);
  if (!key) {
    return false;
  }

  return options.some((option) => normalizeManufacturerKey(option) === key);
}

export function deriveFilmKey(manufacturer: string, filmName: string): string {
  return `${manufacturer.trim().toUpperCase()}|${filmName.trim().toUpperCase()}`;
}
