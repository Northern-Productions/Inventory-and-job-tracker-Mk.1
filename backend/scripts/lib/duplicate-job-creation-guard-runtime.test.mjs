import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runtimeMutations = readFileSync(
  new URL('../../src/app/services/runtime/runtimeJobsMutations.mjs', import.meta.url),
  'utf8'
);
const runtimeRead = readFileSync(
  new URL('../../src/app/services/runtime/runtimeJobsRead.mjs', import.meta.url),
  'utf8'
);
const readHandlers = readFileSync(
  new URL('../../src/app/handlers/readHandlers.mjs', import.meta.url),
  'utf8'
);

test('backend createJob rejects exact Work Scope duplicate job numbers before saving', () => {
  const createJobStart = runtimeMutations.indexOf('async function createJob');
  const saveIndex = runtimeMutations.indexOf('nextHeader = await saveJobRecord', createJobStart);
  const duplicateGuardIndex = runtimeMutations.indexOf('duplicateResult.exactScopeDuplicateExists', createJobStart);
  const conflictPayloadIndex = runtimeMutations.indexOf('buildJobDuplicateCheckResult({', duplicateGuardIndex);

  assert.ok(createJobStart >= 0, 'Expected createJob function to exist.');
  assert.ok(duplicateGuardIndex > createJobStart, 'Expected createJob to contain exact-scope duplicate guard.');
  assert.ok(conflictPayloadIndex > duplicateGuardIndex, 'Expected createJob conflict to include duplicate diagnostics.');
  assert.ok(saveIndex > duplicateGuardIndex, 'Expected duplicate guard to run before saveJobRecord.');
  assert.match(
    runtimeMutations.slice(createJobStart, saveIndex),
    /listJobsByNumber\(client, orgId, jobNumber\)/,
    'Expected createJob to inspect all same-number candidates.'
  );
  assert.match(
    runtimeMutations.slice(createJobStart, saveIndex),
    /duplicatesEnabled: true/,
    'Expected createJob duplicate diagnostics to reflect final duplicate enablement.'
  );
  assert.doesNotMatch(
    runtimeMutations.slice(createJobStart, saveIndex),
    /cloneValue\(existingHeader\)/,
    'Expected createJob to stop merging duplicate job headers before save.'
  );
});

test('backend exposes a read-only duplicate check route', () => {
  assert.match(runtimeRead, /async function checkJobDuplicate/);
  assert.match(runtimeRead, /buildJobDuplicateCheckResult/);
  assert.match(runtimeRead, /getJobDuplicateWorkScopeInput/);
  assert.match(runtimeRead, /duplicatesEnabled: true/);
  assert.match(readHandlers, /'\/jobs\/check-duplicate': async/);
  assert.match(readHandlers, /ok\(await checkJobDuplicate\(client, orgId, params \|\| \{\}\)\)/);
});
