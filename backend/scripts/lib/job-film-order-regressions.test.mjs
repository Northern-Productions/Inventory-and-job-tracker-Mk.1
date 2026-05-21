import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCanonicalManufacturerAndFilm,
  normalizeJobRequirementEntriesForWrite
} from '../../src/app/core/catalog.mjs';
import { saveFilmOrderRecord } from '../../src/app/repositories/inventoryRecordsRepository.mjs';
import { replaceJobRequirementsForJob } from '../../src/app/repositories/jobsRepository.mjs';
import {
  buildJobListEntry,
  deriveInStockReadinessStatus
} from '../../src/app/services/runtime/runtimeJobSummaries.mjs';
import {
  buildPublicJobRequirementEntries,
  buildPublicCaulkRequirementEntries,
  maybeLogCaulkFallbackCoverageDecision
} from '../../src/app/services/runtime/runtimeAllocationCoverage.mjs';
import { buildRequirementRowsForReplace } from '../../src/app/services/runtime/runtimeCollectionsAndBoxes.mjs';
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
    '19413',
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
    jobNumber: '19413',
    manufacturer: '3M Solar',
    itemName: 'Prestige 40 Exterior',
    itemCode: '',
    widthIn: 0,
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

test('deriveInStockReadinessStatus derives film readiness from strict stored allocation coverage', () => {
  const base = {
    jobNumber: '19413',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    requirements: [
      {
        requirementId: 'req-1',
        jobNumber: '19413',
        manufacturer: 'Security',
        filmName: 'Madico Safetyshield 800',
        widthIn: 60,
        requiredFeet: 40,
        remainingFeet: 40
      }
    ],
    caulkRequirements: [],
    allocations: [
      {
        allocationId: 'alloc-checked-out',
        boxId: 'IL1-CHECKED-OUT',
        jobNumber: '19413',
        requirementId: 'req-1',
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
        allocatedFeet: 40,
        coveredFeet: 40
      }
    ],
    caulkAllocations: [],
    filmOrders: [],
    caulkStockEntries: [],
    jobWarehouse: 'IL1',
    allBoxes: [
      {
        boxId: 'IL1-CHECKED-OUT',
        warehouse: 'IL1',
        status: 'CHECKED_OUT',
        manufacturer: 'Security',
        filmName: 'Madico Safetyshield 800',
        widthIn: 60,
        feetAvailable: 0
      }
    ]
  };

  assert.equal(
    deriveInStockReadinessStatus(base),
    'READY'
  );
  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      allocations: [],
      allBoxes: base.allBoxes.map((box) => ({ ...box, status: 'IN_STOCK', feetAvailable: 100 }))
    }),
    'FILM_ORDER'
  );
  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      allocations: [
        {
          ...base.allocations[0],
          allocatedFeet: 25,
          coveredFeet: 25
        }
      ]
    }),
    'FILM_ORDER'
  );
});

test('deriveInStockReadinessStatus excludes invalid film allocation coverage', () => {
  const base = {
    jobNumber: '19413',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    requirements: [
      {
        requirementId: 'req-1',
        jobNumber: '19413',
        manufacturer: 'Security',
        filmName: 'Madico Safetyshield 800',
        widthIn: 60,
        requiredFeet: 40
      }
    ],
    caulkRequirements: [],
    allocations: [],
    caulkAllocations: [],
    filmOrders: [],
    allBoxes: [
      {
        boxId: 'IL1-BOX',
        warehouse: 'IL1',
        status: 'CHECKED_OUT',
        manufacturer: 'Security',
        filmName: 'Madico Safetyshield 800',
        widthIn: 60
      }
    ],
    caulkStockEntries: [],
    jobWarehouse: 'IL1'
  };

  const validAllocation = {
    allocationId: 'alloc-1',
    boxId: 'IL1-BOX',
    jobNumber: '19413',
    requirementId: 'req-1',
    status: 'ACTIVE',
    allocationKind: 'REQUIREMENT',
    allocatedFeet: 40,
    coveredFeet: 40
  };

  const invalidCases = [
    { ...validAllocation, status: 'CANCELLED' },
    { ...validAllocation, jobNumber: '99999' },
    { ...validAllocation, allocationKind: 'EXTRA' },
    { ...validAllocation, boxId: 'IL1-MISSING' }
  ];

  for (const allocation of invalidCases) {
    assert.equal(
      deriveInStockReadinessStatus({
        ...base,
        allocations: [allocation]
      }),
      'FILM_ORDER'
    );
  }

  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      allocations: [{ ...validAllocation, requirementId: 'req-stale' }]
    }),
    'READY'
  );
  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      allocations: [{ ...validAllocation, requirementId: '' }]
    }),
    'READY'
  );

  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      allBoxes: [{ ...base.allBoxes[0], filmName: 'Different Film' }],
      allocations: [validAllocation]
    }),
    'FILM_ORDER'
  );
  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      allBoxes: [{ ...base.allBoxes[0], widthIn: 48 }],
      allocations: [validAllocation]
    }),
    'FILM_ORDER'
  );
});

test('deriveInStockReadinessStatus requires every material requirement to be covered', () => {
  const base = {
    jobNumber: '19413',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    requirements: [
      {
        requirementId: 'req-1',
        jobNumber: '19413',
        manufacturer: 'Security',
        filmName: 'Madico Safetyshield 800',
        widthIn: 60,
        requiredFeet: 40
      },
      {
        requirementId: 'req-2',
        jobNumber: '19413',
        manufacturer: 'Security',
        filmName: 'Madico Safetyshield 800',
        widthIn: 48,
        requiredFeet: 20
      }
    ],
    caulkRequirements: [],
    caulkAllocations: [],
    filmOrders: [],
    allBoxes: [
      {
        boxId: 'IL1-BOX-1',
        warehouse: 'IL1',
        status: 'CHECKED_OUT',
        manufacturer: 'Security',
        filmName: 'Madico Safetyshield 800',
        widthIn: 60
      },
      {
        boxId: 'IL1-BOX-2',
        warehouse: 'IL1',
        status: 'IN_STOCK',
        manufacturer: 'Security',
        filmName: 'Madico Safetyshield 800',
        widthIn: 48
      }
    ],
    caulkStockEntries: [],
    jobWarehouse: 'IL1'
  };

  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      allocations: [
        {
          allocationId: 'alloc-1',
          boxId: 'IL1-BOX-1',
          jobNumber: '19413',
          requirementId: 'req-1',
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocatedFeet: 40,
          coveredFeet: 40
        }
      ]
    }),
    'FILM_ORDER'
  );

  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      allocations: [
        {
          allocationId: 'alloc-1',
          boxId: 'IL1-BOX-1',
          jobNumber: '19413',
          requirementId: 'req-1',
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocatedFeet: 40,
          coveredFeet: 40
        },
        {
          allocationId: 'alloc-2',
          boxId: 'IL1-BOX-2',
          jobNumber: '19413',
          requirementId: 'req-2',
          status: 'FULFILLED',
          allocationKind: 'REQUIREMENT',
          allocatedFeet: 20,
          coveredFeet: 20
        }
      ]
    }),
    'READY'
  );
});

test('deriveInStockReadinessStatus derives caulk readiness from canonical linked and fallback coverage', () => {
  const base = {
    jobNumber: '19413',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    requirements: [],
    caulkRequirements: [
      {
        requirementId: 'caulk-req-1',
        jobNumber: '19413',
        productId: 'product-1',
        requiredTubes: 6,
        remainingTubes: 6
      }
    ],
    allocations: [],
    caulkAllocations: [],
    filmOrders: [],
    allBoxes: [],
    jobWarehouse: 'IL1'
  };

  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      caulkAllocations: [
        {
          requirementId: 'caulk-req-1',
          jobNumber: '19413',
          productId: 'product-1',
          status: 'ACTIVE',
          allocatedTubes: 6,
          reservedTubesRemaining: 6
        }
      ],
      caulkStockEntries: []
    }),
    'READY'
  );
  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      caulkAllocations: [
        {
          caulkAllocationId: 'caulk-alloc-unbound',
          requirementId: '',
          jobNumber: '19413',
          productId: 'product-1',
          warehouse: 'IL1',
          status: 'ACTIVE',
          allocatedTubes: 6,
          reservedTubesRemaining: 6
        }
      ],
      caulkStockEntries: []
    }),
    'READY'
  );
  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      caulkAllocations: [],
      caulkStockEntries: [{ productId: 'product-1', warehouse: 'IL1', tubesOnHand: 60 }]
    }),
    'FILM_ORDER'
  );
  assert.equal(
    deriveInStockReadinessStatus({
      ...base,
      caulkAllocations: [
        {
          requirementId: 'caulk-req-stale',
          jobNumber: '19413',
          productId: 'product-1',
          status: 'ACTIVE',
          allocatedTubes: 6,
          reservedTubesRemaining: 6
        }
      ],
      caulkStockEntries: []
    }),
    'FILM_ORDER'
  );
});

test('buildPublicJobRequirementEntries credits unambiguous stale same-job film allocations', () => {
  const requirements = [
    {
      requirementId: 'req-current',
      jobNumber: '19413',
      manufacturer: 'Security',
      filmName: 'Madico Safetyshield 800',
      widthIn: 60,
      requiredFeet: 40
    }
  ];
  const allocations = [
    {
      allocationId: 'alloc-stale',
      boxId: 'IL1-CHECKED-OUT',
      jobNumber: '19413',
      requirementId: 'req-stale',
      status: 'ACTIVE',
      allocationKind: 'REQUIREMENT',
      allocatedFeet: 40,
      coveredFeet: 40,
      resolvedAt: '2026-04-10T10:00:00Z'
    }
  ];
  const boxById = {
    'IL1-CHECKED-OUT': {
      boxId: 'IL1-CHECKED-OUT',
      status: 'CHECKED_OUT',
      lastCheckoutJob: '19413',
      manufacturer: 'Security',
      filmName: 'Madico Safetyshield 800',
      widthIn: 60
    }
  };

  assert.deepEqual(
    buildPublicJobRequirementEntries(requirements, allocations, boxById).map((entry) => ({
      requirementId: entry.requirementId,
      allocatedFeet: entry.allocatedFeet,
      remainingFeet: entry.remainingFeet
    })),
    [{ requirementId: 'req-current', allocatedFeet: 40, remainingFeet: 0 }]
  );
});

test('buildPublicJobRequirementEntries refuses ambiguous stale film allocation fallback', () => {
  const requirements = [
    {
      requirementId: 'req-48',
      jobNumber: '19413',
      manufacturer: 'Security',
      filmName: 'Madico Safetyshield 800',
      widthIn: 48,
      requiredFeet: 20
    },
    {
      requirementId: 'req-60',
      jobNumber: '19413',
      manufacturer: 'Security',
      filmName: 'Madico Safetyshield 800',
      widthIn: 60,
      requiredFeet: 20
    }
  ];
  const allocations = [
    {
      allocationId: 'alloc-ambiguous',
      boxId: 'IL1-WIDE',
      jobNumber: '19413',
      requirementId: 'req-stale',
      status: 'ACTIVE',
      allocationKind: 'REQUIREMENT',
      allocatedFeet: 40,
      coveredFeet: 40
    }
  ];
  const boxById = {
    'IL1-WIDE': {
      boxId: 'IL1-WIDE',
      status: 'CHECKED_OUT',
      lastCheckoutJob: '19413',
      manufacturer: 'Security',
      filmName: 'Madico Safetyshield 800',
      widthIn: 60
    }
  };

  assert.deepEqual(
    buildPublicJobRequirementEntries(requirements, allocations, boxById).map((entry) => ({
      requirementId: entry.requirementId,
      allocatedFeet: entry.allocatedFeet,
      remainingFeet: entry.remainingFeet
    })),
    [
      { requirementId: 'req-48', allocatedFeet: 0, remainingFeet: 20 },
      { requirementId: 'req-60', allocatedFeet: 0, remainingFeet: 20 }
    ]
  );
});

test('buildRequirementRowsForReplace prefers a valid submitted requirement id before lookup key matching', () => {
  const rows = buildRequirementRowsForReplace(
    '19413',
    [
      {
        requirementId: 'req-keep',
        manufacturer: 'Security',
        filmName: 'Madico Safetyshield 800 Canonical',
        widthIn: 60,
        requiredFeet: 40
      }
    ],
    {
      legacy: {
        id: 'req-keep',
        manufacturer: 'Security',
        filmName: 'Madico Safetyshield 800',
        widthIn: 60,
        requiredFeet: 40,
        createdAt: '2026-04-01T00:00:00Z',
        createdBy: 'planner',
        notes: 'keep me'
      }
    },
    'editor',
    '2026-04-10T00:00:00Z'
  );

  assert.equal(rows[0].id, 'req-keep');
  assert.equal(rows[0].createdAt, '2026-04-01T00:00:00Z');
  assert.equal(rows[0].createdBy, 'planner');
  assert.equal(rows[0].notes, 'keep me');
  assert.equal(rows[0].filmName, 'Madico Safetyshield 800 Canonical');
});

test('buildPublicCaulkRequirementEntries applies unbound caulk coverage deterministically without double counting', () => {
  const requirements = [
    {
      requirementId: 'caulk-req-1',
      jobNumber: '19413',
      productId: 'product-1',
      manufacturer: '3M',
      productName: 'IPA Black',
      productCode: '',
      requiredTubes: 10
    },
    {
      requirementId: 'caulk-req-2',
      jobNumber: '19413',
      productId: 'product-1',
      manufacturer: '3M',
      productName: 'IPA Black',
      productCode: '',
      requiredTubes: 10
    }
  ];

  const rows = buildPublicCaulkRequirementEntries(
    requirements,
    [
      {
        caulkAllocationId: 'bound-1',
        requirementId: 'caulk-req-1',
        jobNumber: '19413',
        productId: 'product-1',
        warehouse: 'IL1',
        status: 'ACTIVE',
        allocatedTubes: 6,
        reservedTubesRemaining: 6
      },
      {
        caulkAllocationId: 'fallback-1',
        requirementId: '',
        jobNumber: '19413',
        productId: 'product-1',
        warehouse: 'IL1',
        status: 'ACTIVE',
        allocatedTubes: 12,
        reservedTubesRemaining: 12,
        createdAt: '2026-05-06T12:00:00Z'
      }
    ],
    { jobNumber: '19413', jobWarehouse: 'IL1' }
  );

  assert.deepEqual(
    rows.map((entry) => ({
      requirementId: entry.requirementId,
      allocatedTubes: entry.allocatedTubes,
      remainingTubes: entry.remainingTubes
    })),
    [
      { requirementId: 'caulk-req-1', allocatedTubes: 10, remainingTubes: 0 },
      { requirementId: 'caulk-req-2', allocatedTubes: 8, remainingTubes: 2 }
    ]
  );
});

test('caulk fallback coverage ignores warehouse mismatches and returned unused tubes', () => {
  const requirements = [
    {
      requirementId: 'caulk-req-1',
      jobNumber: '19413',
      productId: 'product-1',
      manufacturer: '3M',
      productName: 'IPA Black',
      productCode: '',
      requiredTubes: 10
    }
  ];

  assert.deepEqual(
    buildPublicCaulkRequirementEntries(
      requirements,
      [
        {
          caulkAllocationId: 'wrong-warehouse',
          requirementId: '',
          jobNumber: '19413',
          productId: 'product-1',
          warehouse: 'MS1',
          status: 'ACTIVE',
          allocatedTubes: 10,
          reservedTubesRemaining: 10
        }
      ],
      { jobNumber: '19413', jobWarehouse: 'IL1' }
    ).map((entry) => entry.remainingTubes),
    [10]
  );

  assert.deepEqual(
    buildPublicCaulkRequirementEntries(
      requirements,
      [
        {
          caulkAllocationId: 'returned-unused',
          requirementId: '',
          jobNumber: '19413',
          productId: 'product-1',
          warehouse: 'IL1',
          status: 'ACTIVE',
          allocatedTubes: 10,
          reservedTubesRemaining: 0,
          checkedOutTubesTotal: 10,
          returnedUnusedTubesTotal: 10,
          usedTubesTotal: 0
        }
      ],
      { jobNumber: '19413', jobWarehouse: 'IL1' }
    ).map((entry) => entry.remainingTubes),
    [10]
  );
});

test('DEV caulk fallback debug logging is opt-in and hard-blocked for PROD', () => {
  const logs = [];
  assert.equal(
    maybeLogCaulkFallbackCoverageDecision(
      {
        allocationId: 'alloc-1',
        jobNumber: '19413',
        productId: 'product-1',
        product: '3M IPA Black',
        tubesApplied: 6,
        requirementIdsFulfilled: ['caulk-req-1']
      },
      {
        env: {
          DEV_CAULK_FALLBACK_DEBUG_LOGS: 'true',
          SUPABASE_URL: 'https://uxiltcpbhthhinonttrc.supabase.co'
        },
        logger: (entry) => logs.push(JSON.parse(entry))
      }
    )?.msg,
    'caulk_fallback_coverage'
  );
  assert.deepEqual(logs, [
    {
      level: 'debug',
      msg: 'caulk_fallback_coverage',
      runtime: 'backend',
      allocationId: 'alloc-1',
      jobNumber: '19413',
      productId: 'product-1',
      product: '3M IPA Black',
      tubesApplied: 6,
      requirementIdsFulfilled: ['caulk-req-1']
    }
  ]);

  assert.equal(
    maybeLogCaulkFallbackCoverageDecision(
      {
        allocationId: 'alloc-prod',
        jobNumber: '19413',
        productId: 'product-1',
        product: '3M IPA Black',
        tubesApplied: 6,
        requirementIdsFulfilled: ['caulk-req-1']
      },
      {
        env: {
          DEV_CAULK_FALLBACK_DEBUG_LOGS: 'true',
          SUPABASE_URL: 'https://tiwpulgvxtwlmqdnyuzd.supabase.co'
        },
        logger: (entry) => logs.push(JSON.parse(entry))
      }
    ),
    null
  );
  assert.equal(logs.length, 1);

  assert.equal(
    maybeLogCaulkFallbackCoverageDecision(
      {
        allocationId: 'alloc-prod-env',
        jobNumber: '19413',
        productId: 'product-1',
        product: '3M IPA Black',
        tubesApplied: 6,
        requirementIdsFulfilled: ['caulk-req-1']
      },
      {
        env: {
          DEV_CAULK_FALLBACK_DEBUG_LOGS: 'true',
          VERCEL_ENV: 'production',
          SUPABASE_URL: 'https://uxiltcpbhthhinonttrc.supabase.co'
        },
        logger: (entry) => logs.push(JSON.parse(entry))
      }
    ),
    null
  );
  assert.equal(logs.length, 1);
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

test('normalizeCanonicalManufacturerAndFilm preserves explicit 3M Solar Prestige variants', () => {
  assert.deepEqual(normalizeCanonicalManufacturerAndFilm('3M Solar', 'Prestige 40'), {
    manufacturer: '3M Solar',
    filmName: 'Prestige 40'
  });
  assert.deepEqual(normalizeCanonicalManufacturerAndFilm('3M Solar', 'Prestige 40 Exterior'), {
    manufacturer: '3M Solar',
    filmName: 'Prestige 40 Exterior'
  });
  assert.deepEqual(
    normalizeCanonicalManufacturerAndFilm('3M Solar', '3M Prestige 40 Exterior (PR40 Ext)'),
    {
      manufacturer: '3M Solar',
      filmName: 'Prestige 40 Exterior (PR40 Ext)'
    }
  );
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
  const requirementInsertCall = requirementsClient.calls.find((call) =>
    String(call.text || '').includes('insert into app.job_requirements')
  );
  assert.ok(requirementInsertCall, 'expected requirement insert call');
  assert.equal(requirementInsertCall.params[3], '3M Solar');
  assert.equal(requirementInsertCall.params[4], 'Prestige 40 Exterior');

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
  assert.equal(filmOrdersClient.calls[0].params[6], '3M Solar');
  assert.equal(filmOrdersClient.calls[0].params[7], 'Prestige 40 Exterior');
});
