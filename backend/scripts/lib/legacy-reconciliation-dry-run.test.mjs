import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  APPLY_CONFIRMATION,
  DEV_PROJECT_REF,
  PROD_PROJECT_REF,
  buildAffectedJobReports,
  buildFilmOrderRequirementBackfillReport,
  planBoxAllocationDecisions,
  resolveDryRunConfig,
  resolveLegacyReconciliationConfig
} from "./legacy-reconciliation-dry-run.mjs";

function writeTempEnv(contents, name = ".env.dev") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-reconciliation-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

test("dry-run config enforces DEV project ref and rejects apply mode", () => {
  const envPath = writeTempEnv(`
SUPABASE_URL=https://${DEV_PROJECT_REF}.supabase.co
DEV_DATABASE_URL=postgresql://postgres:secret@db.${DEV_PROJECT_REF}.supabase.co:5432/postgres
`);

  const config = resolveDryRunConfig(
    {
      env: envPath,
      "expected-project-ref": DEV_PROJECT_REF,
      "org-id": "11111111-1111-4111-8111-111111111111"
    },
    "test-script"
  );

  assert.equal(config.supabaseProjectRef, DEV_PROJECT_REF);
  assert.equal(config.databaseProjectRef, DEV_PROJECT_REF);
  assert.throws(
    () =>
      resolveDryRunConfig(
        {
          env: envPath,
          "expected-project-ref": DEV_PROJECT_REF,
          "org-id": "11111111-1111-4111-8111-111111111111",
          apply: true
        },
        "test-script"
      ),
    /Apply mode is intentionally not implemented/
  );
});

test("legacy apply config requires reviewed report and explicit confirmation", () => {
  const envPath = writeTempEnv(`
SUPABASE_URL=https://${DEV_PROJECT_REF}.supabase.co
DEV_DATABASE_URL=postgresql://postgres:secret@db.${DEV_PROJECT_REF}.supabase.co:5432/postgres
`);

  assert.throws(
    () =>
      resolveLegacyReconciliationConfig(
        {
          env: envPath,
          "expected-project-ref": DEV_PROJECT_REF,
          "org-id": "11111111-1111-4111-8111-111111111111",
          apply: true
        },
        "test-script",
        { allowApply: true }
      ),
    /requires --confirm-apply/
  );

  assert.throws(
    () =>
      resolveLegacyReconciliationConfig(
        {
          env: envPath,
          "expected-project-ref": DEV_PROJECT_REF,
          "org-id": "11111111-1111-4111-8111-111111111111",
          apply: true,
          "confirm-apply": APPLY_CONFIRMATION
        },
        "test-script",
        { allowApply: true }
      ),
    /requires --reviewed-report/
  );

  const config = resolveLegacyReconciliationConfig(
    {
      env: envPath,
      "expected-project-ref": DEV_PROJECT_REF,
      "org-id": "11111111-1111-4111-8111-111111111111",
      apply: true,
      "confirm-apply": APPLY_CONFIRMATION,
      "reviewed-report": "reviewed.json"
    },
    "test-script",
    { allowApply: true }
  );

  assert.equal(config.mode, "apply");
  assert.equal(config.supabaseProjectRef, DEV_PROJECT_REF);
  assert.match(config.reviewedReportPath, /reviewed\.json$/);
});

test("dry-run config hard rejects PROD project refs", () => {
  const envPath = writeTempEnv(
    `
SUPABASE_URL=https://${PROD_PROJECT_REF}.supabase.co
DEV_DATABASE_URL=postgresql://postgres:secret@db.${PROD_PROJECT_REF}.supabase.co:5432/postgres
`,
    ".env.dev"
  );

  assert.throws(
    () =>
      resolveDryRunConfig(
        {
          env: envPath,
          "expected-project-ref": DEV_PROJECT_REF,
          "org-id": "11111111-1111-4111-8111-111111111111"
        },
        "test-script"
      ),
    /Refusing to run against PROD/
  );
});

test("box allocation dry-run preserves reservation order and reduces/cancels later rows", () => {
  const decisions = planBoxAllocationDecisions(
    { physicalLf: 22 },
    [
      {
        allocation_id: "ALLOC-003",
        box_id: "IL1-1234",
        job_number: "3003",
        requirement_id: "33333333-3333-4333-8333-333333333333",
        allocated_feet: 18,
        covered_feet: 18,
        source_width_in: 60,
        requirement_width_in: 60,
        created_at: "2026-04-01T10:02:00Z"
      },
      {
        allocation_id: "ALLOC-001",
        box_id: "IL1-1234",
        job_number: "3001",
        requirement_id: "11111111-1111-4111-8111-111111111111",
        allocated_feet: 20,
        covered_feet: 20,
        source_width_in: 60,
        requirement_width_in: 60,
        created_at: "2026-04-01T10:00:00Z"
      },
      {
        allocation_id: "ALLOC-002",
        box_id: "IL1-1234",
        job_number: "3002",
        requirement_id: "22222222-2222-4222-8222-222222222222",
        allocated_feet: 20,
        covered_feet: 20,
        source_width_in: 60,
        requirement_width_in: 60,
        created_at: "2026-04-01T10:01:00Z"
      }
    ]
  );

  assert.deepEqual(
    decisions.map((entry) => [entry.allocationId, entry.decision, entry.afterAllocatedFeet]),
    [
      ["ALLOC-001", "preserve", 20],
      ["ALLOC-002", "reduce", 2],
      ["ALLOC-003", "cancel", 0]
    ]
  );
});

test("film-order backfill report links exactly one match and reports ambiguous/unmatched rows", () => {
  const report = buildFilmOrderRequirementBackfillReport([
    {
      film_order_id: "FO-1",
      status: "FILM_ORDER",
      job_number: "3001",
      manufacturer: "3M",
      film_name: "Prestige 40",
      width_in: 60,
      matching_requirements: [
        {
          requirementId: "11111111-1111-4111-8111-111111111111",
          jobNumber: "3001",
          manufacturer: "3M",
          filmName: "Prestige 40",
          widthIn: 60,
          requiredFeet: 50
        }
      ]
    },
    {
      film_order_id: "FO-2",
      status: "FILM_ORDER",
      job_number: "3002",
      matching_requirements: [
        { requirementId: "22222222-2222-4222-8222-222222222222" },
        { requirementId: "33333333-3333-4333-8333-333333333333" }
      ]
    },
    {
      film_order_id: "FO-3",
      status: "FILM_ORDER",
      job_number: "3003",
      matching_requirements: []
    }
  ]);

  assert.equal(report.summary.wouldBackfill, 1);
  assert.equal(report.summary.ambiguous, 1);
  assert.equal(report.summary.unmatched, 1);
  assert.equal(report.candidates[0].wouldSetRequirementId, "11111111-1111-4111-8111-111111111111");
});

test("affected job report prefers orderedFeet for FILM_ON_THE_WAY and flags user-approved shortages", () => {
  const report = buildAffectedJobReports({
    requirementRows: [
      {
        requirement_id: "11111111-1111-4111-8111-111111111111",
        job_id: "job-1",
        job_number: "3001",
        lifecycle_status: "ACTIVE",
        manufacturer: "3M",
        film_name: "Prestige 40",
        width_in: 60,
        required_feet: 50
      }
    ],
    allocationRows: [],
    matchedFilmOrderRows: [
      {
        matched_requirement_id: "11111111-1111-4111-8111-111111111111",
        film_order_id: "FO-OTW",
        status: "FILM_ON_THE_WAY",
        ordered_feet: 25,
        requested_feet: 50
      }
    ],
    simulatedAllocationDecisions: []
  });

  assert.equal(report[0].resultingJobStatus, "FILM_ORDER");
  assert.equal(report[0].requirementStatuses[0].filmOnTheWayCoverage, 25);
  assert.equal(report[0].requirementStatuses[0].needsUserApprovedFilmOrder, true);
});

test("affected job report updates existing editable FILM_ORDER instead of creating one", () => {
  const report = buildAffectedJobReports({
    requirementRows: [
      {
        requirement_id: "11111111-1111-4111-8111-111111111111",
        job_id: "job-1",
        job_number: "3001",
        lifecycle_status: "ACTIVE",
        manufacturer: "3M",
        film_name: "Prestige 40",
        width_in: 60,
        required_feet: 50
      }
    ],
    allocationRows: [
      {
        allocation_id: "ALLOC-1",
        requirement_id: "11111111-1111-4111-8111-111111111111",
        job_number: "3001",
        allocated_feet: 20,
        covered_feet: 20
      }
    ],
    matchedFilmOrderRows: [
      {
        matched_requirement_id: "11111111-1111-4111-8111-111111111111",
        film_order_id: "FO-EDIT",
        status: "FILM_ORDER",
        requested_feet: 10
      }
    ],
    simulatedAllocationDecisions: []
  });

  const requirement = report[0].requirementStatuses[0];
  assert.equal(report[0].resultingJobStatus, "FILM_ORDER");
  assert.equal(requirement.neededOrderFeet, 30);
  assert.equal(requirement.needsUserApprovedFilmOrder, false);
  assert.deepEqual(requirement.existingFilmOrderUpdate, {
    filmOrderId: "FO-EDIT",
    wouldUpdateRequestedFeetTo: 30,
    wouldUpdateRemainingToOrderFeetTo: 30,
    wouldUpdateStatusTo: "FILM_ORDER"
  });
});
