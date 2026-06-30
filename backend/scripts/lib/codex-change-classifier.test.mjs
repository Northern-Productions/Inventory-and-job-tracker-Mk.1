import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangedFiles, normalizeChangedFile } from './codex-change-classifier.mjs';

test('normalizeChangedFile handles Windows paths', () => {
  assert.equal(normalizeChangedFile('.\\frontend\\src\\styles.css'), 'frontend/src/styles.css');
});

test('docs and tooling changes classify as Tier 0', () => {
  const report = classifyChangedFiles([
    'AGENTS.md',
    'docs/automation/task-tiers.md',
    'backend/scripts/codex-task-refresh.mjs'
  ]);

  assert.equal(report.tier, 0);
  assert.equal(report.taskType, 'docs/tooling');
  assert.equal(report.flags.docsToolingOnly, true);
  assert.ok(report.requiredChecks.includes('node --check for new or changed Node tooling scripts'));
  assert.ok(report.likelyReleaseActions.includes('no runtime deploy expected'));
});

test('frontend style changes classify as Tier 1 frontend visual work', () => {
  const report = classifyChangedFiles(['frontend/src/styles.css']);

  assert.equal(report.tier, 1);
  assert.equal(report.flags.frontend, true);
  assert.equal(report.flags.frontendVisual, true);
  assert.ok(report.requiredChecks.includes('npm --prefix frontend run test'));
  assert.ok(report.requiredChecks.includes('npm --prefix frontend run build'));
});

test('frontend workflow pages classify as high-risk when material flow is involved', () => {
  const report = classifyChangedFiles(['frontend/src/pages/AllocationJobPage.tsx']);

  assert.equal(report.tier, 6);
  assert.equal(report.flags.frontendWorkflow, true);
  assert.equal(report.flags.materialFlow, true);
  assert.ok(report.requiredChecks.includes('read docs/material-flow-rules.md before implementation'));
  assert.ok(report.requiredChecks.includes('DEV fixture workflow verification after target guard'));
});

test('backend runtime changes classify as Tier 3 unless material flow raises risk', () => {
  const report = classifyChangedFiles(['backend/src/app/repositories/audit/index.mjs']);

  assert.equal(report.tier, 3);
  assert.equal(report.flags.backendRuntime, true);
  assert.ok(report.requiredChecks.includes('npm --prefix backend run test:unit'));
});

test('Edge/shared changes classify as Tier 4 with parity checks', () => {
  const report = classifyChangedFiles(['supabase/functions/_shared/api-handler.ts']);

  assert.equal(report.tier, 4);
  assert.equal(report.flags.edgeOrShared, true);
  assert.ok(report.requiredChecks.includes('npm --prefix backend run edge:test'));
  assert.ok(report.requiredChecks.includes('npm --prefix backend run contract:parity'));
  assert.ok(report.likelyReleaseActions.includes('Supabase Edge/API deploy decision required on release'));
});

test('migration changes classify as Tier 5 with schema checks', () => {
  const report = classifyChangedFiles(['backend/migrations/0200_example.sql', 'supabase/migrations/20260630000000_example.sql']);

  assert.equal(report.tier, 5);
  assert.equal(report.flags.migrationOrSchema, true);
  assert.ok(report.requiredChecks.includes('migration mirror/parity check for backend and Supabase migrations'));
  assert.ok(report.likelyReleaseActions.includes('approved PROD migration plan required on release'));
});

test('caulk and allocation backend changes classify as Tier 6 material-flow risk', () => {
  const report = classifyChangedFiles(['backend/src/app/services/caulkCheckout.mjs', 'backend/src/app/core/allocationPlanner.mjs']);

  assert.equal(report.tier, 6);
  assert.equal(report.flags.materialFlow, true);
  assert.ok(report.stopConditions.includes('requested behavior conflicts with docs/material-flow-rules.md'));
});
