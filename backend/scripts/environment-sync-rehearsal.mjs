#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

import { buildTargetEnvReport, loadEnvFile } from './lib/target-env-guards.mjs';
import { CANONICAL_APPLICATION_SOURCE_COMMIT } from './lib/environment-sync/constants.mjs';
import {
  preflightDisposablePostgres,
  resolvePostgresTools
} from './lib/environment-sync/disposable-postgres.mjs';
import { fetchEdgeHealth, fetchManagementSummary } from './lib/environment-sync/inventory.mjs';
import {
  assertProdSourcePlatform,
  runGoldenBaselineRehearsal
} from './lib/environment-sync/rehearsal.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    result[key] = !next || next.startsWith('--') ? true : next;
    if (result[key] !== true) index += 1;
  }
  return result;
}

function assertCanonicalApplicationSource() {
  const resolved = execFileSync('git', ['rev-parse', CANONICAL_APPLICATION_SOURCE_COMMIT], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
  if (resolved !== CANONICAL_APPLICATION_SOURCE_COMMIT) {
    throw new Error('CANONICAL_APPLICATION_SOURCE_UNAVAILABLE');
  }
  const productionPaths = [
    'backend/src',
    'backend/server.mjs',
    'backend/supabase-backend.mjs',
    'backend/package-lock.json',
    'frontend/src',
    'frontend/public',
    'frontend/index.html',
    'frontend/package.json',
    'frontend/package-lock.json',
    'frontend/vite.config.ts',
    'shared',
    'supabase/config.toml',
    'supabase/functions',
    'supabase/migrations',
    'supabase/functions/api/deno.lock'
  ];
  try {
    execFileSync('git', ['diff', '--quiet', CANONICAL_APPLICATION_SOURCE_COMMIT, '--', ...productionPaths], {
      stdio: 'ignore'
    });
  } catch {
    throw new Error('CANONICAL_APPLICATION_SOURCE_DRIFT');
  }
}

function databaseUrl(values) {
  const candidates = ['PROD_DATABASE_URL', 'DATABASE_URL', 'SUPABASE_DB_URL']
    .map((name) => String(values[name] || '').trim())
    .filter(Boolean);
  if (candidates.length === 0 || new Set(candidates).size !== 1) {
    throw new Error('A single reviewed PROD database connection is required.');
  }
  return candidates[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Usage: node scripts/environment-sync-rehearsal.mjs --env <guarded-prod-env> --allow-prod-readonly');
    return;
  }
  if (args['preflight-only'] === true) {
    const postgresTools = resolvePostgresTools();
    const preflight = await preflightDisposablePostgres({ postgresBin: postgresTools.bin });
    console.log(JSON.stringify(preflight, null, 2));
    return;
  }
  if (args['allow-prod-readonly'] !== true) throw new Error('Explicit PROD read-only rehearsal approval flag is required.');
  const envPath = String(args.env || '').trim();
  if (!envPath) throw new Error('An explicit guarded PROD environment file is required.');
  const loaded = loadEnvFile(envPath);
  const guard = buildTargetEnvReport({
    envPath: loaded.path,
    envValues: loaded.values,
    expect: 'prod',
    allowProd: true
  });
  if (!guard.ok) throw new Error('PROD target guard failed.');
  assertCanonicalApplicationSource();
  const postgresTools = resolvePostgresTools();
  const toolchainPreflight = await preflightDisposablePostgres({ postgresBin: postgresTools.bin });
  const managementToken = String(
    process.env.SUPABASE_ACCESS_TOKEN || loaded.values.SUPABASE_ACCESS_TOKEN || ''
  );
  const supabaseUrl = String(loaded.values.SUPABASE_URL || loaded.values.VITE_SUPABASE_URL || '');
  const [management, edgeHealth] = await Promise.all([
    fetchManagementSummary({ projectRef: guard.expected.ref, accessToken: managementToken }),
    fetchEdgeHealth({ supabaseUrl })
  ]);
  assertProdSourcePlatform(management, edgeHealth);
  const result = await runGoldenBaselineRehearsal({
    prodConnectionString: databaseUrl(loaded.values),
    prodProjectRef: guard.expected.ref,
    postgresBin: postgresTools.bin,
    source: {
      gitCommit: CANONICAL_APPLICATION_SOURCE_COMMIT,
      envValues: loaded.values,
      management,
      edgeHealth,
      edgeIdentity: {
        source: 'current-main',
        graphDigest: 'sha256:53d4e97a237c6426766b6503f1aee6cdfce3c37493a0e027cbdae54e34179097',
        lockDigest: 'sha256:931f84c405074d4404a0bfa74fc0dde6dc83b9ac7c640e0c61c9c5fdb5ff4b4a'
      }
    }
  });
  console.log(JSON.stringify({ toolchainPreflight, ...result }, null, 2));
}

main().catch((error) => {
  const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(String(error?.code || error?.message || ''))
    ? String(error.code || error.message)
    : 'X_REHEARSAL_FAILED';
  console.error(`[environment-sync-rehearsal] ${code}`);
  process.exitCode = 1;
});
