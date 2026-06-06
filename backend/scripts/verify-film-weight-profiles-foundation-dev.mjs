#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from 'pg';

function asTrimmedString(value) {
  return String(value ?? '').trim();
}

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const [rawKey, rawValue] = token.slice(2).split('=', 2);
    const key = asTrimmedString(rawKey);
    if (!key) {
      continue;
    }
    if (rawValue !== undefined) {
      options[key] = rawValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function normalizeEnvValue(rawValue) {
  const value = asTrimmedString(rawValue);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadEnvValues(envPath) {
  const resolved = path.resolve(envPath);
  const values = {};
  const contents = fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = normalized.slice(0, separator).trim();
    values[key] = normalizeEnvValue(normalized.slice(separator + 1));
  }
  return values;
}

function applyEnv(values) {
  for (const [key, value] of Object.entries(values || {})) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildSuffix() {
  return `${Date.now().toString().slice(-8)}${crypto.randomInt(0, 9999).toString().padStart(4, '0')}`;
}

async function configureRpcAuthContext(client, orgId) {
  const memberResult = await client.query(
    `
      select user_id::text as user_id
      from app.organization_members
      where org_id = $1::uuid
      order by created_at asc nulls first, user_id asc
      limit 1
    `,
    [orgId]
  );
  const userId = asTrimmedString(memberResult.rows[0]?.user_id);
  assert(userId, `No organization member found for org ${orgId}.`);

  const claims = JSON.stringify({
    sub: userId,
    email: 'film-weight-foundation-verifier@example.com',
    role: 'authenticated',
  });
  await client.query(
    `
      select
        set_config('request.jwt.claim.sub', $1::text, true),
        set_config('request.jwt.claim.role', 'authenticated', true),
        set_config('request.jwt.claim.email', 'film-weight-foundation-verifier@example.com', true),
        set_config('request.jwt.claims', $2::text, true)
    `,
    [userId, claims]
  );
}

async function resolveWarehouse(client, orgId) {
  const result = await client.query(
    `
      select code::text as code
      from app.warehouses
      where org_id = $1::uuid
      order by code
      limit 1
    `,
    [orgId]
  );
  return asTrimmedString(result.rows[0]?.code).toUpperCase() || 'IL1';
}

async function createFilmOrderFixture(client, orgId, fixture) {
  await client.query(
    `
      insert into app.film_orders (
        org_id,
        film_order_id,
        job_number,
        warehouse,
        manufacturer,
        film_name,
        width_in,
        requested_feet,
        covered_feet,
        ordered_feet,
        remaining_to_order_feet,
        status,
        notes,
        created_by
      )
      values (
        $1::uuid,
        $2::text,
        $3::text,
        $4::text,
        $5::text,
        $6::text,
        $7::numeric,
        $8::integer,
        0,
        $8::integer,
        $8::integer,
        'FILM_ORDER',
        $9::text,
        $10::text
      )
      on conflict (org_id, film_order_id) do nothing
    `,
    [
      orgId,
      fixture.filmOrderId,
      fixture.jobNumber,
      fixture.warehouse,
      fixture.manufacturer,
      fixture.filmName,
      fixture.widthIn,
      fixture.initialFeet,
      fixture.notes,
      fixture.actor,
    ]
  );
}

async function createOrderedBoxFixture(client, orgId, fixture) {
  await client.query(
    `
      insert into app.boxes (
        org_id,
        box_id,
        warehouse,
        dealer,
        manufacturer,
        film_name,
        width_in,
        initial_feet,
        feet_available,
        lot_run,
        status,
        order_date,
        film_key,
        core_type,
        core_weight_lbs,
        notes,
        has_label
      )
      values (
        $1::uuid,
        $2::text,
        $3::text,
        $4::text,
        $5::text,
        $6::text,
        $7::numeric,
        $8::integer,
        0,
        '',
        'ORDERED',
        current_date,
        app_api.normalize_requirement_film_key($1::uuid, $5::text, $6::text),
        '',
        null,
        $9::text,
        false
      )
      on conflict (org_id, box_id) do nothing
    `,
    [
      orgId,
      fixture.boxId,
      fixture.warehouse,
      fixture.dealer,
      fixture.manufacturer,
      fixture.filmName,
      fixture.widthIn,
      fixture.initialFeet,
      fixture.notes,
    ]
  );
}

async function createFilmOrderLinkFixture(client, orgId, fixture) {
  await client.query(
    `
      insert into app.film_order_box_links (
        org_id,
        link_id,
        film_order_id,
        box_id,
        ordered_feet,
        auto_allocated_feet,
        created_by
      )
      values (
        $1::uuid,
        $2::text,
        $3::text,
        $4::text,
        $5::integer,
        0,
        $6::text
      )
      on conflict (org_id, link_id) do nothing
    `,
    [orgId, fixture.linkId, fixture.filmOrderId, fixture.boxId, fixture.initialFeet, fixture.actor]
  );
}

async function createOrderedReceiveFixture(client, orgId, fixture) {
  await createFilmOrderFixture(client, orgId, fixture);
  await createOrderedBoxFixture(client, orgId, fixture);
  await createFilmOrderLinkFixture(client, orgId, fixture);
}

async function receiveOrderedViaRpc(client, orgId, actor, payload) {
  const result = await client.query(
    `
      select public.api_acl_boxes_receive_ordered($1::uuid, $2::text, $3::jsonb) as result
    `,
    [orgId, actor, JSON.stringify(payload)]
  );
  return result.rows[0]?.result || {};
}

async function recordSampleViaRpc(client, orgId, actor, boxId) {
  const result = await client.query(
    `
      select public.api_acl_record_film_weight_sample_from_box(
        $1::uuid,
        $2::text,
        jsonb_build_object('boxId', $3::text)
      ) as result
    `,
    [orgId, actor, boxId]
  );
  return result.rows[0]?.result || {};
}

async function getBoxState(client, orgId, boxId) {
  const result = await client.query(
    `
      select
        box_id,
        status::text as status,
        received_date,
        initial_feet,
        last_roll_weight_lbs,
        core_type,
        core_weight_lbs
      from app.boxes
      where org_id = $1::uuid
        and box_id = $2::text
    `,
    [orgId, boxId]
  );
  return result.rows[0] || null;
}

async function getSampleForBox(client, orgId, boxId) {
  const result = await client.query(
    `
      select
        id,
        profile_id,
        source_box_id,
        acceptance_status,
        review_reasons,
        normalized_lbs_per_inch_foot,
        estimated_lf_against_profile,
        lf_error_against_profile
      from app.film_weight_samples
      where org_id = $1::uuid
        and source_type = 'ordered_received_box'
        and source_box_id = $2::text
    `,
    [orgId, boxId]
  );
  return result.rows[0] || null;
}

async function getProfile(client, orgId, profileId) {
  const result = await client.query(
    `
      select
        id,
        film_key,
        core_type,
        average_normalized_lbs_per_inch_foot,
        average_lbs_per_sq_ft,
        accepted_sample_count,
        pending_review_count,
        confidence,
        status
      from app.film_weight_profiles
      where org_id = $1::uuid
        and id = $2::uuid
    `,
    [orgId, profileId]
  );
  return result.rows[0] || null;
}

async function getOpenPendingReviewForBox(client, orgId, boxId) {
  const result = await client.query(
    `
      select
        id,
        profile_id,
        source_box_id,
        reason,
        reasons,
        status,
        user_action_hint
      from app.film_weight_pending_reviews
      where org_id = $1::uuid
        and source_box_id = $2::text
        and status = 'open'
      order by created_at desc
      limit 1
    `,
    [orgId, boxId]
  );
  return result.rows[0] || null;
}

function buildFixture({ suffix, warehouse, actor, boxToken, filmName, widthIn, initialFeet }) {
  const boxId = `${warehouse}-FW${boxToken}-${suffix}`.toUpperCase();
  return {
    actor,
    boxId,
    dealer: 'Codex Film Weight Fixture Dealer',
    filmOrderId: `FWP-${boxToken}-${suffix}`,
    filmName,
    initialFeet,
    jobNumber: `FWP-${suffix}`,
    linkId: `FWPL-${boxToken}-${suffix}`,
    manufacturer: '3M Solar',
    notes: `CODEX_FILM_WEIGHT_FOUNDATION_${suffix}`,
    warehouse,
    widthIn,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const envPath = asTrimmedString(options.env || '.env.dev');
  const envValues = loadEnvValues(envPath);
  applyEnv(envValues);
  const connectionString = asTrimmedString(
    envValues.DEV_DATABASE_URL || envValues.DATABASE_URL || envValues.SUPABASE_DB_URL
  );
  assert(connectionString, 'DEV database URL is required.');
  const orgId = asTrimmedString(envValues.VERIFY_DB_PARITY_ORG_ID || envValues.DEFAULT_ORG_ID || process.env.DEFAULT_ORG_ID);
  assert(orgId, 'DEFAULT_ORG_ID or VERIFY_DB_PARITY_ORG_ID is required.');

  const { receiveOrderedBox } = await import('../src/app/internal.mjs');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  const suffix = buildSuffix();
  const actor = `codex-film-weight-${suffix}`;
  await client.connect();

  try {
    await client.query('begin');
    await configureRpcAuthContext(client, orgId);
    const warehouse = await resolveWarehouse(client, orgId);
    const fixtureBase = {
      suffix,
      warehouse,
      actor,
      filmName: `Codex Profile Film ${suffix}`,
    };
    const starter = buildFixture({ ...fixtureBase, boxToken: 'A', widthIn: 60, initialFeet: 100 });
    const accepted = buildFixture({ ...fixtureBase, boxToken: 'B', widthIn: 36, initialFeet: 80 });
    const outsideTolerance = buildFixture({ ...fixtureBase, boxToken: 'C', widthIn: 60, initialFeet: 100 });
    const missingCore = buildFixture({
      ...fixtureBase,
      boxToken: 'D',
      filmName: `Codex Missing Core Film ${suffix}`,
      widthIn: 60,
      initialFeet: 100,
    });
    const fixtures = [starter, accepted, outsideTolerance, missingCore];
    for (const fixture of fixtures) {
      await createOrderedReceiveFixture(client, orgId, fixture);
    }

    const beforeSamples = [];
    for (const fixture of fixtures) {
      beforeSamples.push(await getSampleForBox(client, orgId, fixture.boxId));
    }
    assert(beforeSamples.every((sample) => sample === null), 'Expected no pre-existing fixture samples.');

    const starterReceive = await receiveOrderedBox(
      client,
      orgId,
      {
        boxId: starter.boxId,
        receivedWeightLbs: '13.67',
        coreType: 'White plastic',
      },
      actor
    );
    assert(starterReceive?.data?.box?.status === 'IN_STOCK', 'Local receive did not leave starter box in stock.');
    const starterSample = await getSampleForBox(client, orgId, starter.boxId);
    assert(starterSample?.acceptance_status === 'accepted', 'Starter sample was not accepted.');
    const starterProfile = await getProfile(client, orgId, starterSample.profile_id);
    assert(starterProfile?.accepted_sample_count === 1, 'Starter profile sample count should be 1.');
    assert(starterProfile?.confidence === 'starter', 'Starter profile confidence should be starter.');

    const acceptedReceive = await receiveOrderedViaRpc(client, orgId, actor, {
      boxId: accepted.boxId,
      receivedWeightLbs: '6.76',
      coreType: 'White plastic',
    });
    assert(asTrimmedString(acceptedReceive.boxId) === accepted.boxId, 'RPC receive did not return accepted box.');
    const acceptedSample = await getSampleForBox(client, orgId, accepted.boxId);
    assert(acceptedSample?.acceptance_status === 'accepted', 'Second sample was not accepted.');
    const profileAfterAccepted = await getProfile(client, orgId, starterSample.profile_id);
    assert(profileAfterAccepted?.accepted_sample_count === 2, 'Profile sample count should update to 2.');
    assert(profileAfterAccepted?.confidence === 'building', 'Profile confidence should become building.');

    const outsideReceive = await receiveOrderedViaRpc(client, orgId, actor, {
      boxId: outsideTolerance.boxId,
      receivedWeightLbs: '7.67',
      coreType: 'White plastic',
    });
    assert(asTrimmedString(outsideReceive.boxId) === outsideTolerance.boxId, 'RPC receive did not return outside box.');
    const outsideSample = await getSampleForBox(client, orgId, outsideTolerance.boxId);
    assert(outsideSample?.acceptance_status === 'pending_review', 'Outside tolerance sample should be pending.');
    assert(
      Array.isArray(outsideSample.review_reasons) && outsideSample.review_reasons.includes('outside_10_lf_tolerance'),
      'Outside tolerance reason was not recorded.'
    );
    const outsideReview = await getOpenPendingReviewForBox(client, orgId, outsideTolerance.boxId);
    assert(outsideReview?.status === 'open', 'Outside tolerance pending review was not open.');
    const profileAfterPending = await getProfile(client, orgId, starterSample.profile_id);
    assert(profileAfterPending?.accepted_sample_count === 2, 'Pending sample should not update accepted count.');
    assert(profileAfterPending?.pending_review_count === 1, 'Profile should track one pending review.');
    assert(profileAfterPending?.confidence === 'needs_review', 'Profile confidence should become needs_review.');

    const missingCoreReceive = await receiveOrderedViaRpc(client, orgId, actor, {
      boxId: missingCore.boxId,
      receivedWeightLbs: '13.67',
    });
    assert(asTrimmedString(missingCoreReceive.boxId) === missingCore.boxId, 'RPC receive did not return missing core box.');
    const missingCoreSample = await getSampleForBox(client, orgId, missingCore.boxId);
    assert(missingCoreSample?.acceptance_status === 'pending_review', 'Missing core sample should be pending.');
    assert(
      Array.isArray(missingCoreSample.review_reasons) &&
        missingCoreSample.review_reasons.includes('missing_core_type') &&
        missingCoreSample.review_reasons.includes('missing_core_weight'),
      'Missing core/core weight reasons were not recorded.'
    );

    const duplicateBefore = await client.query(
      `
        select count(*)::integer as sample_count
        from app.film_weight_samples
        where org_id = $1::uuid
          and source_type = 'ordered_received_box'
          and source_box_id = $2::text
      `,
      [orgId, accepted.boxId]
    );
    await recordSampleViaRpc(client, orgId, actor, accepted.boxId);
    const duplicateAfter = await client.query(
      `
        select count(*)::integer as sample_count
        from app.film_weight_samples
        where org_id = $1::uuid
          and source_type = 'ordered_received_box'
          and source_box_id = $2::text
      `,
      [orgId, accepted.boxId]
    );
    assert(
      Number(duplicateBefore.rows[0]?.sample_count || 0) === 1 &&
        Number(duplicateAfter.rows[0]?.sample_count || 0) === 1,
      'Reprocessing the same box should not create duplicate samples.'
    );

    const pendingCountResult = await client.query(
      `select public.api_acl_get_film_weight_pending_review_count($1::uuid)::integer as pending_count`,
      [orgId]
    );
    const finalBoxes = {};
    for (const fixture of fixtures) {
      finalBoxes[fixture.boxId] = await getBoxState(client, orgId, fixture.boxId);
    }

    await client.query('commit');

    console.log(JSON.stringify(
      {
        result: 'ok',
        fixtureTag: `CODEX_FILM_WEIGHT_FOUNDATION_${suffix}`,
        target: 'verified DEV',
        boxes: fixtures.map((fixture) => fixture.boxId),
        starter: {
          boxId: starter.boxId,
          status: finalBoxes[starter.boxId]?.status,
          sampleStatus: starterSample.acceptance_status,
          profileConfidence: starterProfile.confidence,
        },
        acceptedFollowUp: {
          boxId: accepted.boxId,
          status: finalBoxes[accepted.boxId]?.status,
          sampleStatus: acceptedSample.acceptance_status,
          acceptedSampleCount: profileAfterAccepted.accepted_sample_count,
        },
        outsideTolerance: {
          boxId: outsideTolerance.boxId,
          status: finalBoxes[outsideTolerance.boxId]?.status,
          sampleStatus: outsideSample.acceptance_status,
          reasons: outsideSample.review_reasons,
          profileAcceptedSampleCount: profileAfterPending.accepted_sample_count,
          profilePendingReviewCount: profileAfterPending.pending_review_count,
        },
        missingCore: {
          boxId: missingCore.boxId,
          status: finalBoxes[missingCore.boxId]?.status,
          sampleStatus: missingCoreSample.acceptance_status,
          reasons: missingCoreSample.review_reasons,
        },
        idempotency: {
          sourceBoxId: accepted.boxId,
          sampleCountBefore: Number(duplicateBefore.rows[0]?.sample_count || 0),
          sampleCountAfter: Number(duplicateAfter.rows[0]?.sample_count || 0),
        },
        pendingReviewCountAvailable: Number(pendingCountResult.rows[0]?.pending_count || 0) >= 2,
        cleanup: 'not performed; fixture-owned DEV evidence retained',
      },
      null,
      2
    ));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
