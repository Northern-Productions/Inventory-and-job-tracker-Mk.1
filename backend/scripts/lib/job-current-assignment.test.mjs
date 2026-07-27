import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  chooseCurrentJobPhaseGroup,
  getJobPhaseWorkflowStatus,
  isJobPhaseComplete,
  resolveCurrentJobCrewLeader,
  selectCurrentJobPhase,
} from '../../../shared/domain/jobCurrentAssignment.mjs';
import { buildJobListEntry } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';

const EXPECTED_GOLDEN_HASHES = Object.freeze({
  currentPhase: 'c79047c1be895752a930cac61429215c5a3c33a5055b09a96d63493d268e4742',
  completion: '64bd35e97a9b7d07c45eb266e5ed4d7a26e8340eb5ffaa3a94d54067b4d9a142',
  phaseCrew: '0d16f74e4ddbd28289ad933ac3374cb8a96fa4fb3f31c0067d1e5c7f96bc5b6b',
  missingCrew: 'd2e68b10dfd34218aa50de13c86b0222c36d27e17ec7fcd806d298c9f34314c1',
  multipleSameDate: 'd8b0603cee2841996c9309447619e258fbf8f2668fa02f17d85a29c06bb1745a',
  legacyFallback: '98c71bbe32bb66ef2140ec47f6b94b314a141d55a63262fca1d07aaae6425f23',
});

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function hashPublicValue(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function buildHeader(overrides = {}) {
  return {
    id: 'job-1',
    jobNumber: '1234',
    warehouse: 'IL1',
    workScope: 'Area A',
    sections: 'Area A',
    installDate: '',
    crewLeader: 'Header Crew',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: true,
    isStagedForPickup: false,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    notes: '',
    ...overrides,
  };
}

function buildPhase(overrides = {}) {
  return {
    phaseId: 'phase-1',
    phaseNumber: 1,
    workScope: 'Area A',
    sections: 'Area A',
    installDate: '2999-01-01',
    crewLeader: '',
    laborStatus: 'ACTIVE',
    workflowStatus: 'ACTIVE',
    isPrimary: true,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

function buildGoldenCases() {
  const build = ({
    job = buildHeader(),
    phases = [buildPhase()],
    requirements = [],
    caulkRequirements = [],
    allocations = [],
    filmOrders = [],
  } = {}) => buildJobListEntry(
    job,
    requirements,
    allocations,
    filmOrders,
    [],
    caulkRequirements,
    {},
    { phases },
  );
  return {
    currentPhase: build(),
    completion: build({
      phases: [
        buildPhase({ laborStatus: 'COMPLETE' }),
        buildPhase({ phaseId: 'phase-2', phaseNumber: 2, installDate: '2999-02-01' }),
      ],
    }),
    phaseCrew: build({ phases: [buildPhase({ crewLeader: 'Phase Crew' })] }),
    missingCrew: build({ job: buildHeader({ crewLeader: '' }) }),
    multipleSameDate: build({
      phases: [
        buildPhase({ phaseId: 'phase-2', phaseNumber: 2 }),
        buildPhase({ phaseId: 'phase-1', phaseNumber: 1 }),
      ],
    }),
    legacyFallback: build({
      job: buildHeader({ crewLeader: '' }),
      allocations: [{
        allocationId: 'alloc-1',
        boxId: 'IL1-1',
        jobNumber: '1234',
        status: 'ACTIVE',
        allocationKind: 'EXTRA',
        allocatedFeet: 1,
        installDate: '',
        crewLeader: 'Legacy Crew',
      }],
    }),
  };
}

test('shared current assignment preserves phase completion and deterministic selection', () => {
  assert.equal(
    getJobPhaseWorkflowStatus({ workflowStatus: '', workflow_status: 'PLACEHOLDER' }),
    'PLACEHOLDER',
  );
  assert.equal(
    isJobPhaseComplete({ laborStatus: '', labor_status: 'COMPLETE' }),
    true,
  );
  assert.equal(isJobPhaseComplete(
    { laborStatus: 'COMPLETE' },
    [{ status: 'ACTIVE' }],
  ), false);
  assert.equal(isJobPhaseComplete(
    { laborStatus: 'ACTIVE' },
    [{ status: 'COMPLETE' }],
    [{ status: 'COMPLETE' }],
  ), true);

  const phases = [
    { phaseId: 'future', phaseNumber: 3, installDate: '2026-08-01', isComplete: false },
    { phaseId: 'second', phaseNumber: 2, installDate: '2026-07-26', isComplete: false },
    { phaseId: 'first', phaseNumber: 1, installDate: '2026-07-26', isComplete: false },
    {
      phaseId: 'placeholder',
      phaseNumber: 0,
      installDate: '2026-07-20',
      workflowStatus: 'PLACEHOLDER',
      isComplete: false,
    },
  ];
  assert.deepEqual(
    chooseCurrentJobPhaseGroup(phases, { today: '2026-07-27' }).map((phase) => phase.phaseId),
    ['first', 'second'],
  );
  assert.equal(selectCurrentJobPhase(phases, { today: '2026-07-27' }).phaseId, 'first');
});

test('shared current assignment preserves phase, header, legacy, and missing crew precedence', () => {
  assert.equal(resolveCurrentJobCrewLeader({
    currentPhase: { crewLeader: 'Phase Crew' },
    jobCrewLeader: 'Header Crew',
    legacyCrewLeader: 'Legacy Crew',
  }), 'Phase Crew');
  assert.equal(resolveCurrentJobCrewLeader({
    currentPhase: { crewLeader: '', crew_leader: '' },
    jobCrewLeader: 'Header Crew',
    legacyCrewLeader: 'Legacy Crew',
  }), 'Header Crew');
  assert.equal(resolveCurrentJobCrewLeader({
    currentPhase: { crewLeader: '', crew_leader: 'Legacy Phase Crew' },
    jobCrewLeader: 'Header Crew',
    legacyCrewLeader: 'Legacy Crew',
  }), 'Legacy Phase Crew');
  assert.equal(resolveCurrentJobCrewLeader({
    currentPhase: null,
    jobCrewLeader: '',
    legacyCrewLeader: 'Legacy Crew',
  }), 'Legacy Crew');
  assert.equal(resolveCurrentJobCrewLeader({
    currentPhase: null,
    jobCrewLeader: '',
    legacyCrewLeader: '',
  }), '');
});

test('local Jobs summaries retain exact pre-refactor public shape and values', () => {
  const actual = Object.fromEntries(
    Object.entries(buildGoldenCases()).map(([name, value]) => [name, hashPublicValue(value)]),
  );
  assert.deepEqual(actual, EXPECTED_GOLDEN_HASHES);
});
