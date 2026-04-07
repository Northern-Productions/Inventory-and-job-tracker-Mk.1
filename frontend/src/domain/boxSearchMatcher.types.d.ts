declare module './boxSearchMatcher.mjs' {
  export interface BoxSearchCandidate {
    boxId?: string | null;
    manufacturer?: string | null;
    filmName?: string | null;
    lotRun?: string | null;
    filmKey?: string | null;
  }

  export type BoxSearchField = 'boxId' | 'filmName' | 'filmKey' | 'lotRun' | 'manufacturer';
  export type BoxSearchMatchKind = 'exact' | 'prefix' | 'contains' | 'subsequence';
  export type BoxSearchMatchVariant = 'readable' | 'compact';

  export interface BoxSearchMatch {
    field: BoxSearchField;
    fieldIndex: number;
    kind: BoxSearchMatchKind;
    position: number;
    compactLengthDelta: number;
    variant: BoxSearchMatchVariant;
    wordStart: boolean;
  }

  export function normalizeBoxSearchReadable(value: unknown): string;
  export function normalizeBoxSearchCompact(value: unknown): string;
  export function compareBoxSearchMatches(left: BoxSearchMatch, right: BoxSearchMatch): number;
  export function getBoxSearchMatch(
    candidate: BoxSearchCandidate,
    query: string | { readable?: string | null; compact?: string | null }
  ): BoxSearchMatch | null;
  export function matchesBoxSearchQuery(candidate: BoxSearchCandidate, query: string): boolean;
  export function rankBoxSearchCandidates<T extends BoxSearchCandidate>(candidates: readonly T[], query: string): T[];
}
