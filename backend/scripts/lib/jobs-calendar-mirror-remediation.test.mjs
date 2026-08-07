import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0189_jobs_calendar_mirror_remediation.sql',
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260714160000_jobs_calendar_mirror_remediation.sql',
);
const historicalMigrations = [
  {
    path: path.join(repoRoot, 'backend', 'migrations', '0034_jobs_calendar_and_staged_pickup.sql'),
    sha256: 'd490f5743fdee868cbd270dd6c5b18d927d3b6e52463e96ceae0f2d4ecf641ba',
  },
  {
    path: path.join(repoRoot, 'backend', 'migrations', '0157_service_role_staged_pickup_acl.sql'),
    sha256: 'a4baf5ca959afbf15e715ac88fa7a9cdba6c87749ab5a5ffedae5ee4d9351926',
  },
  {
    path: path.join(repoRoot, 'supabase', 'migrations', '20260608120000_service_role_staged_pickup_acl.sql'),
    sha256: 'a4baf5ca959afbf15e715ac88fa7a9cdba6c87749ab5a5ffedae5ee4d9351926',
  },
];

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n?/g, '\n');
}

function normalizedDigest(sql) {
  return crypto.createHash('sha256').update(normalizeSql(sql).trim()).digest('hex');
}

function functionStatement(sql, qualifiedName) {
  const start = sql.indexOf(`create or replace function ${qualifiedName}`);
  assert.notEqual(start, -1, `${qualifiedName} must be present.`);
  const end = sql.indexOf('\n$$;', start);
  assert.notEqual(end, -1, `${qualifiedName} must have a complete dollar-quoted body.`);
  return sql.slice(start, end + '\n$$;'.length);
}

function stripDollarQuotedBodies(sql) {
  return sql.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$BODY$');
}

test('jobs calendar remediation is exactly mirrored and historical migrations remain immutable', async () => {
  const [backendMigration, supabaseMigration, schemaLatest, ...historicalSql] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs'), 'utf8'),
    ...historicalMigrations.map((entry) => readFile(entry.path, 'utf8')),
  ]);

  assert.equal(normalizeSql(supabaseMigration), normalizeSql(backendMigration));
  assert.match(
    schemaLatest,
    /const LATEST_MIGRATION = '0194_scoped_job_summary_reads\.sql';/,
  );
  historicalSql.forEach((migration, index) => {
    assert.equal(normalizedDigest(migration), historicalMigrations[index].sha256);
  });
  assert.equal(normalizeSql(historicalSql[1]), normalizeSql(historicalSql[2]));
});

test('remediation reasserts the exact staged-pickup column and calendar index with fail-closed shape checks', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  assert.match(
    migration,
    /alter table app\.jobs[\s\S]*add column if not exists is_staged_for_pickup boolean not null default false;/,
  );
  assert.match(migration, /v_data_type <> 'boolean'/);
  assert.match(migration, /or not v_not_null/);
  assert.match(migration, /v_default not in \('false', 'false::boolean'\)/);
  assert.match(
    migration,
    /create index if not exists idx_jobs_org_due_date_lifecycle[\s\S]*on app\.jobs \(org_id, due_date desc, lifecycle_status, job_number\);/,
  );
  assert.match(migration, /or v_is_unique[\s\S]*or not v_is_valid[\s\S]*or not v_is_ready/);
  assert.match(migration, /or v_is_partial[\s\S]*or v_has_expressions/);
  assert.match(
    migration,
    /CREATE INDEX idx_jobs_org_due_date_lifecycle ON app\.jobs USING btree \(org_id, due_date DESC, lifecycle_status, job_number\)/,
  );
});

test('remediation reasserts only the two canonical 0034 calendar RPC definitions', async () => {
  const [migrationRaw, historicalRaw] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(historicalMigrations[0].path, 'utf8'),
  ]);
  const migration = normalizeSql(migrationRaw);
  const historical = normalizeSql(historicalRaw);

  for (const name of ['public.api_jobs_calendar', 'public.api_acl_list_jobs_calendar']) {
    assert.equal(functionStatement(migration, name), functionStatement(historical, name));
  }
  assert.equal((migration.match(/create or replace function public\.api_jobs_calendar\(/g) || []).length, 1);
  assert.equal((migration.match(/create or replace function public\.api_acl_list_jobs_calendar\(/g) || []).length, 1);
  assert.doesNotMatch(migration, /create or replace function public\.api_jobs_set_staged_pickup\(/);
  assert.doesNotMatch(migration, /create or replace function public\.api_acl_jobs_set_staged_pickup\(/);
  assert.doesNotMatch(migration, /api_acl_jobs_set_staged_pickup_for_user/);
});

test('0157 remains the mirrored canonical staged-pickup mutation source', async () => {
  const [backend0157Raw, supabase0157Raw, migrationRaw] = await Promise.all([
    readFile(historicalMigrations[1].path, 'utf8'),
    readFile(historicalMigrations[2].path, 'utf8'),
    readFile(backendMigrationPath, 'utf8'),
  ]);
  const backend0157 = normalizeSql(backend0157Raw);
  const supabase0157 = normalizeSql(supabase0157Raw);
  const migration = normalizeSql(migrationRaw);

  assert.equal(supabase0157, backend0157);
  assert.match(backend0157, /create or replace function public\.api_jobs_set_staged_pickup\(/);
  assert.match(backend0157, /v_job_id_text text := app_api\.trim_text\(v_payload->>'jobId'\)/);
  assert.match(backend0157, /create or replace function public\.api_acl_jobs_set_staged_pickup_for_user\(/);
  assert.match(backend0157, /grant_execute_if_exists\('public\.api_acl_jobs_set_staged_pickup_for_user\(uuid, uuid, text, jsonb\)', 'service_role'\)/);
  assert.doesNotMatch(migration, /create or replace function public\.api_(?:acl_)?jobs_set_staged_pickup/);
});

test('remediation contains no job-data DML and leaves service-role grant drift untouched', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));
  const structuralSql = stripDollarQuotedBodies(migration);

  assert.doesNotMatch(
    structuralSql,
    /\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+app\.(?:jobs|job_phases|job_requirements|job_caulk_requirements|allocations|film_orders)\b/i,
  );
  assert.doesNotMatch(structuralSql, /\b(?:truncate|drop\s+table)\b/i);
  assert.match(
    migration,
    /revoke execute on function public\.api_jobs_calendar\(uuid, text, text\) from public, anon, authenticated;/,
  );
  assert.match(
    migration,
    /revoke execute on function public\.api_acl_list_jobs_calendar\(uuid, text, text\) from public, anon;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.api_acl_list_jobs_calendar\(uuid, text, text\) to authenticated;/,
  );
  assert.doesNotMatch(migration, /(?:grant|revoke)[^;]*service_role/i);
});

test('SQL, backend, Edge, shared contract, and frontend retain the calendar and staged-pickup contracts', async () => {
  const [schemaLatest, localRoutes, edgeRepository, edgeRoutes, edgeMutations, runtimeContract, frontendClient] =
    await Promise.all([
      readFile(path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs'), 'utf8'),
      readFile(path.join(repoRoot, 'backend', 'src', 'app', 'handlers', 'readHandlers.mjs'), 'utf8'),
      readFile(path.join(repoRoot, 'supabase', 'functions', '_shared', 'repositories', 'inventoryRepositories.ts'), 'utf8'),
      readFile(path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'readHandlers.ts'), 'utf8'),
      readFile(path.join(repoRoot, 'supabase', 'functions', '_shared', 'api-handler.ts'), 'utf8'),
      readFile(path.join(repoRoot, 'shared', 'domain', 'runtimeContract.mjs'), 'utf8'),
      readFile(path.join(repoRoot, 'frontend', 'src', 'api', 'features', 'jobsClient.ts'), 'utf8'),
    ]);

  assert.match(schemaLatest, /app\.idx_jobs_org_due_date_lifecycle/);
  assert.match(schemaLatest, /public\.api_jobs_calendar\(uuid, text, text\)/);
  assert.match(schemaLatest, /public\.api_acl_list_jobs_calendar\(uuid, text, text\)/);
  assert.match(localRoutes, /'\/jobs\/calendar':[\s\S]*buildJobsCalendar/);
  assert.match(edgeRepository, /rpcOrThrow<any\[\]>\(client, "api_acl_list_jobs_calendar"/);
  assert.match(edgeRepository, /p_month: month[\s\S]*p_lifecycle_status: lifecycleStatus/);
  assert.match(edgeRoutes, /"\/jobs\/calendar":[\s\S]*buildJobsCalendar/);
  assert.match(edgeMutations, /"api_acl_jobs_set_staged_pickup_for_user"/);
  assert.match(runtimeContract, /'\/jobs\/calendar': 'jobs'/);
  assert.match(runtimeContract, /'\/jobs\/set-staged-pickup': 'jobs'/);
  assert.match(frontendClient, /requestReadWithFallback<JobListResponse>\('\/jobs\/calendar'/);
  assert.match(frontendClient, /request<JobDetail>\('POST', '\/jobs\/set-staged-pickup'/);
});
