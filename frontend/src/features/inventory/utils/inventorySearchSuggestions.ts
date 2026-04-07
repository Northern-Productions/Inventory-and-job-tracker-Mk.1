import type { Box } from '../../../domain';
import { rankBoxSearchCandidates } from '../../../domain/boxSearchMatcher.mjs';
import {
  filterOfflineBoxes,
  type OfflineSearchBoxesParams
} from '../../../lib/offlineInventory';

export interface InventorySearchSuggestion {
  boxId: string;
  manufacturer: string;
  filmName: string;
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

  return rankBoxSearchCandidates(filteredCandidates, query)
    .slice(0, limit)
    .map((box: Box) => ({
      boxId: box.boxId,
      manufacturer: box.manufacturer,
      filmName: box.filmName
    }));
}
