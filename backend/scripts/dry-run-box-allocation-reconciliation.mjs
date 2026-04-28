#!/usr/bin/env node

import {
  buildBoxReconciliationReports,
  buildClient,
  fetchSchemaPreflight,
  metadataForConfig,
  parseArgs,
  planBoxAllocationDecisions,
  readJson,
  requireSchemaChecks,
  resolveLegacyReconciliationConfig,
  withReadOnlyTransaction,
  withWriteTransaction,
  writeJson
} from "./lib/legacy-reconciliation-dry-run.mjs";

const SCRIPT_NAME = "box-allocation-reconciliation";

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function asUpperTrimmedString(value) {
  return asTrimmedString(value).toUpperCase();
}

function integerOrZero(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(Math.trunc(parsed), 0);
}

async function fetchAffectedBoxes(client, orgId, options) {
  const boxId = asTrimmedString(options["box-id"]);
  const limit = Number.parseInt(asTrimmedString(options.limit), 10);
  const result = await client.query(
    `
      select *
      from (
        select
          b.box_id,
          b.status,
          b.manufacturer,
          b.film_name,
          b.width_in,
          b.initial_feet,
          b.feet_available,
          app_api.box_physical_feet_available(b) as physical_lf,
          (
            select coalesce(sum(a.allocated_feet), 0)::integer
            from app.allocations a
            where a.org_id = b.org_id
              and a.box_id = b.box_id
              and a.status = 'ACTIVE'
              and app_api.film_allocation_reserves_capacity(a, 'IN_STOCK')
          ) as total_active_reserved_lf,
          (
            select coalesce(sum(a.allocated_feet), 0)::integer
            from app.allocations a
            where a.org_id = b.org_id
              and a.box_id = b.box_id
              and a.status = 'ACTIVE'
              and app_api.film_allocation_consumes_stored_capacity(a, 'IN_STOCK')
          ) as total_active_stored_lf
        from app.boxes b
        where b.org_id = $1::uuid
          and upper(coalesce(b.status::text, '')) in ('IN_STOCK', 'TRANSFER')
          and ($2::text = '' or upper(b.box_id) = upper($2::text))
      ) candidate
      where coalesce(total_active_reserved_lf, 0) > coalesce(physical_lf, 0)
      order by (coalesce(total_active_reserved_lf, 0) - coalesce(physical_lf, 0)) desc,
               box_id asc
      limit nullif($3::integer, 0)
    `,
    [orgId, boxId, Number.isFinite(limit) && limit > 0 ? limit : 0]
  );

  return result.rows;
}

async function fetchBoxAllocations(client, orgId, boxIds) {
  if (boxIds.length === 0) {
    return [];
  }

  const result = await client.query(
    `
      select
        a.allocation_id,
        a.box_id,
        a.job_id,
        a.job_number,
        a.requirement_id,
        a.film_order_id,
        a.status,
        a.allocation_kind,
        a.allocation_source,
        a.job_date,
        a.allocated_feet,
        a.covered_feet,
        a.created_at,
        b.width_in as source_width_in,
        coalesce(r.width_in, b.width_in) as requirement_width_in,
        app_api.film_allocation_consumes_stored_capacity(a, 'IN_STOCK') as consumes_stored_capacity
      from app.allocations a
      join app.boxes b
        on b.org_id = a.org_id
       and b.box_id = a.box_id
      left join app.job_requirements r
        on r.org_id = a.org_id
       and r.id = a.requirement_id
      where a.org_id = $1::uuid
        and a.box_id = any($2::text[])
        and a.status = 'ACTIVE'
        and app_api.film_allocation_reserves_capacity(a, 'IN_STOCK')
      order by a.box_id asc, a.created_at asc, a.allocation_id asc
    `,
    [orgId, boxIds]
  );

  return result.rows;
}

async function fetchAffectedRequirements(client, orgId, jobNumbers) {
  if (jobNumbers.length === 0) {
    return [];
  }

  const result = await client.query(
    `
      select
        r.id as requirement_id,
        r.job_id,
        j.job_number,
        j.lifecycle_status,
        r.manufacturer,
        r.film_name,
        r.width_in,
        r.required_feet
      from app.job_requirements r
      join app.jobs j
        on j.org_id = r.org_id
       and j.id = r.job_id
      where r.org_id = $1::uuid
        and upper(trim(j.job_number)) = any($2::text[])
      order by j.job_number asc, r.created_at asc, r.id asc
    `,
    [orgId, jobNumbers.map(asUpperTrimmedString)]
  );

  return result.rows;
}

async function fetchRequirementAllocations(client, orgId, requirementIds) {
  if (requirementIds.length === 0) {
    return [];
  }

  const result = await client.query(
    `
      select
        a.allocation_id,
        a.box_id,
        a.job_id,
        a.job_number,
        a.requirement_id,
        a.film_order_id,
        a.status,
        a.allocation_kind,
        a.allocation_source,
        a.job_date,
        a.allocated_feet,
        a.covered_feet,
        a.created_at,
        b.width_in as source_width_in,
        r.width_in as requirement_width_in,
        app_api.film_allocation_consumes_stored_capacity(a, b.status::text) as consumes_stored_capacity
      from app.allocations a
      join app.boxes b
        on b.org_id = a.org_id
       and b.box_id = a.box_id
      join app.job_requirements r
        on r.org_id = a.org_id
       and r.id = a.requirement_id
      where a.org_id = $1::uuid
        and a.requirement_id = any($2::uuid[])
        and a.status = 'ACTIVE'
        and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
        and coalesce(b.status::text, '') not in ('ZEROED', 'RETIRED')
        and app_api.requirement_film_is_compatible(
          a.org_id,
          b.manufacturer,
          b.film_name,
          r.manufacturer,
          r.film_name
        )
        and coalesce(b.width_in, 0) >= coalesce(r.width_in, 0)
      order by a.requirement_id asc, a.created_at asc, a.allocation_id asc
    `,
    [orgId, requirementIds]
  );

  return result.rows;
}

async function fetchMatchedFilmOrders(client, orgId, requirementIds) {
  if (requirementIds.length === 0) {
    return [];
  }

  const result = await client.query(
    `
      select
        r.id as matched_requirement_id,
        fo.film_order_id,
        fo.status,
        fo.requested_feet,
        fo.ordered_feet,
        fo.covered_feet,
        fo.remaining_to_order_feet,
        fo.created_at
      from app.job_requirements r
      join app.jobs j
        on j.org_id = r.org_id
       and j.id = r.job_id
      join app.film_orders fo
        on fo.org_id = r.org_id
       and (fo.job_id is null or fo.job_id = r.job_id)
       and (
         trim(coalesce(fo.job_number, '')) = ''
         or upper(trim(fo.job_number)) = upper(trim(j.job_number))
       )
       and (
         fo.job_id is not null
         or trim(coalesce(fo.job_number, '')) <> ''
       )
       and coalesce(fo.status::text, '') in ('FILM_ORDER', 'FILM_ON_THE_WAY')
       and app_api.film_order_matches_requirement(
         fo.org_id,
         fo.requirement_id,
         fo.manufacturer,
         fo.film_name,
         fo.width_in,
         r.id,
         r.manufacturer,
         r.film_name,
         r.width_in
       )
      where r.org_id = $1::uuid
        and r.id = any($2::uuid[])
      order by r.id asc, fo.created_at asc, fo.film_order_id asc
    `,
    [orgId, requirementIds]
  );

  return result.rows;
}

function affectedJobNumbersFromBoxPlans(boxRows, allocationRows) {
  const allocationsByBox = new Map();
  for (const row of allocationRows) {
    const boxId = asUpperTrimmedString(row.box_id);
    if (!allocationsByBox.has(boxId)) {
      allocationsByBox.set(boxId, []);
    }
    allocationsByBox.get(boxId).push(row);
  }

  const jobNumbers = new Set();
  for (const box of boxRows) {
    const decisions = planBoxAllocationDecisions(
      { physicalLf: box.physical_lf },
      allocationsByBox.get(asUpperTrimmedString(box.box_id)) || []
    );
    for (const decision of decisions) {
      if (decision.decision !== "preserve" && decision.jobNumber) {
        jobNumbers.add(asUpperTrimmedString(decision.jobNumber));
      }
    }
  }

  return Array.from(jobNumbers).sort((left, right) =>
    left.localeCompare(right, "en-US", { numeric: true, sensitivity: "base" })
  );
}

function requireReviewedReport(config, report) {
  if (report?.metadata?.script !== SCRIPT_NAME) {
    throw new Error(`Reviewed report script mismatch. Expected ${SCRIPT_NAME}.`);
  }
  if (report?.metadata?.mode !== "dry-run") {
    throw new Error("Reviewed report must be a dry-run artifact.");
  }
  if (report?.metadata?.projectRef !== config.supabaseProjectRef) {
    throw new Error("Reviewed report project ref does not match the current DEV project ref.");
  }
  if (report?.metadata?.orgId !== config.orgId) {
    throw new Error("Reviewed report org id does not match --org-id.");
  }
}

function decisionSignature(entry) {
  return {
    allocationId: entry.allocationId,
    jobNumber: entry.jobNumber,
    requirementId: entry.requirementId,
    decision: entry.decision,
    beforeAllocatedFeet: integerOrZero(entry.beforeAllocatedFeet),
    afterAllocatedFeet: integerOrZero(entry.afterAllocatedFeet),
    beforeCoveredFeet: integerOrZero(entry.beforeCoveredFeet),
    afterCoveredFeet: integerOrZero(entry.afterCoveredFeet)
  };
}

function reviewedBoxSignature(box) {
  return {
    boxId: asUpperTrimmedString(box.boxId),
    physicalLf: integerOrZero(box.physicalLf),
    storedFeetAvailable: integerOrZero(box.storedFeetAvailable),
    totalActiveReservedLf: integerOrZero(box.totalActiveReservedLf),
    overAllocatedLf: integerOrZero(box.overAllocatedLf),
    activeAllocations: (box.activeAllocations || []).map(decisionSignature)
  };
}

function liveBoxSignature(boxRow, allocationRows) {
  const physicalLf = integerOrZero(boxRow.physical_lf);
  const totalActiveReservedLf = integerOrZero(boxRow.total_active_reserved_lf);
  const decisions = planBoxAllocationDecisions({ physicalLf }, allocationRows);
  return {
    boxId: asUpperTrimmedString(boxRow.box_id),
    physicalLf,
    storedFeetAvailable: integerOrZero(boxRow.feet_available),
    totalActiveReservedLf,
    overAllocatedLf: Math.max(totalActiveReservedLf - physicalLf, 0),
    activeAllocations: decisions.map(decisionSignature)
  };
}

function boxMatchesReviewed(liveSignature, reviewedSignature) {
  return JSON.stringify(liveSignature) === JSON.stringify(reviewedSignature);
}

async function lockBoxAndActiveAllocations(client, orgId, boxId) {
  const boxResult = await client.query(
    `
      select id
      from app.boxes
      where org_id = $1::uuid
        and upper(box_id) = upper($2::text)
      for update
    `,
    [orgId, boxId]
  );
  if (boxResult.rowCount !== 1) {
    return false;
  }

  await client.query(
    `
      select a.id
      from app.allocations a
      where a.org_id = $1::uuid
        and upper(a.box_id) = upper($2::text)
        and a.status = 'ACTIVE'
        and app_api.film_allocation_reserves_capacity(a, 'IN_STOCK')
      order by a.created_at asc, a.allocation_id asc
      for update
    `,
    [orgId, boxId]
  );

  return true;
}

async function applyReviewedBox(client, config, reviewedBox) {
  return withWriteTransaction(client, async () => {
    const locked = await lockBoxAndActiveAllocations(client, config.orgId, reviewedBox.boxId);
    if (!locked) {
      return { boxId: reviewedBox.boxId, applied: false, reason: "BOX_NOT_FOUND" };
    }

    const liveBoxRows = await fetchAffectedBoxes(client, config.orgId, { "box-id": reviewedBox.boxId });
    if (liveBoxRows.length !== 1) {
      return { boxId: reviewedBox.boxId, applied: false, reason: "NO_LONGER_OVERALLOCATED" };
    }

    const liveAllocationRows = await fetchBoxAllocations(client, config.orgId, [reviewedBox.boxId]);
    const liveSignature = liveBoxSignature(liveBoxRows[0], liveAllocationRows);
    const reviewedSignature = reviewedBoxSignature(reviewedBox);
    if (!boxMatchesReviewed(liveSignature, reviewedSignature)) {
      return {
        boxId: reviewedBox.boxId,
        applied: false,
        reason: "LIVE_ROW_CHANGED",
        reviewed: reviewedSignature,
        live: liveSignature
      };
    }

    const reconciliationResult = await client.query(
      `
        select app_api.reconcile_box_checkin_allocations(
          $1::uuid,
          $2::text,
          $3::text,
          $4::integer
        ) as result
      `,
      [config.orgId, config.actor, reviewedBox.boxId, reviewedSignature.physicalLf]
    );
    const result = reconciliationResult.rows[0]?.result || {};
    const feetAvailable = integerOrZero(result.feetAvailable);

    await client.query(
      `
        update app.boxes
        set feet_available = $3::integer
        where org_id = $1::uuid
          and upper(box_id) = upper($2::text)
      `,
      [config.orgId, reviewedBox.boxId, feetAvailable]
    );

    const verification = await client.query(
      `
        select
          b.box_id,
          app_api.box_physical_feet_available(b) as physical_lf,
          coalesce((
            select sum(a.allocated_feet)::integer
            from app.allocations a
            where a.org_id = b.org_id
              and a.box_id = b.box_id
              and a.status = 'ACTIVE'
              and app_api.film_allocation_reserves_capacity(a, 'IN_STOCK')
          ), 0) as active_reserved_lf,
          b.feet_available
        from app.boxes b
        where b.org_id = $1::uuid
          and upper(b.box_id) = upper($2::text)
      `,
      [config.orgId, reviewedBox.boxId]
    );
    const verified = verification.rows[0] || {};
    if (integerOrZero(verified.active_reserved_lf) > integerOrZero(verified.physical_lf)) {
      throw new Error(`Post-apply invariant failed for box ${reviewedBox.boxId}.`);
    }

    return {
      boxId: reviewedBox.boxId,
      applied: true,
      result,
      verification: verified
    };
  });
}

async function applyReviewedReconciliation(client, config, reviewedReport) {
  requireReviewedReport(config, reviewedReport);
  const schemaChecks = await fetchSchemaPreflight(client);
  requireSchemaChecks(schemaChecks, [
    "allocationsRequirementId",
    "allocationsCoveredFeet",
    "filmOrdersRequirementId",
    "filmOrderMatchesRequirement",
    "boxPhysicalFeetAvailable",
    "filmAllocationReservesCapacity",
    "filmAllocationConsumesStoredCapacity",
    "computeCoveredFeetFromAllocation",
    "requirementFilmIsCompatible"
  ]);

  const boxes = reviewedReport.allocationReconciliation?.boxes || [];
  const summary = {
    reviewedBoxes: boxes.length,
    appliedBoxes: 0,
    skippedBoxes: 0,
    allocationsReduced: 0,
    allocationsCancelled: 0,
    affectedJobNumbers: [],
    boxResults: []
  };
  const affectedJobNumbers = new Set();

  for (const box of boxes) {
    const boxResult = await applyReviewedBox(client, config, box);
    summary.boxResults.push(boxResult);
    if (!boxResult.applied) {
      summary.skippedBoxes += 1;
      continue;
    }

    summary.appliedBoxes += 1;
    summary.allocationsReduced += integerOrZero(boxResult.result?.reducedCount);
    summary.allocationsCancelled += integerOrZero(boxResult.result?.cancelledCount);
    for (const jobNumber of boxResult.result?.affectedJobNumbers || box.affectedJobNumbers || []) {
      if (jobNumber) {
        affectedJobNumbers.add(String(jobNumber));
      }
    }
  }

  summary.affectedJobNumbers = Array.from(affectedJobNumbers).sort((left, right) =>
    left.localeCompare(right, "en-US", { numeric: true, sensitivity: "base" })
  );
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = resolveLegacyReconciliationConfig(options, SCRIPT_NAME, { allowApply: true });
  const client = buildClient(config.databaseUrl, SCRIPT_NAME);

  await client.connect();
  try {
    if (config.mode === "apply") {
      const reviewedReport = readJson(config.reviewedReportPath);
      const summary = await applyReviewedReconciliation(client, config, reviewedReport);
      console.log(
        JSON.stringify(
          {
            mode: "apply",
            script: SCRIPT_NAME,
            projectRef: config.supabaseProjectRef,
            orgId: config.orgId,
            reviewedReport: config.reviewedReportPath,
            summary
          },
          null,
          2
        )
      );
      return;
    }

    const report = await withReadOnlyTransaction(client, async () => {
      const schemaChecks = await fetchSchemaPreflight(client);
      requireSchemaChecks(schemaChecks, [
        "allocationsRequirementId",
        "allocationsCoveredFeet",
        "filmOrdersRequirementId",
        "filmOrderMatchesRequirement",
        "boxPhysicalFeetAvailable",
        "filmAllocationReservesCapacity",
        "filmAllocationConsumesStoredCapacity",
        "computeCoveredFeetFromAllocation",
        "requirementFilmIsCompatible"
      ]);

      const boxRows = await fetchAffectedBoxes(client, config.orgId, options);
      const boxIds = boxRows.map((row) => row.box_id);
      const allocationRows = await fetchBoxAllocations(client, config.orgId, boxIds);
      const affectedJobNumbers = affectedJobNumbersFromBoxPlans(boxRows, allocationRows);
      const requirementRows = await fetchAffectedRequirements(client, config.orgId, affectedJobNumbers);
      const requirementIds = requirementRows.map((row) => row.requirement_id);
      const jobAllocationRows = await fetchRequirementAllocations(client, config.orgId, requirementIds);
      const matchedFilmOrderRows = await fetchMatchedFilmOrders(client, config.orgId, requirementIds);
      const reconciliation = buildBoxReconciliationReports({
        boxRows,
        allocationRows,
        requirementRows,
        jobAllocationRows,
        matchedFilmOrderRows
      });

      return {
        metadata: metadataForConfig(config, {
          schemaChecks,
          physicalLfSource: "app_api.box_physical_feet_available(box)",
          reservationPriority: ["allocation.created_at asc", "allocation.allocation_id asc"],
          statusScope: "film requirements; lifecycle COMPLETED/CANCELLED overrides are preserved"
        }),
        allocationReconciliation: reconciliation
      };
    });

    writeJson(config.reportPath, report);
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          script: SCRIPT_NAME,
          projectRef: config.supabaseProjectRef,
          orgId: config.orgId,
          output: config.reportPath,
          summary: report.allocationReconciliation.summary
        },
        null,
        2
      )
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[${SCRIPT_NAME}] ${error.message}`);
  process.exitCode = 1;
});
