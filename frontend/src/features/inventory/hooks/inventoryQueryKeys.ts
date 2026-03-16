import type {
  AllocateBoxPayload,
  AuditListParams,
  ReportsSummaryFilters,
  SearchBoxesParams
} from '../../../domain';

// Purpose: Centralized React Query keys for inventory feature queries/mutations.
export const inventoryKeys = {
  root: ['inventory'] as const,
  listRoot: ['inventory', 'list'] as const,
  list: (params: SearchBoxesParams) => ['inventory', 'list', params] as const,
  boxRoot: ['inventory', 'box'] as const,
  box: (boxId: string) => ['inventory', 'box', boxId] as const,
  historyRoot: ['inventory', 'history'] as const,
  history: (boxId: string) => ['inventory', 'history', boxId] as const,
  allocationsRoot: ['inventory', 'allocations'] as const,
  allocations: (boxId: string) => ['inventory', 'allocations', boxId] as const,
  jobs: ['inventory', 'jobs'] as const,
  jobsSearch: ['inventory', 'jobs-search'] as const,
  jobRoot: ['inventory', 'job'] as const,
  job: (jobNumber: string) => ['inventory', 'job', jobNumber] as const,
  allocationJobs: ['inventory', 'allocation-jobs'] as const,
  allocationJobRoot: ['inventory', 'allocation-job'] as const,
  allocationJob: (jobNumber: string) => ['inventory', 'allocation-job', jobNumber] as const,
  allocationPreview: (params: AllocateBoxPayload | null) => ['inventory', 'allocation-preview', params] as const,
  addBoxMutation: ['inventory', 'mutation', 'add-box'] as const,
  filmOrders: ['inventory', 'film-orders'] as const,
  filmCatalog: ['inventory', 'film-catalog'] as const,
  activityRoot: ['inventory', 'activity'] as const,
  activity: (params: AuditListParams) => ['inventory', 'activity', params] as const,
  rollHistory: (boxId: string) => ['inventory', 'roll-history', boxId] as const,
  reportsRoot: ['inventory', 'reports'] as const,
  reports: (filters: ReportsSummaryFilters) => ['inventory', 'reports', filters] as const
};
