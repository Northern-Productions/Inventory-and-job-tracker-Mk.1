#!/usr/bin/env node

import {
  buildClient,
  buildFilmOrderRequirementBackfillReport,
  fetchSchemaPreflight,
  metadataForConfig,
  parseArgs,
  readJson,
  requireSchemaChecks,
  resolveLegacyReconciliationConfig,
  withReadOnlyTransaction,
  withWriteTransaction,
  writeJson
} from "./lib/legacy-reconciliation-dry-run.mjs";

const SCRIPT_NAME = "film-order-requirement-backfill";

async function fetchCandidateFilmOrders(client, orgId) {
  const result = await client.query(
    `
      select
        fo.id,
        fo.film_order_id,
        fo.job_id,
        fo.job_number,
        fo.manufacturer,
        fo.film_name,
        fo.width_in,
        fo.requested_feet,
        fo.ordered_feet,
        fo.covered_feet,
        fo.remaining_to_order_feet,
        fo.status,
        fo.created_at,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'requirementId', r.id,
              'jobId', r.job_id,
              'jobNumber', j.job_number,
              'manufacturer', r.manufacturer,
              'filmName', r.film_name,
              'widthIn', r.width_in,
              'requiredFeet', r.required_feet
            )
            order by r.created_at asc, r.id asc
          ) filter (where r.id is not null),
          '[]'::jsonb
        ) as matching_requirements
      from app.film_orders fo
      left join app.jobs j
        on j.org_id = fo.org_id
       and (
         (fo.job_id is not null and j.id = fo.job_id)
         or (
           fo.job_id is null
           and trim(coalesce(fo.job_number, '')) <> ''
           and upper(trim(j.job_number)) = upper(trim(fo.job_number))
         )
       )
       and (
         trim(coalesce(fo.job_number, '')) = ''
         or upper(trim(j.job_number)) = upper(trim(fo.job_number))
       )
      left join app.job_requirements r
        on r.org_id = fo.org_id
       and r.job_id = j.id
       and app_api.film_order_matches_requirement(
         fo.org_id,
         null::uuid,
         fo.manufacturer,
         fo.film_name,
         fo.width_in,
         null::uuid,
         r.manufacturer,
         r.film_name,
         r.width_in
       )
      where fo.org_id = $1::uuid
        and fo.requirement_id is null
      group by fo.id
      order by fo.created_at asc, fo.film_order_id asc
    `,
    [orgId]
  );

  return result.rows;
}

async function fetchCandidateFilmOrderForUpdate(client, orgId, filmOrderId) {
  const orderResult = await client.query(
    `
      select
        fo.id,
        fo.film_order_id,
        fo.job_id,
        fo.job_number,
        fo.manufacturer,
        fo.film_name,
        fo.width_in,
        fo.requested_feet,
        fo.ordered_feet,
        fo.covered_feet,
        fo.remaining_to_order_feet,
        fo.status,
        fo.created_at,
        fo.requirement_id
      from app.film_orders fo
      where fo.org_id = $1::uuid
        and fo.film_order_id = $2::text
      for update
    `,
    [orgId, filmOrderId]
  );

  const order = orderResult.rows[0];
  if (!order) {
    return { order: null, candidate: null };
  }

  const matchesResult = await client.query(
    `
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'requirementId', r.id,
            'jobId', r.job_id,
            'jobNumber', j.job_number,
            'manufacturer', r.manufacturer,
            'filmName', r.film_name,
            'widthIn', r.width_in,
            'requiredFeet', r.required_feet
          )
          order by r.created_at asc, r.id asc
        ),
        '[]'::jsonb
      ) as matching_requirements
      from app.jobs j
      join app.job_requirements r
        on r.org_id = j.org_id
       and r.job_id = j.id
      where j.org_id = $1::uuid
        and (
          ($2::uuid is not null and j.id = $2::uuid)
          or (
            $2::uuid is null
            and trim(coalesce($3::text, '')) <> ''
            and upper(trim(j.job_number)) = upper(trim($3::text))
          )
        )
        and (
          trim(coalesce($3::text, '')) = ''
          or upper(trim(j.job_number)) = upper(trim($3::text))
        )
        and app_api.film_order_matches_requirement(
          $1::uuid,
          null::uuid,
          $4::text,
          $5::text,
          $6::numeric,
          null::uuid,
          r.manufacturer,
          r.film_name,
          r.width_in
        )
    `,
    [orgId, order.job_id, order.job_number, order.manufacturer, order.film_name, order.width_in]
  );

  const report = buildFilmOrderRequirementBackfillReport([
    {
      ...order,
      matching_requirements: matchesResult.rows[0]?.matching_requirements || []
    }
  ]);

  return {
    order,
    candidate: report.candidates[0] || null
  };
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

function normalizedCandidateSignature(candidate) {
  return {
    filmOrderId: candidate.filmOrderId,
    status: candidate.status,
    jobId: candidate.jobId || null,
    jobNumber: candidate.jobNumber,
    film: candidate.film,
    requestedFeet: candidate.requestedFeet,
    orderedFeet: candidate.orderedFeet,
    coveredFeet: candidate.coveredFeet,
    remainingToOrderFeet: candidate.remainingToOrderFeet,
    matchStatus: candidate.matchStatus,
    wouldSetRequirementId: candidate.wouldSetRequirementId
  };
}

function candidateMatchesReviewed(liveCandidate, reviewedCandidate) {
  return (
    JSON.stringify(normalizedCandidateSignature(liveCandidate)) ===
    JSON.stringify(normalizedCandidateSignature(reviewedCandidate))
  );
}

async function applyReviewedBackfill(client, config, reviewedReport) {
  requireReviewedReport(config, reviewedReport);
  const candidates = reviewedReport.requirementBackfill?.candidates || [];
  const matchedCandidates = candidates.filter((candidate) => candidate.matchStatus === "MATCHED");
  const summary = {
    reviewedCandidates: candidates.length,
    eligibleCandidates: matchedCandidates.length,
    updated: 0,
    skipped: 0,
    skippedRows: []
  };

  await withWriteTransaction(client, async () => {
    const schemaChecks = await fetchSchemaPreflight(client);
    requireSchemaChecks(schemaChecks, ["filmOrdersRequirementId", "filmOrderMatchesRequirement"]);

    for (const reviewedCandidate of matchedCandidates) {
      const { order, candidate: liveCandidate } = await fetchCandidateFilmOrderForUpdate(
        client,
        config.orgId,
        reviewedCandidate.filmOrderId
      );

      if (!order || !liveCandidate) {
        summary.skipped += 1;
        summary.skippedRows.push({ filmOrderId: reviewedCandidate.filmOrderId, reason: "NOT_FOUND" });
        continue;
      }

      if (order.requirement_id !== null) {
        summary.skipped += 1;
        summary.skippedRows.push({
          filmOrderId: reviewedCandidate.filmOrderId,
          reason: "ALREADY_LINKED",
          currentRequirementId: order.requirement_id
        });
        continue;
      }

      if (!candidateMatchesReviewed(liveCandidate, reviewedCandidate)) {
        summary.skipped += 1;
        summary.skippedRows.push({
          filmOrderId: reviewedCandidate.filmOrderId,
          reason: "LIVE_ROW_CHANGED",
          reviewed: normalizedCandidateSignature(reviewedCandidate),
          live: normalizedCandidateSignature(liveCandidate)
        });
        continue;
      }

      const updateResult = await client.query(
        `
          update app.film_orders
          set requirement_id = $3::uuid
          where org_id = $1::uuid
            and film_order_id = $2::text
            and requirement_id is null
        `,
        [config.orgId, reviewedCandidate.filmOrderId, reviewedCandidate.wouldSetRequirementId]
      );

      if (updateResult.rowCount === 1) {
        summary.updated += 1;
      } else {
        summary.skipped += 1;
        summary.skippedRows.push({ filmOrderId: reviewedCandidate.filmOrderId, reason: "UPDATE_DID_NOT_MATCH" });
      }
    }
  });

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
      const summary = await applyReviewedBackfill(client, config, reviewedReport);
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
      requireSchemaChecks(schemaChecks, ["filmOrdersRequirementId", "filmOrderMatchesRequirement"]);

      const rows = await fetchCandidateFilmOrders(client, config.orgId);
      const backfill = buildFilmOrderRequirementBackfillReport(rows);
      return {
        metadata: metadataForConfig(config, { schemaChecks }),
        requirementBackfill: backfill
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
          summary: report.requirementBackfill.summary
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
