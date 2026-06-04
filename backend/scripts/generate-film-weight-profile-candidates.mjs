#!/usr/bin/env node

// Purpose: Read-only dry-run report for Film Weight Profile candidates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import {
  analyzeFilmWeightProfileCandidates,
  buildJsonReport,
  formatTextReport,
} from './lib/film-weight-profile-candidates.mjs';
import {
  buildTargetEnvReport,
  formatTargetEnvReport,
  loadEnvFile,
} from './lib/target-env-guards.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');

function asText(value) {
  return String(value ?? '').trim();
}

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const [rawKey, rawValue] = token.slice(2).split('=', 2);
    const key = asText(rawKey);
    if (!key) {
      continue;
    }
    if (rawValue !== undefined) {
      args[key] = rawValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/generate-film-weight-profile-candidates.mjs --env .env.prod --expect prod --allow-prod
  node scripts/generate-film-weight-profile-candidates.mjs --env .env.dev --expect dev --json

Options:
  --env <path>             Required env file path, relative to backend/ or absolute.
  --expect <dev|prod|ref>  Required expected Supabase target.
  --allow-prod             Required when --expect prod.
  --manufacturer <text>    Optional manufacturer filter.
  --film <text>            Optional film-name filter.
  --limit <number>         Output row limit. Default 25.
  --json                   Print structured JSON instead of text.
  --include-samples        Include sanitized samples in JSON output.
  --out <path>             Optional output under .codex-runlogs/ only.

The script runs a read-only transaction and never prints secret values.`);
}

function resolveEnvPath(envPath) {
  const raw = asText(envPath);
  if (!raw) {
    throw new Error('--env is required.');
  }
  return path.isAbsolute(raw) ? raw : path.resolve(BACKEND_DIR, raw);
}

function resolveDatabaseUrl(envValues, expectedTarget) {
  if (expectedTarget === 'prod') {
    return asText(envValues.PROD_DATABASE_URL || envValues.DATABASE_URL || envValues.SUPABASE_DB_URL);
  }
  if (expectedTarget === 'dev') {
    return asText(envValues.DEV_DATABASE_URL || envValues.DATABASE_URL || envValues.SUPABASE_DB_URL);
  }
  return asText(envValues.DATABASE_URL || envValues.SUPABASE_DB_URL || envValues.DEV_DATABASE_URL || envValues.PROD_DATABASE_URL);
}

function resolveSafeOutputPath(rawOutPath) {
  const outputPath = asText(rawOutPath);
  if (!outputPath) {
    return '';
  }
  const resolved = path.isAbsolute(outputPath) ? outputPath : path.resolve(REPO_ROOT, outputPath);
  const allowedRoot = path.resolve(REPO_ROOT, '.codex-runlogs');
  const relative = path.relative(allowedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('--out must be under .codex-runlogs/ so generated reports stay ignored.');
  }
  return resolved;
}

function buildSqlFilters(args, alias = '') {
  const clauses = [];
  const params = [];
  const prefix = alias ? `${alias}.` : '';
  if (asText(args.manufacturer)) {
    params.push(`%${asText(args.manufacturer)}%`);
    clauses.push(`${prefix}manufacturer ilike $${params.length}`);
  }
  if (asText(args.film)) {
    params.push(`%${asText(args.film)}%`);
    clauses.push(`${prefix}film_name ilike $${params.length}`);
  }
  return {
    params,
    where: clauses.length ? ` and ${clauses.join(' and ')}` : '',
  };
}

async function queryRows(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows;
}

async function fetchCandidateInputs(client, args) {
  const boxFilters = buildSqlFilters(args, 'b');
  const catalogFilters = buildSqlFilters(args, 'c');
  const rollFilters = buildSqlFilters(args, 'r');

  const boxRows = await queryRows(
    client,
    `
          select
            b.box_id,
            b.manufacturer,
            b.film_name,
            b.film_key,
            b.width_in,
            b.initial_feet,
            b.initial_weight_lbs,
            b.last_roll_weight_lbs,
            b.received_date,
            b.updated_at,
            b.core_type,
            b.core_weight_lbs,
            b.lf_weight_lbs_per_ft,
            exists (
              select 1
              from app.film_order_box_links l
              where l.org_id = b.org_id
                and l.box_id = b.box_id
            ) as order_linked
          from app.boxes b
          where nullif(trim(b.manufacturer), '') is not null
            and nullif(trim(b.film_name), '') is not null
            ${boxFilters.where}
        `,
    boxFilters.params
  );
  const catalogRows = await queryRows(
    client,
    `
          select
            c.film_key,
            c.manufacturer,
            c.film_name,
            c.sq_ft_weight_lbs_per_sq_ft,
            c.default_core_type,
            c.source_width_in,
            c.source_initial_feet,
            c.source_initial_weight_lbs,
            c.source_box_id,
            c.updated_at
          from app.film_catalog c
          where nullif(trim(c.manufacturer), '') is not null
            and nullif(trim(c.film_name), '') is not null
            ${catalogFilters.where}
        `,
    catalogFilters.params
  );
  const rollHistoryRows = await queryRows(
    client,
    `
          select
            r.log_id,
            r.box_id,
            r.manufacturer,
            r.film_name,
            coalesce(b.film_key, '') as film_key,
            r.width_in,
            coalesce(b.core_type, '') as core_type,
            b.core_weight_lbs,
            r.checked_out_weight_lbs,
            r.checked_in_weight_lbs,
            r.weight_delta_lbs,
            r.feet_before,
            r.feet_after,
            r.checked_in_at,
            r.created_at
          from app.roll_weight_log r
          left join app.boxes b
            on b.org_id = r.org_id
           and b.box_id = r.box_id
          where nullif(trim(r.manufacturer), '') is not null
            and nullif(trim(r.film_name), '') is not null
            ${rollFilters.where}
        `,
    rollFilters.params
  );
  const boxStats = await queryRows(
    client,
    `
          select
            count(*)::int as boxes_inspected,
            count(*) filter (where initial_weight_lbs is not null)::int as boxes_with_initial_weight,
            count(*) filter (where last_roll_weight_lbs is not null)::int as boxes_with_last_roll_weight,
            count(*) filter (where width_in > 0 and initial_feet > 0 and initial_weight_lbs is not null and core_weight_lbs is not null and initial_weight_lbs > core_weight_lbs)::int as boxes_with_usable_initial_weight
          from app.boxes b
          where nullif(trim(b.manufacturer), '') is not null
            and nullif(trim(b.film_name), '') is not null
            ${boxFilters.where}
        `,
    boxFilters.params
  );
  const catalogStats = await queryRows(
    client,
    `
          select
            count(*)::int as catalog_rows_inspected,
            count(*) filter (where sq_ft_weight_lbs_per_sq_ft is not null and sq_ft_weight_lbs_per_sq_ft > 0)::int as catalog_rows_with_weight
          from app.film_catalog c
          where nullif(trim(c.manufacturer), '') is not null
            and nullif(trim(c.film_name), '') is not null
            ${catalogFilters.where}
        `,
    catalogFilters.params
  );
  const rollStats = await queryRows(
    client,
    `
          select
            count(*)::int as roll_history_rows_inspected,
            count(*) filter (
              where checked_out_weight_lbs is not null
                and checked_in_weight_lbs is not null
                and feet_before is not null
                and feet_after is not null
                and feet_before > feet_after
            )::int as roll_history_rows_with_usable_delta
          from app.roll_weight_log r
          where nullif(trim(r.manufacturer), '') is not null
            and nullif(trim(r.film_name), '') is not null
            ${rollFilters.where}
        `,
    rollFilters.params
  );
  const filmOrderStats = await queryRows(
    client,
    `
          select
            count(*)::int as film_orders_inspected,
            count(*) filter (where job_id is not null)::int as film_orders_with_job_id
          from app.film_orders f
          where nullif(trim(f.manufacturer), '') is not null
            and nullif(trim(f.film_name), '') is not null
        `
  );

  return {
    catalogRows,
    boxRows,
    rollHistoryRows,
    stats: {
      ...(boxStats[0] || {}),
      ...(catalogStats[0] || {}),
      ...(rollStats[0] || {}),
      ...(filmOrderStats[0] || {}),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    return;
  }

  const limit = Math.max(1, Number.parseInt(args.limit || '25', 10) || 25);
  const envPath = resolveEnvPath(args.env);
  const expect = asText(args.expect);
  if (!expect) {
    throw new Error('--expect is required.');
  }
  const allowProd = args['allow-prod'] === true || String(args['allow-prod'] || '').toLowerCase() === 'true';
  const loaded = loadEnvFile(envPath);
  const targetReport = buildTargetEnvReport({
    envPath: loaded.path,
    envValues: loaded.values,
    expect,
    allowProd,
  });
  if (!targetReport.ok) {
    console.error(formatTargetEnvReport(targetReport));
    process.exitCode = 1;
    return;
  }

  const databaseUrl = resolveDatabaseUrl(loaded.values, targetReport.expected.target);
  if (!databaseUrl) {
    throw new Error('DATABASE_URL, SUPABASE_DB_URL, or target-specific database URL is required.');
  }

  const outputPath = resolveSafeOutputPath(args.out);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query('begin transaction read only');
    await client.query("set local statement_timeout = '20000ms'");
    const inputs = await fetchCandidateInputs(client, args);
    const report = analyzeFilmWeightProfileCandidates({ ...inputs, limit });
    await client.query('rollback');

    const payload =
      args.json === true
        ? JSON.stringify(
            {
              target: {
                expected: targetReport.expected,
                refs: targetReport.refs,
              },
              ...buildJsonReport(report, {
                limit,
                includeSamples: args['include-samples'] === true,
              }),
            },
            null,
            2
          )
        : `${formatTargetEnvReport(targetReport)}\n\n${formatTextReport(report, { limit })}`;

    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, payload, 'utf8');
    }
    console.log(payload);
    if (outputPath) {
      console.log(`\n[film-weight-profile-candidates] Wrote ignored report: ${outputPath}`);
    }
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (_rollbackError) {
      // The transaction may already be closed after a query error.
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[film-weight-profile-candidates] ${error.message}`);
  process.exitCode = 1;
});
