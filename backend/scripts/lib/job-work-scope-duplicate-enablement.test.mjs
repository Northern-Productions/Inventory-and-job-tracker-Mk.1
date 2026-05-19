import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0136_enable_job_number_work_scope_uniqueness.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260518020000_enable_job_number_work_scope_uniqueness.sql'
);
const migrationsPath = path.join(repoRoot, 'backend', 'migrations');
const supabaseMigrationsPath = path.join(repoRoot, 'supabase', 'migrations');
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const repositoryPath = path.join(repoRoot, 'backend', 'src', 'app', 'repositories', 'jobsRepository.mjs');
const runtimeMutationsPath = path.join(repoRoot, 'backend', 'src', 'app', 'services', 'runtime', 'runtimeJobsMutations.mjs');
const edgeMutationHandlersPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts');

test('final work scope duplicate enablement migrations stay mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('final work scope duplicate enablement migration is latest in both trees', async () => {
  const backendMigrations = (await readdir(migrationsPath)).filter((entry) => /^\d+_/.test(entry)).sort();
  const supabaseMigrations = (await readdir(supabaseMigrationsPath)).filter((entry) => /^\d+_/.test(entry)).sort();

  assert.equal(backendMigrations.at(-2), '0135_job_work_scope_key_groundwork.sql');
  assert.equal(backendMigrations.at(-1), '0136_enable_job_number_work_scope_uniqueness.sql');
  assert.equal(supabaseMigrations.at(-2), '20260518010000_job_work_scope_key_groundwork.sql');
  assert.equal(supabaseMigrations.at(-1), '20260518020000_enable_job_number_work_scope_uniqueness.sql');
});

test('final uniqueness migration replaces only job-number uniqueness with work-scope uniqueness', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /group by org_id, job_number, work_scope_key\s+having count\(\*\) > 1/is);
  assert.match(migration, /work_scope_key is distinct from app_api\.normalize_job_work_scope_key\(sections\)/i);
  assert.match(migration, /array_agg\(a\.attname::text order by cols\.ordinality\)/);
  assert.match(migration, /\)\s*=\s*array\['org_id', 'job_number'\]::text\[\]/);
  assert.match(migration, /\)\s*=\s*array\['org_id', 'job_number', 'work_scope_key'\]::text\[\]/);
  assert.doesNotMatch(migration, /array_agg\(a\.attname order by cols\.ordinality\)/);
  assert.match(migration, /alter table app\.jobs drop constraint %I/i);
  assert.match(migration, /add constraint jobs_org_job_number_work_scope_key_unique\s+unique \(org_id, job_number, work_scope_key\)/i);
  assert.match(migration, /drop index if exists app\.idx_jobs_org_job_number_work_scope_key/i);
  assert.doesNotMatch(migration, /update\s+app\.jobs/i);
  assert.doesNotMatch(migration, /generated always as/i);
});

test('SQL create path allows different scopes and returns jobId for unambiguous reloads', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /v_work_scope_key text := app_api\.normalize_job_work_scope_key\(v_sections\);/);
  assert.match(migration, /and j\.work_scope_key = v_work_scope_key/);
  assert.match(migration, /when unique_violation then/);
  assert.match(migration, /jobs_org_job_number_work_scope_key_unique/);
  assert.match(migration, /'jobId', v_job\.id::text/);
  assert.match(migration, /jsonb_build_object\('jobIds', jsonb_build_array\(v_job_id\)\)/);
  assert.doesNotMatch(migration, /where j\.org_id = p_org_id\s+and j\.job_number = v_job_number\s+for update/is);
});

test('local and Edge create paths use exact-scope checks and jobId reloads', async () => {
  const [repository, runtimeMutations, edgeMutationHandlers] = await Promise.all([
    readFile(repositoryPath, 'utf8'),
    readFile(runtimeMutationsPath, 'utf8'),
    readFile(edgeMutationHandlersPath, 'utf8'),
  ]);

  assert.match(repository, /on conflict \(id\) do update set/);
  assert.doesNotMatch(repository, /on conflict \(org_id, job_number\)/);
  assert.match(runtimeMutations, /listJobsByNumber\(client, orgId, jobNumber\)/);
  assert.match(runtimeMutations, /duplicateResult\.exactScopeDuplicateExists/);
  assert.match(runtimeMutations, /buildJobDetailById\(client, orgId, nextHeader\.id\)/);
  assert.match(runtimeMutations, /error\.code === '23505'/);
  assert.match(edgeMutationHandlers, /duplicateResult\.exactScopeDuplicateExists/);
  assert.match(edgeMutationHandlers, /deps\.buildJobDetailById\(client, orgId, jobId\)/);
});

test('schema latest guard advances to final duplicate enablement', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /const LATEST_MIGRATION = '0136_enable_job_number_work_scope_uniqueness\.sql';/);
  assert.match(schemaLatest, /array_to_string\(array_agg\(a\.attname::text order by cols\.ordinality\), ','\)/);
  assert.doesNotMatch(schemaLatest, /array_agg\(a\.attname order by cols\.ordinality\)/);
  assert.match(schemaLatest, /columns: String\(row\.columns \|\| ''\)/);
  assert.doesNotMatch(schemaLatest, /Array\.isArray\(row\.columns\)/);
  assert.match(
    schemaLatest,
    /const hasTripletUnique = uniqueColumnSets\.some\(\(row\) => row\.columns === 'org_id,job_number,work_scope_key'\);/
  );
  assert.match(
    schemaLatest,
    /const hasLegacyJobNumberUnique = uniqueColumnSets\.some\(\(row\) => row\.columns === 'org_id,job_number'\);/
  );
  assert.match(schemaLatest, /unique\(org_id, job_number, work_scope_key\)/);
  assert.match(schemaLatest, /must not retain unique\(org_id, job_number\)/);
  assert.match(schemaLatest, /to_regclass\('app\.idx_jobs_org_job_number_work_scope_key'\) is not null as exists/);
  assert.match(schemaLatest, /idx_jobs_org_job_number_work_scope_key must be dropped after duplicate enablement/);
  assert.match(schemaLatest, /on conflict \(id\) do update set/);
  assert.doesNotMatch(schemaLatest, /idx_jobs_org_job_number_work_scope_key must remain non-unique/);
});
