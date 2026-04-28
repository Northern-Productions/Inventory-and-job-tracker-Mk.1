import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendJobDetailsPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeJobDetails.mjs'
);
const edgeApiHandlerPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'api-handler.ts');

function extractFunctionBody(source, functionName) {
  const start = source.indexOf(`async function ${functionName}`);
  assert.notEqual(start, -1, `Unable to find ${functionName}.`);
  const nextFunction = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

test('local job detail context uses scoped box reads instead of full org inventory', async () => {
  const source = await readFile(backendJobDetailsPath, 'utf8');

  assert.doesNotMatch(source, /listBoxes\(client,\s*orgId\)/);
  assert.doesNotMatch(source, /listCaulkStock\(client,\s*orgId,\s*\{\}\)/);
  assert.match(source, /listBoxesByIds\(client,\s*orgId,\s*resolvedBaseContext\.boxIds\)/);
  assert.match(source, /allBoxes:\s*detailContext\.allBoxes/);
});

test('Edge buildJobDetail avoids full org box and caulk stock reads', async () => {
  const source = await readFile(edgeApiHandlerPath, 'utf8');
  const buildJobDetail = extractFunctionBody(source, 'buildJobDetail');

  assert.doesNotMatch(buildJobDetail, /listBoxes\(client,\s*orgId\)/);
  assert.doesNotMatch(buildJobDetail, /listCaulkStockEntries\(client,\s*orgId\)/);
  assert.match(buildJobDetail, /listBoxesByIds\(orgId,\s*collectJobBoxIds/);
  assert.match(buildJobDetail, /allBoxes:\s*boxes/);
  assert.match(buildJobDetail, /caulkStockEntries:\s*\[\]/);
});

test('Edge buildAllocationJobDetail keeps readiness reads scoped to job boxes', async () => {
  const source = await readFile(edgeApiHandlerPath, 'utf8');
  const buildAllocationJobDetail = extractFunctionBody(source, 'buildAllocationJobDetail');

  assert.doesNotMatch(buildAllocationJobDetail, /listBoxes\(client,\s*orgId\)/);
  assert.doesNotMatch(buildAllocationJobDetail, /listCaulkStockEntries\(client,\s*orgId\)/);
  assert.match(buildAllocationJobDetail, /listBoxesByIds\(orgId,\s*collectJobBoxIds/);
  assert.match(buildAllocationJobDetail, /allBoxes:\s*boxes/);
  assert.match(buildAllocationJobDetail, /caulkStockEntries:\s*\[\]/);
});
