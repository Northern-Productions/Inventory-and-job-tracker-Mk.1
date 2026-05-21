import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildJobListEntry } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0143_multi_phase_jobs.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260521020000_multi_phase_jobs.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function buildHeader(overrides = {}) {
  return {
    id: 'job-1',
    jobNumber: '1234',
    warehouse: 'IL1',
    workScope: 'Sections 1, 2, 3',
    sections: 'Sections 1, 2, 3',
    installDate: '',
    crewLeader: '',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    createdAt: '2026-05-21T10:00:00Z',
    updatedAt: '2026-05-21T10:00:00Z',
    notes: '',
    ...overrides,
  };
}

function buildPhase(overrides = {}) {
  return {
    phaseId: 'phase-1',
    phaseNumber: 1,
    workScope: 'Sections 1, 2, 3',
    sections: 'Sections 1, 2, 3',
    installDate: '',
    crewLeader: '',
    laborStatus: 'ACTIVE',
    isPrimary: false,
    createdAt: '2026-05-21T10:00:00Z',
    updatedAt: '2026-05-21T10:00:00Z',
    ...overrides,
  };
}

function buildRequirement(overrides = {}) {
  return {
    requirementId: 'req-1',
    phaseId: 'phase-1',
    phaseNumber: 1,
    manufacturer: '3M',
    filmName: 'Prestige 40',
    widthIn: 60,
    requiredFeet: 25,
    allocatedFeet: 0,
    remainingFeet: 25,
    status: 'ACTIVE',
    actualUsedFeet: 0,
    ...overrides,
  };
}

test('multi-phase migration is mirrored and guarded by schema latest', () => {
  const backendMigration = readFileSync(backendMigrationPath, 'utf8');
  const supabaseMigration = readFileSync(supabaseMigrationPath, 'utf8');
  const schemaCheck = readFileSync(schemaCheckPath, 'utf8');

  assert.equal(supabaseMigration, backendMigration);
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0143_multi_phase_jobs\.sql';/);
  assert.match(backendMigration, /create table if not exists app\.job_phases/);
  assert.match(backendMigration, /add column phase_id uuid/);
  assert.match(backendMigration, /api_acl_job_phase_set_state/);
  assert.match(backendMigration, /unique \(org_id, job_id, phase_number\) deferrable initially immediate/);
  assert.match(backendMigration, /set constraints job_phases_org_job_phase_number_unique deferred/);
  assert.match(backendMigration, /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/);
});

test('job status follows the next incomplete phase instead of future worst status', () => {
  const summary = buildJobListEntry(
    buildHeader(),
    [
      buildRequirement({
        requirementId: 'req-future',
        phaseId: 'phase-2',
        phaseNumber: 2,
      }),
    ],
    [],
    [],
    [],
    [],
    {},
    {
      phases: [
        buildPhase({
          phaseId: 'phase-1',
          phaseNumber: 1,
          installDate: '2999-01-15',
          crewLeader: 'Alexis',
        }),
        buildPhase({
          phaseId: 'phase-2',
          phaseNumber: 2,
          workScope: 'Section 7',
          sections: 'Section 7',
          installDate: '2999-03-15',
          crewLeader: 'Blair',
        }),
      ],
    }
  );

  assert.equal(summary.status, 'READY');
  assert.equal(summary.phaseNumber, 1);
  assert.equal(summary.installDate, '2999-01-15');
  assert.equal(summary.remainingFeet, 0);
});

test('future phase controls status after the nearer phase is complete', () => {
  const summary = buildJobListEntry(
    buildHeader(),
    [
      buildRequirement({
        requirementId: 'req-future',
        phaseId: 'phase-2',
        phaseNumber: 2,
      }),
    ],
    [],
    [],
    [],
    [],
    {},
    {
      phases: [
        buildPhase({
          phaseId: 'phase-1',
          phaseNumber: 1,
          installDate: '2999-01-15',
          laborStatus: 'COMPLETE',
        }),
        buildPhase({
          phaseId: 'phase-2',
          phaseNumber: 2,
          workScope: 'Section 7',
          sections: 'Section 7',
          installDate: '2999-03-15',
        }),
      ],
    }
  );

  assert.equal(summary.status, 'FILM_ORDER');
  assert.equal(summary.phaseNumber, 2);
  assert.equal(summary.remainingFeet, 25);
});

test('same-date phase group uses Film Order over Ready and expands both phases', () => {
  const summary = buildJobListEntry(
    buildHeader(),
    [
      buildRequirement({
        requirementId: 'req-same-date',
        phaseId: 'phase-2',
        phaseNumber: 2,
      }),
    ],
    [],
    [],
    [],
    [],
    {},
    {
      phases: [
        buildPhase({
          phaseId: 'phase-1',
          phaseNumber: 1,
          installDate: '2999-01-15',
        }),
        buildPhase({
          phaseId: 'phase-2',
          phaseNumber: 2,
          workScope: 'Section 7',
          sections: 'Section 7',
          installDate: '2999-01-15',
        }),
      ],
    }
  );

  assert.equal(summary.status, 'FILM_ORDER');
  assert.deepEqual(
    summary.phases.map((phase) => ({
      phaseNumber: phase.phaseNumber,
      next: phase.isNextRelevant,
      expanded: phase.isExpandedByDefault,
    })),
    [
      { phaseNumber: 1, next: true, expanded: true },
      { phaseNumber: 2, next: true, expanded: true },
    ]
  );
});

test('labor-only phase completion is independent and does not create film demand', () => {
  const summary = buildJobListEntry(
    buildHeader({ isLaborOnly: true }),
    [],
    [],
    [],
    [],
    [],
    {},
    {
      phases: [
        buildPhase({
          phaseId: 'phase-1',
          phaseNumber: 1,
          laborStatus: 'ACTIVE',
        }),
      ],
    }
  );

  assert.equal(summary.status, 'READY');
  assert.equal(summary.phases[0].isComplete, false);
  assert.equal(summary.phases[0].requiredFeet, 0);

  const completeSummary = buildJobListEntry(
    buildHeader({ isLaborOnly: true }),
    [],
    [],
    [],
    [],
    [],
    {},
    {
      phases: [
        buildPhase({
          phaseId: 'phase-1',
          phaseNumber: 1,
          laborStatus: 'COMPLETE',
        }),
      ],
    }
  );

  assert.equal(completeSummary.phases[0].isComplete, true);
  assert.equal(completeSummary.status, 'READY');
});
