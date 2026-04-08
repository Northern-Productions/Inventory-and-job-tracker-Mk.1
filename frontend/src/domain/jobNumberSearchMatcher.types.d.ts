declare module './jobNumberSearchMatcher.mjs' {
  export type JobNumberSearchMatchKind = 'exact' | 'prefix' | 'contains';

  export interface JobNumberSearchMatch {
    kind: JobNumberSearchMatchKind;
    position: number;
    canonicalLengthDelta: number;
  }

  export interface JobNumberSearchOptions<T> {
    getValue?: (candidate: T) => unknown;
    compareWithinMatch?: (left: T, right: T) => number;
    limit?: number;
  }

  export function normalizeJobNumberSearchDigits(value: unknown): string;
  export function canonicalizeJobNumberSearchDigits(value: unknown): string;
  export function getJobNumberSearchMatch(
    candidateJobNumber: unknown,
    query: unknown
  ): JobNumberSearchMatch | null;
  export function compareJobNumberSearchMatches(
    left: JobNumberSearchMatch,
    right: JobNumberSearchMatch
  ): number;
  export function matchesJobNumberSearch(candidateJobNumber: unknown, query: unknown): boolean;
  export function rankJobNumberSearchCandidates<T>(
    candidates: readonly T[],
    query: unknown,
    options?: JobNumberSearchOptions<T>
  ): T[];
}
