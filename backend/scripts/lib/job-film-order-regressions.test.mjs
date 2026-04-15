import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeJobRequirementEntriesForWrite } from '../../src/app/core/catalog.mjs';
import { saveFilmOrderRecord } from '../../src/app/repositories/inventoryRecordsRepository.mjs';
import { replaceJobRequirementsForJob } from '../../src/app/repositories/jobsRepository.mjs';
import { buildJobListEntry } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';
import { buildPublicJobUsageTimelineEntries } from '../../src/app/services/runtime/runtimeTransferUsage.mjs';

function createRecordingClient(rowsByQuery = []) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      const nextRows = rowsByQuery[calls.length - 1] || [];
      return { rows: nextRows };
    }
  };
}

test('buildPublicJobUsageTimelineEntries includes ordered box history rows with linked box IDs', () => {
  const entries = buildPublicJobUsageTimelineEntries(
    [
      {
        boxId: 'MS1-ROLL',
        warehouse: 'MS1',
        manufacturer: '3M Solar',
        filmName: 'Prestige 40 Exterior',
        checkedOutAt: '2026-04-15T09:00:00Z',
        checkedOutBy: 'crew',
        checkedInAt: '2026-04-15T09:30:00Z',
        checkedInBy: 'crew',
        feetBefore: 50,
        feetAfter: 42,
        notes: 'returned after use'
      }
    ],
    {
      'MS1-ROLL': {
        boxId: 'MS1-ROLL',
        warehouse: 'MS1',
        manufacturer: '3M Solar',
        filmName: 'Prestige 40 Exterior'
      },
      'MS1-LINK': {
        boxId: 'MS1-LINK',
        warehouse: 'MS1',
        manufacturer: '3M Solar',
        filmName: 'Prestige 40 Exterior'
      }
    },
    [],
    [
      {
        filmOrderId: 'fo-1',
        boxId: 'MS1-LINK',
        orderedFeet: 30,
        autoAllocatedFeet: 30,
        createdAt: '2026-04-15T10:00:00Z',
        createdBy: 'warehouse'
      }
    ],
    [
      {
        filmOrderId: 'fo-1',
        jobNumber: '19413',
        warehouse: 'MS1',
        manufacturer: '3M Solar',
        filmName: 'Prestige 40 Exterior',
        status: 'FULFILLED'
      }
    ]
  );

  assert.deepEqual(
    entries.map((entry) => entry.usageType),
    ['FILM_ORDER', 'FILM']
  );
  assert.deepEqual(entries[0], {
    usageType: 'FILM_ORDER',
    occurredAt: '2026-04-15T10:00:00Z',
    actor: 'warehouse',
    warehouse: 'MS1',
    referenceId: 'MS1-LINK',
    manufacturer: '3M Solar',
    itemName: 'Prestige 40 Exterior',
    itemCode: '',
    unit: 'LF',
    checkedOutQuantity: 30,
    returnedQuantity: 0,
    usedQuantity: 0,
    notes: ''
  });
});

test('buildJobListEntry only counts unresolved film orders', () => {
  const summary = buildJobListEntry(
    {
      id: 'job-1',
      jobNumber: '19413',
      warehouse: 'IL1',
      sections: null,
      installDate: '2026-04-15',
      crewLeader: 'Alexis',
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: false,
      createdAt: '2026-04-14T10:00:00Z',
      updatedAt: '2026-04-15T10:00:00Z',
      notes: ''
    },
    [],
    [],
    [
      {
        filmOrderId: 'fo-open',
        jobNumber: '19413',
        warehouse: 'IL1',
        status: 'FILM_ON_THE_WAY',
        createdAt: '2026-04-15T09:00:00Z',
        resolvedAt: ''
      },
      {
        filmOrderId: 'fo-done',
        jobNumber: '19413',
        warehouse: 'IL1',
        status: 'FULFILLED',
        createdAt: '2026-04-15T08:00:00Z',
        resolvedAt: '2026-04-15T09:30:00Z'
      }
    ],
    [],
    [],
    {}
  );

  assert.equal(summary.filmOrderCount, 1);
});

test('normalizeJobRequirementEntriesForWrite preserves explicit Prestige 40 Exterior labels', async () => {
  const entries = await normalizeJobRequirementEntriesForWrite(null, 'org-1', [
    {
      manufacturer: '3M Solar',
      filmName: 'Prestige 40 Exterior',
      widthIn: 36,
      requiredFeet: 30
    }
  ]);

  assert.deepEqual(entries, [
    {
      manufacturer: '3M Solar',
      filmName: 'Prestige 40 Exterior',
      widthIn: 36,
      requiredFeet: 30
    }
  ]);
});

test('job requirement and film order repositories preserve write-normalized labels', async () => {
  const requirementsClient = createRecordingClient([[], []]);
  await replaceJobRequirementsForJob(
    requirementsClient,
    'org-1',
    { id: 'job-1' },
    [
      {
        id: 'req-1',
        manufacturer: '3M Solar',
        filmName: 'Prestige 40 Exterior',
        widthIn: 36,
        requiredFeet: 30,
        notes: '',
        createdAt: '2026-04-15T08:00:00Z',
        createdBy: 'tester',
        updatedAt: '2026-04-15T08:00:00Z',
        updatedBy: 'tester'
      }
    ]
  );
  assert.equal(requirementsClient.calls[1].params[3], '3M Solar');
  assert.equal(requirementsClient.calls[1].params[4], 'Prestige 40 Exterior');

  const filmOrdersClient = createRecordingClient([[]]);
  await saveFilmOrderRecord(filmOrdersClient, 'org-1', {
    filmOrderId: 'fo-1',
    jobId: 'job-1',
    jobNumber: '19413',
    warehouse: 'IL1',
    manufacturer: '3M Solar',
    filmName: 'Prestige 40 Exterior',
    widthIn: 36,
    requestedFeet: 30,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 30,
    installDate: '2026-04-15',
    crewLeader: 'Alexis',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    createdAt: '2026-04-15T08:00:00Z',
    createdBy: 'tester'
  });
  assert.equal(filmOrdersClient.calls[0].params[5], '3M Solar');
  assert.equal(filmOrdersClient.calls[0].params[6], 'Prestige 40 Exterior');
});
