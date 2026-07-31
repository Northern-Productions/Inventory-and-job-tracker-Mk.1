import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runtimeAllocationApply = readFileSync(
  new URL('../../../backend/src/app/services/runtime/runtimeAllocationApply.mjs', import.meta.url),
  'utf8'
);
const edgeReadHandlers = readFileSync(
  new URL('../../../supabase/functions/_shared/routes/readHandlers.ts', import.meta.url),
  'utf8'
);
const allocationPreviewMigration = readFileSync(
  new URL('../../../backend/migrations/0193_allocation_preview_bounded_candidates.sql', import.meta.url),
  'utf8'
);
const backendPhaseScheduleMigration = readFileSync(
  new URL('../../../backend/migrations/0163_phase_specific_allocation_schedule.sql', import.meta.url),
  'utf8'
);
const supabasePhaseScheduleMigration = readFileSync(
  new URL('../../../supabase/migrations/20260617101000_phase_specific_allocation_schedule.sql', import.meta.url),
  'utf8'
);

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Expected marker ${endMarker}.`);
  return source.slice(start, end);
}

test('local allocation preview consumes the canonical job and phase context from the bounded RPC', () => {
  const resolverBody = extractBetween(
    runtimeAllocationApply,
    'async function resolvePreviewJobContext',
    'function ensureBoxEligibleForJobAllocation'
  );
  const previewBody = extractBetween(
    runtimeAllocationApply,
    'async function previewAllocationPlan',
    'function resolveSelectedRequirement'
  );

  assert.match(resolverBody, /payload\.jobId/);
  assert.match(resolverBody, /requireUuid\(jobIdText, 'jobId'\)/);
  assert.match(resolverBody, /findJobById\(client, orgId, jobId\)/);
  assert.match(resolverBody, /Job was not found\./);
  assert.match(resolverBody, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.match(resolverBody, /allowPhaseScheduleOverride/);
  assert.match(resolverBody, /resolveJobContext\(\s*client,\s*orgId,\s*payload\.jobNumber/s);
  assert.match(previewBody, /loadAllocationPreviewCandidateSnapshot\(/);
  assert.match(previewBody, /canonicalJobContext = context\.jobContext/);
  assert.match(previewBody, /requirementState = context\.requirementState/);
  assert.match(previewBody, /phaseState = context\.phaseState/);
  assert.match(previewBody, /phaseInstallDate: asTrimmedString\(phaseState\.installDate\)/);
  assert.doesNotMatch(previewBody, /listJobRequirementsByJob/);
});

test('allocation apply now reuses canonical jobId preview identity resolution', () => {
  const applyBody = extractBetween(
    runtimeAllocationApply,
    'async function applyAllocationPlan',
    'export {'
  );

  assert.match(applyBody, /allowPhaseScheduleOverride:\s*Boolean\(requirementId\)/);
  assert.match(applyBody, /listJobRequirementsByJobId\(client, orgId, applyTarget\.jobId\)/);
  assert.match(applyBody, /listJobRequirementsByJob\(client, orgId, jobContext\.jobNumber\)/);
  assert.match(applyBody, /resolveRequirementScheduleJobContext\(/);
});

test('Edge allocation preview consumes the same canonical bounded RPC context', () => {
  const previewHandlerBody = extractBetween(
    edgeReadHandlers,
    '"/allocations/preview": async',
    '"/jobs/list": async'
  );

  assert.match(previewHandlerBody, /deps\.loadAllocationPreviewCandidateSnapshot\(/);
  assert.match(previewHandlerBody, /canonicalJobContext = \(context\.jobContext/);
  assert.match(previewHandlerBody, /requirementState = \(context\.requirementState/);
  assert.match(previewHandlerBody, /phaseState = \(context\.phaseState/);
  assert.match(previewHandlerBody, /phaseInstallDate: deps\.asTrimmedString\(phaseState\.installDate\)/);
  assert.doesNotMatch(previewHandlerBody, /deps\.listJobRequirementsByJob/);
});

test('0193 delegates canonical jobId and requirement schedule validation to the preserved 0192 planner', () => {
  assert.match(
    allocationPreviewMigration,
    /app_api\.build_allocation_apply_plan_0192\(\s*p_org_id,\s*'allocation-preview',\s*v_context_payload/s
  );
  assert.match(allocationPreviewMigration, /'jobId', v_job_id_text/);
  assert.match(allocationPreviewMigration, /'jobContext', coalesce\(v_plan->'jobContext'/);
  assert.match(allocationPreviewMigration, /'requirementState', coalesce\(v_plan->'requirementState'/);
  assert.match(allocationPreviewMigration, /'phaseState', coalesce\(v_plan->'phaseState'/);
});

test('phase-specific allocation schedule migration is mirrored and requirement-scoped', () => {
  for (const migrationBody of [backendPhaseScheduleMigration, supabasePhaseScheduleMigration]) {
    assert.match(migrationBody, /v_requirement_phase_install_date date/);
    assert.match(migrationBody, /v_payload_job_date date/);
    assert.match(migrationBody, /v_requirement_id_text = ''/);
    assert.match(migrationBody, /JobDate must match the selected requirement phase/);
    assert.match(migrationBody, /CrewLeader must match the selected requirement phase/);
    assert.match(migrationBody, /select ph\.install_date, coalesce\(ph\.crew_leader, ''\), true/);
    assert.match(migrationBody, /v_job_context := jsonb_build_object/);
  }

  assert.equal(
    backendPhaseScheduleMigration.replace(/\s+/g, ' ').trim(),
    supabasePhaseScheduleMigration.replace(/\s+/g, ' ').trim(),
    'Expected backend and Supabase phase schedule migrations to stay mirrored.'
  );
});
