import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0190_calendar_cancel_service_role_grant_normalization.sql',
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260714170000_calendar_cancel_service_role_grant_normalization.sql',
);
const candidateMigrationPaths = [
  path.join(repoRoot, 'backend', 'migrations', '0189_jobs_calendar_mirror_remediation.sql'),
  path.join(repoRoot, 'supabase', 'migrations', '20260714160000_jobs_calendar_mirror_remediation.sql'),
];
const candidateMigrationDigest = '33a7a6c9d177ba04ea27a72ecf1ff99905f19de4fa1df9bdcad53c59bcfb38b3';
const targetFunctionNames = [
  'api_jobs_calendar',
  'api_acl_list_jobs_calendar',
  'api_film_orders_cancel',
  'api_acl_film_orders_cancel',
];

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n?/g, '\n');
}

function normalizedDigest(sql) {
  return crypto.createHash('sha256').update(normalizeSql(sql).trim()).digest('hex');
}

function executableStatements(sql) {
  return normalizeSql(sql)
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
}

async function collectRuntimeSources(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await collectRuntimeSources(entryPath)));
      continue;
    }
    if (!/\.(?:js|mjs|ts|tsx)$/.test(entry.name) || /\.test\./.test(entry.name)) {
      continue;
    }
    sources.push({ path: entryPath, source: await readFile(entryPath, 'utf8') });
  }
  return sources;
}

test('0190 is exactly mirrored while candidate migration 0189 remains immutable', async () => {
  const [backendMigration, supabaseMigration, schemaLatest, ...candidateMigrations] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs'), 'utf8'),
    ...candidateMigrationPaths.map((migrationPath) => readFile(migrationPath, 'utf8')),
  ]);

  assert.equal(normalizeSql(supabaseMigration), normalizeSql(backendMigration));
  assert.match(
    schemaLatest,
    /const LATEST_MIGRATION = '0192_atomic_cross_warehouse_affected_box_scan\.sql';/,
  );
  for (const candidateMigration of candidateMigrations) {
    assert.equal(normalizedDigest(candidateMigration), candidateMigrationDigest);
  }
  assert.equal(normalizeSql(candidateMigrations[0]), normalizeSql(candidateMigrations[1]));
});

test('0190 contains only the six approved exact-signature execute statements', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.deepEqual(executableStatements(migration), [
    'revoke execute on function public.api_jobs_calendar(uuid, text, text) from public, anon, authenticated, service_role',
    'revoke execute on function public.api_acl_list_jobs_calendar(uuid, text, text) from public, anon, service_role',
    'grant execute on function public.api_acl_list_jobs_calendar(uuid, text, text) to authenticated',
    'revoke execute on function public.api_film_orders_cancel(uuid, text, jsonb) from public, anon, authenticated, service_role',
    'revoke execute on function public.api_acl_film_orders_cancel(uuid, text, jsonb) from public, anon, service_role',
    'grant execute on function public.api_acl_film_orders_cancel(uuid, text, jsonb) to authenticated',
  ]);
});

test('0190 has no function, schema, table, auth, or business-data side effects', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  assert.doesNotMatch(migration, /\bcreate\s+(?:or\s+replace\s+)?function\b/i);
  assert.doesNotMatch(migration, /\b(?:alter|drop)\s+function\b/i);
  assert.doesNotMatch(migration, /\b(?:grant|revoke)\s+usage\s+on\s+schema\b/i);
  assert.doesNotMatch(migration, /\b(?:grant|revoke)\b[^;]*\bon\s+(?:table|all\s+tables)\b/i);
  assert.doesNotMatch(migration, /\b(?:insert|update|delete|merge|upsert|truncate|backfill|reset)\b/i);
  assert.doesNotMatch(migration, /\b(?:alter|create)\s+(?:role|policy)\b/i);
  assert.doesNotMatch(migration, /\ball\s+functions\b/i);
});

test('schema latest fails closed on identity, owner, security, overload, or effective grant drift', async () => {
  const schemaLatest = await readFile(
    path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs'),
    'utf8',
  );

  for (const signature of [
    'public.api_jobs_calendar(uuid, text, text)',
    'public.api_acl_list_jobs_calendar(uuid, text, text)',
    'public.api_film_orders_cancel(uuid, text, jsonb)',
    'public.api_acl_film_orders_cancel(uuid, text, jsonb)',
  ]) {
    assert.match(schemaLatest, new RegExp(signature.replace(/[().]/g, '\\$&')));
  }
  assert.match(schemaLatest, /pg_get_userbyid\(p\.proowner\) as owner_name/);
  assert.match(schemaLatest, /row\.owner_name !== 'postgres'/);
  assert.match(schemaLatest, /p\.prosecdef as security_definer/);
  assert.match(schemaLatest, /row\.security_definer !== true/);
  assert.match(schemaLatest, /has_function_privilege\('public', p\.oid, 'EXECUTE'\) as public_execute/);
  assert.match(schemaLatest, /has_function_privilege\('anon', p\.oid, 'EXECUTE'\) as anon_execute/);
  assert.match(
    schemaLatest,
    /has_function_privilege\('authenticated', p\.oid, 'EXECUTE'\) as authenticated_execute/,
  );
  assert.match(
    schemaLatest,
    /has_function_privilege\('service_role', p\.oid, 'EXECUTE'\) as service_role_execute/,
  );
  assert.match(schemaLatest, /\['public\.api_jobs_calendar\(uuid, text, text\)', false\]/);
  assert.match(schemaLatest, /\['public\.api_acl_list_jobs_calendar\(uuid, text, text\)', true\]/);
  assert.match(schemaLatest, /\['public\.api_film_orders_cancel\(uuid, text, jsonb\)', false\]/);
  assert.match(schemaLatest, /\['public\.api_acl_film_orders_cancel\(uuid, text, jsonb\)', true\]/);
  assert.match(schemaLatest, /row\.public_execute === true/);
  assert.match(schemaLatest, /row\.anon_execute === true/);
  assert.match(schemaLatest, /row\.authenticated_execute !== expectedAuthenticatedExecute/);
  assert.match(schemaLatest, /row\.service_role_execute === true/);
  assert.match(schemaLatest, /Number\(row\.overload_count\) !== 1/);
});

test('checked-in runtime keeps authenticated ACL callers and has no target service-role invocation', async () => {
  const [runtimeSources, edgeRepository, mutationHandlers, authSource] = await Promise.all([
    Promise.all([
      collectRuntimeSources(path.join(repoRoot, 'backend', 'src')),
      collectRuntimeSources(path.join(repoRoot, 'frontend', 'src')),
      collectRuntimeSources(path.join(repoRoot, 'shared')),
      collectRuntimeSources(path.join(repoRoot, 'supabase', 'functions')),
    ]).then((groups) => groups.flat()),
    readFile(
      path.join(repoRoot, 'supabase', 'functions', '_shared', 'repositories', 'inventoryRepositories.ts'),
      'utf8',
    ),
    readFile(
      path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts'),
      'utf8',
    ),
    readFile(path.join(repoRoot, 'supabase', 'functions', '_shared', 'auth.ts'), 'utf8'),
  ]);
  const runtime = runtimeSources.map(({ path: sourcePath, source }) => `${sourcePath}\n${source}`).join('\n');
  const targetAlternation = targetFunctionNames.join('|');

  assert.match(edgeRepository, /rpcOrThrow<any\[\]>\(client, "api_acl_list_jobs_calendar"/);
  assert.match(mutationHandlers, /callMutationRpc\(client, "api_acl_film_orders_cancel"/);
  assert.match(authSource, /client: deps\.createUserScopedClient\(token\)/);
  assert.match(authSource, /const client = deps\.createUserScopedClient\(token\);/);
  assert.doesNotMatch(runtime, /["']api_jobs_calendar["']/);
  assert.doesNotMatch(runtime, /["']api_film_orders_cancel["']/);
  assert.doesNotMatch(
    runtime,
    new RegExp(
      `(?:serviceClient|serviceRoleClient)\\s*\\.\\s*rpc\\s*\\(\\s*["'](?:${targetAlternation})["']`,
      'i',
    ),
  );
  assert.doesNotMatch(
    runtime,
    new RegExp(
      `(?:rpcOrThrow|callMutationRpc)(?:<[^>]*>)?\\s*\\(\\s*(?:serviceClient|serviceRoleClient)\\s*,\\s*["'](?:${targetAlternation})["']`,
      'i',
    ),
  );
});
