import type { FilmCatalogEntry } from '../../../domain';

interface RankedSuggestion {
  entry: FilmCatalogEntry;
  tier: number;
  matchIndex: number;
  lengthDelta: number;
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeLookup(value: string): string {
  return normalizeLabel(value).toLowerCase();
}

function isAlphaNumeric(char: string): boolean {
  return /[a-z0-9]/i.test(char);
}

function findWordStartMatchIndex(haystack: string, needle: string): number {
  let fromIndex = 0;

  while (fromIndex < haystack.length) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index === -1) {
      return -1;
    }

    if (index === 0 || !isAlphaNumeric(haystack.charAt(index - 1))) {
      return index;
    }

    fromIndex = index + 1;
  }

  return -1;
}

function findOrderedSubsequenceStart(haystack: string, needle: string): number {
  let cursor = 0;
  let firstMatch = -1;

  for (let index = 0; index < needle.length; index += 1) {
    const nextIndex = haystack.indexOf(needle.charAt(index), cursor);
    if (nextIndex === -1) {
      return -1;
    }

    if (firstMatch === -1) {
      firstMatch = nextIndex;
    }

    cursor = nextIndex + 1;
  }

  return firstMatch;
}

function getRankedSuggestion(
  entry: FilmCatalogEntry,
  normalizedQuery: string
): RankedSuggestion | null {
  const normalizedFilmName = normalizeLookup(entry.filmName);
  if (!normalizedFilmName) {
    return null;
  }

  if (normalizedFilmName.startsWith(normalizedQuery)) {
    return {
      entry,
      tier: 0,
      matchIndex: 0,
      lengthDelta: Math.abs(normalizedFilmName.length - normalizedQuery.length)
    };
  }

  const wordStartIndex = findWordStartMatchIndex(normalizedFilmName, normalizedQuery);
  if (wordStartIndex >= 0) {
    return {
      entry,
      tier: 1,
      matchIndex: wordStartIndex,
      lengthDelta: Math.abs(normalizedFilmName.length - normalizedQuery.length)
    };
  }

  const containsIndex = normalizedFilmName.indexOf(normalizedQuery);
  if (containsIndex >= 0) {
    return {
      entry,
      tier: 2,
      matchIndex: containsIndex,
      lengthDelta: Math.abs(normalizedFilmName.length - normalizedQuery.length)
    };
  }

  const subsequenceStart = findOrderedSubsequenceStart(normalizedFilmName, normalizedQuery);
  if (subsequenceStart >= 0) {
    return {
      entry,
      tier: 3,
      matchIndex: subsequenceStart,
      lengthDelta: Math.abs(normalizedFilmName.length - normalizedQuery.length)
    };
  }

  return null;
}

function dedupeCatalogEntries(entries: FilmCatalogEntry[]): FilmCatalogEntry[] {
  const dedupedByKey: Record<string, FilmCatalogEntry> = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const normalizedManufacturer = normalizeLookup(entry.manufacturer);
    const normalizedFilmName = normalizeLookup(entry.filmName);

    if (!normalizedFilmName) {
      continue;
    }

    dedupedByKey[`${normalizedManufacturer}|${normalizedFilmName}`] = {
      filmKey: entry.filmKey,
      manufacturer: normalizeLabel(entry.manufacturer),
      filmName: normalizeLabel(entry.filmName),
      updatedAt: entry.updatedAt
    };
  }

  return Object.values(dedupedByKey);
}

function compareAlphabeticalByFilmName(left: FilmCatalogEntry, right: FilmCatalogEntry): number {
  const leftFilmName = normalizeLookup(left.filmName);
  const rightFilmName = normalizeLookup(right.filmName);
  if (leftFilmName < rightFilmName) {
    return -1;
  }

  if (leftFilmName > rightFilmName) {
    return 1;
  }

  const leftManufacturer = normalizeLookup(left.manufacturer);
  const rightManufacturer = normalizeLookup(right.manufacturer);

  if (leftManufacturer < rightManufacturer) {
    return -1;
  }

  if (leftManufacturer > rightManufacturer) {
    return 1;
  }

  return 0;
}

export function getFilmNameSuggestions(
  entries: FilmCatalogEntry[] | undefined,
  manufacturer: string,
  query: string,
  limit = 3
): FilmCatalogEntry[] {
  if (!entries || entries.length === 0) {
    return [];
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }

  const normalizedQuery = normalizeLookup(query);
  if (!normalizedQuery) {
    return [];
  }

  const dedupedEntries = dedupeCatalogEntries(entries);
  const normalizedManufacturer = normalizeLookup(manufacturer);
  const hasExactManufacturerMatch =
    normalizedManufacturer !== '' &&
    dedupedEntries.some((entry) => normalizeLookup(entry.manufacturer) === normalizedManufacturer);
  const scopedEntries = hasExactManufacturerMatch
    ? dedupedEntries.filter((entry) => normalizeLookup(entry.manufacturer) === normalizedManufacturer)
    : dedupedEntries;

  const ranked = scopedEntries
    .map((entry) => getRankedSuggestion(entry, normalizedQuery))
    .filter((entry): entry is RankedSuggestion => entry !== null);

  ranked.sort((left, right) => {
    if (left.tier !== right.tier) {
      return left.tier - right.tier;
    }

    if (left.matchIndex !== right.matchIndex) {
      return left.matchIndex - right.matchIndex;
    }

    if (left.lengthDelta !== right.lengthDelta) {
      return left.lengthDelta - right.lengthDelta;
    }

    return compareAlphabeticalByFilmName(left.entry, right.entry);
  });

  return ranked.slice(0, limit).map((entry) => entry.entry);
}
