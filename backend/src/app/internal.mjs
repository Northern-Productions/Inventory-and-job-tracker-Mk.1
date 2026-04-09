// Purpose: Stable internal export surface for backend verification scripts.
export { findBoxById } from './repositories/inventoryRepositories.mjs';
export { addBox, updateBox } from './services/boxes.mjs';
export {
  applyAllocationPlan,
  buildAllocationJobDetail,
  buildAllocationJobList,
  previewAllocationPlan,
  removeAllocationFromJob,
} from './services/allocations.mjs';
export {
  buildJobDetail,
  buildJobsList,
} from './services/jobs.mjs';
