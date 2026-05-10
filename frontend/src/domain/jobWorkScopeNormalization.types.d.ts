declare module './jobWorkScopeNormalization.mjs' {
  export const BLANK_WORK_SCOPE_KEY: 'blank:';

  export function normalizeJobWorkScopeDisplay(value: unknown): string | null;
  export function normalizeJobWorkScopeKey(value: unknown): string;
  export function normalizeJobSectionsDisplay(value: unknown): string | null;
  export function normalizeJobSectionsKey(value: unknown): string;
}
