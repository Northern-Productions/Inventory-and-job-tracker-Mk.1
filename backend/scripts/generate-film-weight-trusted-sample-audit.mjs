#!/usr/bin/env node

// Purpose: Read-only Phase 3A audit for trusted ordered/received film weight samples.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import {
  DEFAULT_CUTOFF_DATE,
  DEFAULT_LF_TOLERANCE,
  buildJsonReport,
  buildTrustedSampleAudit,
  formatTrustedSampleAuditMarkdown,
} from './lib/film-weight-trusted-sample-audit.mjs';
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
  node scripts/generate-film-weight-trusted-sample-audit.mjs --env .env.prod --expect prod --allow-prod
  node scripts/generate-film-weight-trusted-sample-audit.mjs --env .env.dev --expect dev --json

Options:
  --env <path>             Required env file path, relative to backend/ or absolute.
  --expect <dev|prod|ref>  Required expected Supabase target.
  --allow-prod             Required when --expect prod.
  --cutoff <YYYY-MM-DD>    Trusted sample cutoff. Default ${DEFAULT_CUTOFF_DATE}.
  --tolerance-lf <number>  LF tolerance for profile simulation. Default ${DEFAULT_LF_TOLERANCE}.
  --limit <number>         Output row limit. Default 100.
  --json                   Write structured JSON instead of Markdown.
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

async function queryRows(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows;
}

async function fetchTrustedSampleInputs(client) {
  const sampleRows = await queryRows(
    client,
    `
      select
        b.org_id,
        b.box_id,
        b.status::text as status,
        b.warehouse::text as warehouse,
        b.manufacturer,
        b.film_name,
        b.film_key,
        b.width_in,
        b.initial_feet,
        b.feet_available,
        b.received_date,
        b.order_date,
        b.initial_weight_lbs,
        b.last_roll_weight_lbs,
        b.last_weighed_date,
        b.core_type,
        b.core_weight_lbs,
        b.lf_weight_lbs_per_ft,
        b.created_at,
        b.updated_at,
        count(l.*)::int as link_count,
        string_agg(distinct l.link_id, ', ' order by l.link_id) as link_ids,
        string_agg(distinct l.film_order_id, ', ' order by l.film_order_id) as film_order_ids,
        coalesce(sum(l.ordered_feet), 0)::int as linked_ordered_feet,
        string_agg(distinct fo.status::text, ', ' order by fo.status::text) as film_order_statuses,
        string_agg(distinct fo.job_number, ', ' order by fo.job_number) filter (where nullif(trim(fo.job_number), '') is not null) as job_numbers,
        max(l.created_at) as latest_link_created_at
      from app.film_order_box_links l
      join app.boxes b
        on b.org_id = l.org_id
       and b.box_id = l.box_id
      left join app.film_orders fo
        on fo.org_id = l.org_id
       and fo.film_order_id = l.film_order_id
      group by
        b.org_id,
        b.box_id,
        b.status,
        b.warehouse,
        b.manufacturer,
        b.film_name,
        b.film_key,
        b.width_in,
        b.initial_feet,
        b.feet_available,
        b.received_date,
        b.order_date,
        b.initial_weight_lbs,
        b.last_roll_weight_lbs,
        b.last_weighed_date,
        b.core_type,
        b.core_weight_lbs,
        b.lf_weight_lbs_per_ft,
        b.created_at,
        b.updated_at
      order by b.box_id
    `
  );

  const aliasRows = await queryRows(
    client,
    `
      select
        org_id,
        manufacturer_lookup_key,
        old_film_name_lookup_key,
        canonical_film_name
      from app.film_name_aliases
      order by manufacturer_lookup_key, old_film_name_lookup_key
    `
  );

  return { sampleRows, aliasRows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    return;
  }

  const limit = Math.max(1, Number.parseInt(args.limit || '100', 10) || 100);
  const cutoffDate = asText(args.cutoff) || DEFAULT_CUTOFF_DATE;
  const toleranceLf = Number.isFinite(Number(args['tolerance-lf']))
    ? Number(args['tolerance-lf'])
    : DEFAULT_LF_TOLERANCE;
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
    const { sampleRows, aliasRows } = await fetchTrustedSampleInputs(client);
    const report = buildTrustedSampleAudit({
      rows: sampleRows,
      aliasRows,
      cutoffDate,
      toleranceLf,
    });
    await client.query('rollback');

    const payload =
      args.json === true
        ? JSON.stringify(
            {
              target: {
                expected: targetReport.expected,
                refs: targetReport.refs,
              },
              ...buildJsonReport(report, { limit }),
            },
            null,
            2
          )
        : `${formatTargetEnvReport(targetReport)}\n\n${formatTrustedSampleAuditMarkdown(report, { limit })}`;

    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, payload, 'utf8');
      console.log(formatTargetEnvReport(targetReport));
      console.log('');
      console.log(`[film-weight-trusted-sample-audit] Wrote ignored report: ${outputPath}`);
      console.log(`[film-weight-trusted-sample-audit] trusted usable samples: ${report.summary.trustedUsableSamples}`);
      console.log(`[film-weight-trusted-sample-audit] pending review items: ${report.summary.pendingReviewItems}`);
      console.log(`[film-weight-trusted-sample-audit] simulated profiles: ${report.summary.simulatedProfiles}`);
      return;
    }

    console.log(payload);
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
  console.error(`[film-weight-trusted-sample-audit] ${error.message}`);
  process.exitCode = 1;
});
