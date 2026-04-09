// Purpose: Backward-compatible facade that re-exports feature API clients.
export {
  __resetJobsApiAvailabilityForTests,
  getAuthContext,
  getHealth,
  requestUsernameChange,
  setClientAccessContext
} from './features/authClient';
export { getAppAttentionSummary } from './features/appClient';
export {
  approveAccessRequest,
  approveUsernameChangeRequest,
  demoteAdminToMember,
  denyAccessRequest,
  denyUsernameChangeRequest,
  getAdminFeaturePermissions,
  getMemberFeaturePermissions,
  getOwnerNotificationPreferences,
  getUserFeaturePermissions,
  listAccessRequests,
  listUsernameChangeRequests,
  promoteAdminToOwner,
  promoteMemberToAdmin,
  updateAdminFeaturePermissions,
  updateMemberFeaturePermissions,
  updateOwnerNotificationPreferences,
  updateUserFeaturePermissions
} from './features/accessClient';
export { addWarehouse, listWarehouses } from './features/warehouseClient';
export {
  listCaulkManufacturers,
  listCaulkProducts,
  listCaulkStock,
  listCaulkTransactions,
  mutateCaulkStock,
  ownerUpsertCaulkManufacturer,
  transferCaulkStock,
  upsertCaulkProduct
} from './features/caulkClient';
export {
  addBox,
  allocateBox,
  deleteBox,
  getBox,
  searchBoxes,
  setBoxStatus,
  syncAllOfflineInventorySnapshots,
  syncOfflineInventorySnapshot,
  updateBox
} from './features/inventoryClient';
export {
  addCaulkJobAllocation,
  applyAllocationPlan,
  checkinCaulkJobAllocation,
  checkoutCaulkJobAllocation,
  getAllocationJob,
  getAllocationJobs,
  getAllocationsByBox,
  previewAllocationPlan,
  removeCaulkJobAllocation,
  removeJobBoxAllocations,
  updateCaulkJobAllocation
} from './features/allocationsClient';
export {
  checkoutAllJobMaterials,
  completeJob,
  createJob,
  deleteJob,
  getJob,
  getJobsCalendarEntries,
  getJobsCalendarMonth,
  getJobs,
  reopenJob,
  searchJobsByNumber,
  setJobStagedForPickup,
  updateJob
} from './features/jobsClient';
export {
  cancelJob,
  createFilmOrder,
  deleteFilmOrder,
  getFilmCatalog,
  getFilmOrders
} from './features/filmOrdersClient';
export { getAuditByBox, getRollHistoryByBox, listAudit, undoAudit } from './features/auditClient';
export { getOwnerAssetTotalCostReport, getReportsSummary } from './features/reportsClient';
