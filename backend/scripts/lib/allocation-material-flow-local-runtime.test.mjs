import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('local allocation apply/remove keeps allocation claims separate from physical LF', async () => {
  const applyPath = path.join(
    repoRoot,
    'backend',
    'src',
    'app',
    'services',
    'runtime',
    'runtimeAllocationApply.mjs'
  );
  const cleanupPath = path.join(
    repoRoot,
    'backend',
    'src',
    'app',
    'services',
    'runtime',
    'runtimeAllocationCleanup.mjs'
  );

  const [applyRuntime, cleanupRuntime] = await Promise.all([
    readFile(applyPath, 'utf8'),
    readFile(cleanupPath, 'utf8'),
  ]);

  assert.match(
    applyRuntime,
    /applyPlanningAllocationToBox\(currentBox,\s*plannedAllocation\.allocatedFeet,\s*\{\s*consumeAllocatableFeet:\s*false,/s
  );
  assert.match(
    applyRuntime,
    /applyPlanningAllocationToBox\(currentBox,\s*plannedExtra\.allocatedFeet,\s*\{\s*consumeAllocatableFeet:\s*false,/s
  );
  assert.match(
    cleanupRuntime,
    /releaseAllocationFeetFromBox\(box,\s*releasedFeet,\s*\{\s*restoreAllocatableFeet:\s*false,/s
  );
});
