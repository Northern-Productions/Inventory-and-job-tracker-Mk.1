import type {
  AllocateBoxPayload,
  AuditListParams,
  BoxTransferPlanParams,
  ReportsSummaryFilters,
  SearchBoxesParams
} from '../../../domain';

type JobLifecycleFilter = 'ACTIVE' | 'COMPLETED';
type JobsCalendarView = 'week' | 'month';

// Purpose: Centralized React Query keys for inventory feature queries/mutations.
export const inventoryKeys = {
  root: ['inventory'] as const,
  appAttentionSummary: ['inventory', 'app-attention-summary'] as const,
  boxDealers: ['inventory', 'box-dealers'] as const,
  listRoot: ['inventory', 'list'] as const,
  list: (params: SearchBoxesParams) => ['inventory', 'list', params] as const,
  searchRoot: ['inventory', 'search'] as const,
  boxRoot: ['inventory', 'box'] as const,
  box: (boxId: string) => ['inventory', 'box', boxId] as const,
  boxTransferRoot: ['inventory', 'box-transfer'] as const,
  boxTransfer: (boxId: string) => ['inventory', 'box-transfer', boxId] as const,
  boxTransferPlanRoot: ['inventory', 'box-transfer-plan'] as const,
  boxTransferPlan: (params: BoxTransferPlanParams | null) =>
    ['inventory', 'box-transfer-plan', params] as const,
  historyRoot: ['inventory', 'history'] as const,
  history: (boxId: string) => ['inventory', 'history', boxId] as const,
  allocationsRoot: ['inventory', 'allocations'] as const,
  allocations: (boxId: string) => ['inventory', 'allocations', boxId] as const,
  jobs: ['inventory', 'jobs'] as const,
  jobsListRoot: ['inventory', 'jobs', 'list'] as const,
  jobsList: (params: { limit: number; lifecycleStatus?: JobLifecycleFilter; jobNumbers?: string[] }) =>
    ['inventory', 'jobs', 'list', params] as const,
  jobsCalendarRoot: ['inventory', 'jobs', 'calendar'] as const,
  jobsCalendarPeriod: (params: {
    view: JobsCalendarView;
    anchorDate: string;
    lifecycleStatus?: JobLifecycleFilter;
  }) => ['inventory', 'jobs', 'calendar', params] as const,
  jobsCalendarMonth: (params: { month: string; lifecycleStatus?: JobLifecycleFilter }) =>
    ['inventory', 'jobs', 'calendar', params] as const,
  jobsSearch: ['inventory', 'jobs', 'search'] as const,
  jobsSearchResults: (params: {
    query: string;
    limit: number;
    lifecycleStatus?: JobLifecycleFilter;
  }) => ['inventory', 'jobs', 'search', params] as const,
  jobRoot: ['inventory', 'job'] as const,
  job: (jobNumber: string) => ['inventory', 'job', jobNumber] as const,
  jobByIdRoot: ['inventory', 'job-by-id'] as const,
  jobById: (jobId: string) => ['inventory', 'job-by-id', jobId] as const,
  allocationJobs: ['inventory', 'allocation-jobs'] as const,
  allocationJobRoot: ['inventory', 'allocation-job'] as const,
  allocationJob: (jobNumber: string) => ['inventory', 'allocation-job', jobNumber] as const,
  allocationPreview: (params: AllocateBoxPayload | null) => ['inventory', 'allocation-preview', params] as const,
  addBoxMutation: ['inventory', 'mutation', 'add-box'] as const,
  updateJobMutation: ['inventory', 'mutation', 'update-job'] as const,
  setJobRequirementStateMutation: ['inventory', 'mutation', 'set-job-requirement-state'] as const,
  setBoxStatusMutation: ['inventory', 'mutation', 'set-box-status'] as const,
  receiveOrderedBoxMutation: ['inventory', 'mutation', 'receive-ordered-box'] as const,
  markLabelsPrintedMutation: ['inventory', 'mutation', 'mark-labels-printed'] as const,
  addCaulkAllocationMutation: ['inventory', 'mutation', 'add-caulk-allocation'] as const,
  updateCaulkAllocationMutation: ['inventory', 'mutation', 'update-caulk-allocation'] as const,
  checkoutCaulkAllocationMutation: ['inventory', 'mutation', 'checkout-caulk-allocation'] as const,
  checkinCaulkAllocationMutation: ['inventory', 'mutation', 'checkin-caulk-allocation'] as const,
  removeCaulkAllocationMutation: ['inventory', 'mutation', 'remove-caulk-allocation'] as const,
  startBoxTransferMutation: ['inventory', 'mutation', 'start-box-transfer'] as const,
  receiveBoxTransferMutation: ['inventory', 'mutation', 'receive-box-transfer'] as const,
  cancelBoxTransferMutation: ['inventory', 'mutation', 'cancel-box-transfer'] as const,
  receiveCaulkTransferMutation: ['inventory', 'mutation', 'receive-caulk-transfer'] as const,
  cancelCaulkTransferMutation: ['inventory', 'mutation', 'cancel-caulk-transfer'] as const,
  removeJobBoxAllocationMutation: ['inventory', 'mutation', 'remove-job-box-allocation'] as const,
  clearAllocationPlannerSuppressionMutation: ['inventory', 'mutation', 'clear-allocation-planner-suppression'] as const,
  deleteFilmOrderMutation: ['inventory', 'mutation', 'delete-film-order'] as const,
  filmOrders: ['inventory', 'film-orders'] as const,
  filmCatalog: ['inventory', 'film-catalog'] as const,
  caulkProducts: ['caulk', 'products'] as const,
  caulkTransfersRoot: ['caulk', 'transfers'] as const,
  caulkTransfers: (params: { warehouse: string; productId?: string }) =>
    ['caulk', 'transfers', params] as const,
  activityRoot: ['inventory', 'activity'] as const,
  activity: (params: AuditListParams) => ['inventory', 'activity', params] as const,
  rollHistory: (boxId: string) => ['inventory', 'roll-history', boxId] as const,
  reportsRoot: ['inventory', 'reports'] as const,
  reports: (filters: ReportsSummaryFilters) => ['inventory', 'reports', filters] as const,
  ownerReportsRoot: ['inventory', 'owner-reports'] as const,
  ownerAssetTotalCost: (filters: Pick<ReportsSummaryFilters, 'warehouse'>) =>
    ['inventory', 'owner-reports', 'asset-total-cost', filters] as const
};
