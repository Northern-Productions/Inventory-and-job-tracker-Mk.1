import test from "node:test";
import assert from "node:assert/strict";
import {
  applyZeroCandidates,
  buildIl1ShelfAuditZeroOutPayload,
  buildShelfAuditDiff,
  parseShelfAuditText,
  validateApplyCandidates
} from "./il1-shelf-audit.mjs";

test("parseShelfAuditText extracts only 4+ digit box suffixes and tracks duplicates", () => {
  const parsed = parseShelfAuditText(
    `
      3M Solar

      6677, 6723, 6396
      Solyx
      4026, 4026, 6380
    `,
    "IL1"
  );

  assert.equal(parsed.sourceEntryCount, 6);
  assert.equal(parsed.uniqueEntryCount, 5);
  assert.deepEqual(parsed.shelfBoxIds, ["IL1-4026", "IL1-6380", "IL1-6396", "IL1-6677", "IL1-6723"]);
  assert.deepEqual(parsed.duplicateSourceIds, [
    {
      suffix: "4026",
      boxId: "IL1-4026",
      occurrenceCount: 2
    }
  ]);
});

test("buildShelfAuditDiff buckets active, checked-out, zeroed, and missing IDs exactly", () => {
  const parsed = parseShelfAuditText("6677, 6805, 6900, 7777", "IL1");
  const diff = buildShelfAuditDiff(
    [
      {
        box_id: "IL1-6677",
        warehouse: "IL1",
        manufacturer: "3M Solar",
        film_name: "Prestige 50",
        width_in: 60,
        status: "IN_STOCK",
        feet_available: 25
      },
      {
        box_id: "IL1-6700",
        warehouse: "IL1",
        manufacturer: "3M Solar",
        film_name: "Prestige 70",
        width_in: 60,
        status: "IN_STOCK",
        feet_available: 18
      },
      {
        box_id: "IL1-6900",
        warehouse: "IL1",
        manufacturer: "Madico",
        film_name: "Safetyshield 800",
        width_in: 60,
        status: "CHECKED_OUT",
        feet_available: 0,
        last_checkout_job: "55555"
      },
      {
        box_id: "IL1-6805",
        warehouse: "IL1",
        manufacturer: "Security",
        film_name: "Ultra S800",
        width_in: 60,
        status: "ZEROED",
        feet_available: 0,
        zeroed_date: "2026-04-01"
      },
      {
        box_id: "MS1-6805",
        warehouse: "MS1",
        manufacturer: "Security",
        film_name: "Ultra S800",
        width_in: 60,
        status: "IN_STOCK",
        feet_available: 10
      }
    ],
    parsed
  );

  assert.deepEqual(diff.activeMatches.map((row) => row.boxId), ["IL1-6677", "IL1-6900"]);
  assert.deepEqual(diff.zeroCandidates.map((row) => row.boxId), ["IL1-6700"]);
  assert.deepEqual(diff.checkedOutExceptions.map((row) => row.boxId), []);
  assert.deepEqual(diff.alreadyZeroedHits.map((row) => row.boxId), ["IL1-6805"]);
  assert.deepEqual(diff.missingIds, [{ boxId: "IL1-7777", suffix: "7777" }]);
  assert.equal(diff.summary.activeInventoryCount, 3);
  assert.equal(diff.summary.matchedActiveCount, 2);
  assert.equal(diff.summary.zeroCandidateCount, 1);
  assert.equal(diff.summary.alreadyZeroedHitCount, 1);
  assert.equal(diff.summary.missingIdCount, 1);
});

test("validateApplyCandidates rejects checked out and unreceived rows", () => {
  assert.throws(
    () =>
      validateApplyCandidates([
        {
          box_id: "IL1-6700",
          warehouse: "IL1",
          manufacturer: "3M Solar",
          film_name: "Prestige 70",
          width_in: 60,
          initial_feet: 100,
          feet_available: 50,
          status: "CHECKED_OUT",
          received_date: "2026-03-01"
        }
      ]),
    /CHECKED_OUT/
  );

  assert.throws(
    () =>
      validateApplyCandidates([
        {
          box_id: "IL1-6701",
          warehouse: "IL1",
          manufacturer: "3M Solar",
          film_name: "Prestige 70",
          width_in: 60,
          initial_feet: 100,
          feet_available: 50,
          status: "ORDERED",
          received_date: ""
        }
      ]),
    /has not been received yet/
  );
});

test("buildIl1ShelfAuditZeroOutPayload preserves edit fields and forces feetAvailable to zero", () => {
  const payload = buildIl1ShelfAuditZeroOutPayload(
    {
      box_id: "IL1-6700",
      warehouse: "IL1",
      manufacturer: "3M Solar",
      film_name: "Prestige 70",
      width_in: 60,
      initial_feet: 100,
      feet_available: 50,
      lot_run: "LOT-1",
      status: "IN_STOCK",
      order_date: "2026-02-01",
      received_date: "2026-02-05",
      initial_weight_lbs: 10.2,
      last_roll_weight_lbs: 8.4,
      last_weighed_date: "2026-03-15",
      film_key: "3M SOLAR|PRESTIGE 70",
      core_type: "White plastic",
      core_weight_lbs: 1.2,
      lf_weight_lbs_per_ft: 0.1,
      price_per_lf: 5.5,
      purchase_cost: 550,
      notes: "shelf audit"
    },
    "IL1 shelf audit reconcile 2026-04-02"
  );

  assert.equal(payload.boxId, "IL1-6700");
  assert.equal(payload.feetAvailable, 0);
  assert.equal(payload.moveToZeroed, true);
  assert.equal(payload.receivedDate, "2026-02-05");
  assert.equal(payload.lastRollWeightLbs, 8.4);
  assert.equal(payload.auditNote, "IL1 shelf audit reconcile 2026-04-02");
});

test("applyZeroCandidates uses the injected updater and returns sorted applied rows", async () => {
  const calls = [];
  const applied = await applyZeroCandidates(
    {},
    "org-1",
    "actor-1",
    [
      {
        box_id: "IL1-6702",
        warehouse: "IL1",
        manufacturer: "3M Solar",
        film_name: "Prestige 50",
        width_in: 60,
        initial_feet: 100,
        feet_available: 20,
        status: "IN_STOCK",
        order_date: "2026-02-01",
        received_date: "2026-02-02",
        initial_weight_lbs: 10,
        last_roll_weight_lbs: 6,
        last_weighed_date: "2026-03-01",
        film_key: "3M SOLAR|PRESTIGE 50",
        core_type: "White plastic",
        core_weight_lbs: 1.2,
        lf_weight_lbs_per_ft: 0.1,
        price_per_lf: 4,
        purchase_cost: 400,
        notes: ""
      },
      {
        box_id: "IL1-6700",
        warehouse: "IL1",
        manufacturer: "Madico",
        film_name: "Safetyshield 800",
        width_in: 60,
        initial_feet: 100,
        feet_available: 30,
        status: "IN_STOCK",
        order_date: "2026-02-01",
        received_date: "2026-02-03",
        initial_weight_lbs: 10,
        last_roll_weight_lbs: 7,
        last_weighed_date: "2026-03-02",
        film_key: "MADICO|SAFETYSHIELD 800",
        core_type: "White plastic",
        core_weight_lbs: 1.2,
        lf_weight_lbs_per_ft: 0.1,
        price_per_lf: 4,
        purchase_cost: 400,
        notes: ""
      }
    ],
    "IL1 shelf audit reconcile 2026-04-02",
    async (_client, _orgId, _actor, payload) => {
      calls.push(payload);
      return {
        logId: `log-${payload.boxId}`,
        warnings: [`${payload.boxId} zeroed`]
      };
    }
  );

  assert.deepEqual(
    calls.map((payload) => payload.boxId),
    ["IL1-6700", "IL1-6702"]
  );
  assert.deepEqual(
    applied.map((row) => row.boxId),
    ["IL1-6700", "IL1-6702"]
  );
  assert.equal(applied[0].warnings, "IL1-6700 zeroed");
});
