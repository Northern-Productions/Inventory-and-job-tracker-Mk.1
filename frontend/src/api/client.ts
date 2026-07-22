// Purpose: Backward-compatible facade that re-exports feature API clients.
export {
  __resetJobsApiAvailabilityForTests,
  getAuthContext,
  getHealth,
  requestUsernameChange,
  updateDefaultWarehouse,
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
  bulkTransferOwnership,
  changeCaulkStockOwner,
  changeFilmBoxOwner,
  deactivateOwnerCompany,
  listOwnerCompanies,
  upsertOwnerCompany
} from './features/ownershipClient';
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
  getBoxTransferPlan,
  listBoxDealers,
  markLabelsPrinted,
  receiveOrderedBox,
  searchBoxes,
  setBoxStatus,
  suggestNextBoxId,
  syncAllOfflineInventorySnapshots,
  syncOfflineInventorySnapshot,
  upsertBoxDealer,
  updateBox
} from './features/inventoryClient';
export {
  addCaulkJobAllocation,
  applyAllocationPlan,
  checkinCaulkJobAllocation,
  checkoutCaulkJobAllocation,
  clearAllocationPlannerSuppression,
  getAllocationJob,
  getAllocationJobs,
  getAllocationsByBox,
  previewAllocationPlan,
  removeCaulkJobAllocation,
  removeJobBoxAllocations,
  updateCaulkJobAllocation
} from './features/allocationsClient';
export {
  checkJobDuplicate,
  checkoutAllJobMaterials,
  completeJob,
  createJob,
  deleteJob,
  getJob,
  getJobById,
  getJobsCalendarEntries,
  getJobsCalendarMonth,
  getJobs,
  reopenJob,
  searchJobsByNumber,
  setJobPhaseState,
  setJobRequirementState,
  setJobStagedForPickup,
  updateJob
} from './features/jobsClient';
export {
  cancelJob,
  createFilmOrder,
  deleteFilmOrder,
  getFilmCatalog,
  getFilmOrderDetail,
  getFilmOrders,
  manualFulfillFilmOrder
} from './features/filmOrdersClient';
export {
  getFilmWeightPendingReviews,
  getFilmWeightProfiles,
  resolveFilmWeightPendingReview
} from './features/filmWeightClient';
export { getAuditByBox, getRollHistoryByBox, listAudit, undoAudit } from './features/auditClient';
export {
  getOwnerAssetTotalCostReport,
  getReportsSummary,
  getWarehouseAssetAuditReport
} from './features/reportsClient';
