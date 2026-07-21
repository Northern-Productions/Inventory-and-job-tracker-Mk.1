#!/usr/bin/env node

import pg from 'pg';
import {
  loadDevFixtureConfig,
  parseArgs,
} from './dev-fixtures/lib/dev-fixture-guard.mjs';

const { Pool } = pg;
const EXPECTED_ENTRY_POINTS = [
  'public.api_allocations_apply(uuid, text, jsonb)',
  'public.api_acl_allocations_apply(uuid, text, jsonb)',
  'public.api_allocations_remove_box(uuid, text, jsonb)',
  'public.api_acl_allocations_remove_box(uuid, text, jsonb)',
  'public.api_acl_boxes_set_status(uuid, text, jsonb)',
  'public.api_acl_boxes_resolve_checkout_allocations(uuid, text, jsonb)',
  'public.api_acl_jobs_update(uuid, text, jsonb)',
  'public.api_acl_job_requirement_set_state(uuid, text, jsonb)',
  'public.api_acl_job_phase_set_state(uuid, text, jsonb)',
  'public.api_acl_film_orders_cancel(uuid, text, jsonb)',
  'public.api_acl_jobs_set_staged_pickup(uuid, text, jsonb)',
  'public.api_acl_jobs_set_staged_pickup_for_user(uuid, uuid, text, jsonb)',
  'public.api_box_transfer_start(uuid, text, jsonb)',
  'public.api_box_transfer_receive(uuid, text, jsonb)',
  'public.api_box_transfer_cancel(uuid, text, jsonb)',
  'public.api_acl_box_transfer_start(uuid, text, jsonb)',
  'public.api_acl_box_transfer_receive(uuid, text, jsonb)',
  'public.api_acl_box_transfer_cancel(uuid, text, jsonb)',
];

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Usage: node backend/scripts/verify-material-flow-lock-order-dev.mjs [--env .env.dev]');
    return;
  }

  const config = loadDevFixtureConfig(args);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 3,
    ssl: /localhost|127\.0\.0\.1/i.test(config.databaseUrl)
      ? undefined
      : { rejectUnauthorized: false },
  });
  const first = await pool.connect();
  const second = await pool.connect();
  let firstOpen = false;
  let secondOpen = false;

  try {
    const contract = await first.query(
      `
        with expected(signature) as (
          select unnest($1::text[])
        )
        select
          count(*)::integer as expected_count,
          count(*) filter (
            where to_regprocedure(signature) is not null
              and position(
                'lock_film_material_flow' in
                (select prosrc from pg_proc where oid = to_regprocedure(signature))
              ) > 0
          )::integer as guarded_count
        from expected
      `,
      [EXPECTED_ENTRY_POINTS]
    );
    const contractRow = contract.rows[0] || {};
    if (
      Number(contractRow.expected_count) !== EXPECTED_ENTRY_POINTS.length ||
      Number(contractRow.guarded_count) !== EXPECTED_ENTRY_POINTS.length
    ) {
      throw new Error('The live DEV material-flow entry-point lock contract is incomplete.');
    }

    await first.query('begin');
    firstOpen = true;
    await first.query(`set local lock_timeout = '5s'`);
    await first.query(`set local statement_timeout = '10s'`);
    await first.query('select app_api.lock_film_material_flow()');

    await second.query('begin');
    secondOpen = true;
    await second.query(`set local lock_timeout = '5s'`);
    await second.query(`set local statement_timeout = '10s'`);
    const startedAt = Date.now();
    let secondAcquired = false;
    const secondLock = second.query('select app_api.lock_film_material_flow()').then(() => {
      secondAcquired = true;
    });

    await sleep(250);
    if (secondAcquired) {
      throw new Error('The second material-flow transaction bypassed the shared advisory lock.');
    }

    await first.query('commit');
    firstOpen = false;
    await secondLock;
    const waitedMs = Date.now() - startedAt;
    await second.query('rollback');
    secondOpen = false;

    if (waitedMs < 200) {
      throw new Error('The material-flow concurrency probe did not observe serialization.');
    }

    console.log(JSON.stringify({
      ok: true,
      target: 'dev',
      projectRef: config.projectRef,
      verifiedEntryPointCount: EXPECTED_ENTRY_POINTS.length,
      serialized: true,
      deadlockDetected: false,
    }, null, 2));
  } finally {
    if (firstOpen) {
      await first.query('rollback').catch(() => {});
    }
    if (secondOpen) {
      await second.query('rollback').catch(() => {});
    }
    first.release();
    second.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
