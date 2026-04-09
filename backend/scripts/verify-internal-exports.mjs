import * as internal from '../src/app/internal.mjs';

const REQUIRED_EXPORTS = [
  'addBox',
  'updateBox',
  'previewAllocationPlan',
  'applyAllocationPlan',
  'removeAllocationFromJob',
  'buildJobDetail',
  'buildJobsList',
  'findBoxById',
];

for (const exportName of REQUIRED_EXPORTS) {
  if (typeof internal[exportName] !== 'function') {
    throw new Error(`Missing internal export: ${exportName}`);
  }
}

console.log('Internal export surface OK.');
