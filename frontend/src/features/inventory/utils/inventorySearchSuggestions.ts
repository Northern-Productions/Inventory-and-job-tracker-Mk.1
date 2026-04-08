import type { Box } from '../../../domain';
import { rankBoxSearchCandidates } from '../../../domain/boxSearchMatcher.mjs';
import {
  filterOfflineBoxes,
  type OfflineSearchBoxesParams
} from '../../../lib/offlineInventory';

export interface InventorySearchSuggestion {
  suggestionKey: string;
  filmName: string;
}

function normalizeSuggestionFilmName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function getInventorySearchSuggestions(
  boxes: Box[],
  params: OfflineSearchBoxesParams,
  limit = 3
): InventorySearchSuggestion[] {
  const query = String(params.q || '').trim();
  if (!query) {
    return [];
  }

  const filteredCandidates = filterOfflineBoxes(boxes, {
    ...params,
    q: ''
  });

  const rankedBoxes = rankBoxSearchCandidates(filteredCandidates, query);
  const suggestions: InventorySearchSuggestion[] = [];
  const seenFilmNames = new Set<string>();

  for (let index = 0; index < rankedBoxes.length; index += 1) {
    const box = rankedBoxes[index];
    const normalizedFilmName = normalizeSuggestionFilmName(box.filmName);

    if (!normalizedFilmName || seenFilmNames.has(normalizedFilmName)) {
      continue;
    }

    seenFilmNames.add(normalizedFilmName);
    suggestions.push({
      suggestionKey: normalizedFilmName,
      filmName: box.filmName.trim()
    });

    if (suggestions.length >= limit) {
      break;
    }
  }

  return suggestions;
}
