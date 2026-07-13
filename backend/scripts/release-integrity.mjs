#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import {
  readCompatibleJson,
  writeJsonAtomic
} from './lib/release-integrity-artifacts.mjs';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  buildSnapshot,
  captureDatabaseState,
  compareSnapshots,
  validateSnapshot
} from './lib/release-integrity.mjs';
import {
  buildTargetEnvReport,
  extractDbProjectRef,
  formatTargetEnvReport,
  loadEnvFile,
  resolveExpectedRef
} from './lib/target-env-guards.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');
const ARTIFACT_ROOT = path.resolve(REPO_ROOT, '.codex-runlogs', 'release-integrity');

function asText(value) {
  return String(value ?? '').trim();
}

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = asText(rawKey);
    if (!key) {
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        value = true;
      } else {
        value = next;
        index += 1;
      }
    }
    if (options[key] === undefined) {
      options[key] = value;
    } else if (Array.isArray(options[key])) {
      options[key].push(value);
    } else {
      options[key] = [options[key], value];
    }
  }
  return options;
}

function optionValues(value) {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((item) =>
    String(item ?? '').split(',')
  );
}

function optionText(value, fallback = '') {
  if (Array.isArray(value)) {
    return asText(value.at(-1)) || fallback;
  }
  return asText(value) || fallback;
}

function optionBoolean(value) {
  if (value === true) {
    return true;
  }
  return optionText(value).toLowerCase() === 'true';
}

function printUsage() {
  console.log(`Usage:
  npm --prefix backend run release:integrity -- --mode snapshot --target dev --env .env.dev --phase pre
  npm --prefix backend run release:integrity -- --mode compare --before .codex-runlogs/release-integrity/dev-pre.json --after .codex-runlogs/release-integrity/dev-post.json --policy strict

Snapshot options:
  --target <dev|prod>               Required exact target.
  --env <path>                      Required env file, relative to backend/ or absolute.
  --phase <pre|post>                Required release phase.
  --allow-prod                      Required for PROD snapshots.
  --database-url-var <NAME>         Optional exact env variable containing the DB URL.
  --out <path>                      Optional path under .codex-runlogs/release-integrity/.
  --statement-timeout-ms <number>   Per-statement timeout. Default 120000; max 900000.

Compare options:
  --before <path>                   Required pre snapshot under .codex-runlogs/release-integrity/.
  --after <path>                    Required post snapshot under .codex-runlogs/release-integrity/.
  --policy <strict|observe>         Default and recommended: strict.
  --allow-table-change <table>      Exact schema.table approval; repeat or comma-separate.
  --allow-schema-change <table>     Exact schema.table approval; repeat or comma-separate.
  --allow-migration <version>       Exact migration approval; repeat or comma-separate.

Strict fails on every unapproved protected-data, schema, or migration change.
Observe exits 2 with REVIEW_REQUIRED when any change is found. Target mismatch always fails.
Snapshot profile v2 requires existing database SHA-256 support and rejects v1 artifacts.
The command is read-only and never prints env values, database URLs, row contents, or row hashes.`);
}

function resolveEnvPath(rawPath) {
  const value = asText(rawPath);
  if (!value) {
    throw new Error('--env is required for snapshot mode.');
  }
  return path.isAbsolute(value) ? value : path.resolve(BACKEND_DIR, value);
}

function assertArtifactPath(rawPath, { defaultName = '', mustExist = false } = {}) {
  const value = asText(rawPath) || defaultName;
  if (!value) {
    throw new Error('A release-integrity artifact path is required.');
  }
  const resolved = path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
  const relative = path.relative(ARTIFACT_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new Error('Release-integrity artifacts must be files under .codex-runlogs/release-integrity/.');
  }
  if (mustExist && !fs.existsSync(resolved)) {
    throw new Error(`Snapshot file not found: ${resolved}`);
  }
  return resolved;
}

function selectDatabaseUrl(envValues, target, requestedVariable = '') {
  const explicit = asText(requestedVariable);
  if (explicit && !/^[A-Z][A-Z0-9_]*$/.test(explicit)) {
    throw new Error('--database-url-var must be an uppercase env variable name.');
  }
  const candidates = explicit
    ? [explicit]
    : target === 'prod'
      ? ['PROD_DATABASE_URL', 'DATABASE_URL', 'SUPABASE_DB_URL']
      : ['DEV_DATABASE_URL', 'DATABASE_URL', 'SUPABASE_DB_URL'];
  for (const variable of candidates) {
    const value = asText(envValues[variable]);
    if (value) {
      return { variable, value };
    }
  }
  throw new Error(`No database URL was found in the allowed ${target.toUpperCase()} env variables.`);
}

function resolveSnapshotTarget(options) {
  const target = optionText(options.target).toLowerCase();
  if (!['dev', 'prod'].includes(target)) {
    throw new Error('--target must be dev or prod.');
  }
  const allowProd = optionBoolean(options['allow-prod']);
  const envPath = resolveEnvPath(optionText(options.env));
  const loaded = loadEnvFile(envPath);
  const report = buildTargetEnvReport({
    envPath: loaded.path,
    envValues: loaded.values,
    expect: target,
    allowProd
  });
  if (!report.ok) {
    throw new Error(formatTargetEnvReport(report));
  }
  const expected = resolveExpectedRef(target);
  const database = selectDatabaseUrl(
    loaded.values,
    target,
    optionText(options['database-url-var'])
  );
  const databaseProjectRef = extractDbProjectRef(database.value);
  if (!databaseProjectRef) {
    throw new Error(
      `Could not prove the database target from ${database.variable}; snapshot aborted without connecting.`
    );
  }
  if (databaseProjectRef !== expected.ref) {
    throw new Error(
      `Database target mismatch for ${database.variable}: expected ${expected.ref}, found ${databaseProjectRef}.`
    );
  }
  return {
    target,
    projectRef: expected.ref,
    databaseUrl: database.value,
    databaseUrlVariable: database.variable,
    envPath: loaded.path
  };
}

function parsePositiveInteger(value, { fallback, min, max, label }) {
  const text = optionText(value);
  if (!text) {
    return fallback;
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function runGit(args, fallback = 'unknown') {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function isWorkingTreeClean() {
  try {
    return (
      execFileSync('git', ['status', '--porcelain'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() === ''
    );
  } catch {
    return false;
  }
}

function gitSource() {
  return {
    gitCommit: runGit(['rev-parse', 'HEAD']),
    gitBranch: runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    workingTreeClean: isWorkingTreeClean()
  };
}

function defaultSnapshotName(target, phase) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('.codex-runlogs', 'release-integrity', `${target}-${phase}-${timestamp}.json`);
}

function readSnapshot(filePath, label) {
  return validateSnapshot(
    readCompatibleJson(filePath, {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      label
    }),
    label
  );
}

function safeErrorMessage(error) {
  return asText(error?.message || error)
    .replaceAll(/postgres(?:ql)?:\/\/[^\s]+/gi, '<redacted-database-url>')
    .replaceAll(/(?:password|token|secret)=([^\s&]+)/gi, '<redacted-secret>');
}

async function runSnapshot(options) {
  const phase = optionText(options.phase).toLowerCase();
  if (!['pre', 'post'].includes(phase)) {
    throw new Error('--phase must be pre or post.');
  }
  const config = resolveSnapshotTarget(options);
  const statementTimeoutMs = parsePositiveInteger(options['statement-timeout-ms'], {
    fallback: 120000,
    min: 1000,
    max: 900000,
    label: '--statement-timeout-ms'
  });
  const outputPath = assertArtifactPath(optionText(options.out), {
    defaultName: defaultSnapshotName(config.target, phase)
  });
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing snapshot: ${outputPath}`);
  }
  const client = new Client({
    application_name: 'release-integrity-read-only',
    connectionString: config.databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(config.databaseUrl)
      ? undefined
      : { rejectUnauthorized: false }
  });

  console.log('[release-integrity:snapshot]');
  console.log(`target: ${config.target} (${config.projectRef})`);
  console.log(`env: ${config.envPath}`);
  console.log(`databaseUrlVariable: ${config.databaseUrlVariable}`);
  console.log(`phase: ${phase}`);
  console.log('transaction: repeatable-read, read-only (verification pending)');

  let databaseState;
  await client.connect();
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    try {
      await client.query(`set local statement_timeout = '${statementTimeoutMs}ms'`);
      await client.query(`set local lock_timeout = '3s'`);
      await client.query(`set local timezone = 'UTC'`);
      databaseState = await captureDatabaseState(client);
    } finally {
      await client.query('rollback');
    }
  } finally {
    await client.end();
  }

  const snapshot = buildSnapshot({
    phase,
    target: { environment: config.target, projectRef: config.projectRef },
    source: gitSource(),
    databaseState
  });
  writeJsonAtomic(outputPath, snapshot, { allowedRoot: ARTIFACT_ROOT });
  console.log('transactionReadOnly: verified');
  console.log('databaseAggregateRowsPerTable: 1');
  console.log(`protectedTables: ${snapshot.protectedData.tableCount}`);
  console.log(`migrationVersions: ${snapshot.migrationState.versions.length}`);
  console.log(`output: ${outputPath}`);
  console.log('result: SNAPSHOT_CREATED');
}

function formatCount(value) {
  return value === null ? '<absent>' : String(value);
}

function printNamedChanges(label, changes, countLabel, unapprovedNames) {
  console.log(`${label}:`);
  if (changes.length === 0) {
    console.log('  - none');
    return;
  }
  const unapproved = new Set(unapprovedNames);
  for (const change of changes) {
    console.log(
      `  - ${change.name}: ${change.changeType}; ${countLabel} ${formatCount(change.beforeCount)} -> ${formatCount(change.afterCount)}; fingerprintChanged=${change.fingerprintChanged ? 'yes' : 'no'}; approval=${unapproved.has(change.name) ? 'missing' : 'present'}`
    );
  }
}

function printMigrationChanges(changes, unapprovedVersions) {
  console.log('migrationChanges:');
  if (changes.added.length === 0 && changes.removed.length === 0) {
    console.log('  - none');
    return;
  }
  const unapproved = new Set(unapprovedVersions);
  for (const version of changes.added) {
    console.log(`  - ${version}: added; approval=${unapproved.has(version) ? 'missing' : 'present'}`);
  }
  for (const version of changes.removed) {
    console.log(`  - ${version}: removed; approval=${unapproved.has(version) ? 'missing' : 'present'}`);
  }
}

function runCompare(options) {
  const beforePath = assertArtifactPath(optionText(options.before), { mustExist: true });
  const afterPath = assertArtifactPath(optionText(options.after), { mustExist: true });
  const before = readSnapshot(beforePath, 'before snapshot');
  const after = readSnapshot(afterPath, 'after snapshot');
  const result = compareSnapshots(before, after, {
    policy: optionText(options.policy, 'strict'),
    allowedTables: optionValues(options['allow-table-change']),
    allowedSchemaTables: optionValues(options['allow-schema-change']),
    allowedMigrations: optionValues(options['allow-migration'])
  });

  console.log('[release-integrity:compare]');
  console.log(`policy: ${result.policy}`);
  console.log(`target: ${result.target.environment} (${result.target.projectRef})`);
  console.log(`before: ${beforePath}`);
  console.log(`after: ${afterPath}`);
  if (result.hardFailures.length > 0) {
    console.log('hardFailures:');
    for (const failure of result.hardFailures) {
      console.log(`  - ${failure}`);
    }
  }
  printNamedChanges('protectedDataChanges', result.changes.data, 'rows', result.unapproved.data);
  printNamedChanges('schemaChanges', result.changes.schema, 'columns', result.unapproved.schema);
  printMigrationChanges(result.changes.migrations, result.unapproved.migrations);
  if (result.status === 'review-required') {
    console.log(
      'note: Changes may be legitimate user activity or release behavior. Observe mode does not claim corruption; human review is required.'
    );
  }
  console.log(`result: ${result.status.replaceAll('-', '_').toUpperCase()}`);
  process.exitCode = result.exitCode;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.h) {
    printUsage();
    return;
  }
  const mode = optionText(options.mode).toLowerCase();
  if (mode === 'snapshot') {
    await runSnapshot(options);
    return;
  }
  if (mode === 'compare') {
    runCompare(options);
    return;
  }
  throw new Error('--mode must be snapshot or compare.');
}

main().catch((error) => {
  console.error(`[release-integrity] ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});
