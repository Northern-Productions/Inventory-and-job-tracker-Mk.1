declare module './runtimeContract.mjs' {
  export type FeatureArea =
    | 'inventory'
    | 'allocations'
    | 'jobs'
    | 'film_orders'
    | 'activity_history'
    | 'reports'
    | 'access_management'
    | 'team_management';

  export type AccessMode = 'read' | 'write';

  export const FEATURE_AREAS: readonly FeatureArea[];
  export const BOX_STATUSES: readonly ['ORDERED', 'IN_STOCK', 'CHECKED_OUT', 'TRANSFER', 'ZEROED', 'RETIRED'];
  export const FILM_ORDER_STATUSES: readonly ['FILM_ORDER', 'FILM_ON_THE_WAY', 'FULFILLED', 'CANCELLED'];
  export const JOB_STATUSES: readonly ['READY', 'ORDERED', 'FILM_ORDER', 'NEEDS_ALLOCATION', 'COMPLETED', 'CANCELLED'];
  export const ALLOCATION_JOB_STATUSES: readonly ['READY', 'ORDERED', 'FILM_ORDER', 'NEEDS_ALLOCATION', 'COMPLETED', 'CANCELLED'];
  export const ALLOCATION_SOURCES: readonly ['MANUAL', 'AUTO_PLANNED', 'FILM_ORDER_RECEIPT', 'DIRECT_TO_JOB_SITE'];
  export const WAREHOUSE_CODE_PATTERN: RegExp;
  export const ROUTE_FEATURE_MAP: Readonly<Record<string, FeatureArea>>;
  export const READ_PATHS: readonly string[];
  export const OWNER_ONLY_ROUTES: readonly string[];
  export function isReadRoute(logicalPath: string): boolean;
  export function isOwnerOnlyRoute(logicalPath: string): boolean;
  export function inferFeatureForRoute(logicalPath: string): FeatureArea | '';
  export function inferAccessModeForRoute(method: string, logicalPath: string): AccessMode;
}
