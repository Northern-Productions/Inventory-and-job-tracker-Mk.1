import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const backendMigrationUrl = new URL('../../migrations/0194_scoped_job_summary_reads.sql', import.meta.url);
const supabaseMigrationUrl = new URL(
  '../../../supabase/migrations/20260806100000_scoped_job_summary_reads.sql',
  import.meta.url
);
const schemaGuardUrl = new URL('../check-schema-latest.mjs', import.meta.url);

test('scoped job summary migration stays byte-aligned between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationUrl),
    readFile(supabaseMigrationUrl),
  ]);

  assert.deepEqual(supabaseMigration, backendMigration);
});

test('scoped job summary RPCs preserve read ACLs, tenant scope, and legacy rows', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  for (const signature of [
    'api_acl_list_jobs_by_ids',
    'api_acl_list_jobs_by_numbers',
    'api_acl_job_summary_snapshot',
    'api_acl_has_film_orders_needing_attention',
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${signature}\\(`));
  }

  assert.match(migration, /require_effective_feature_access\(p_org_id, 'jobs', 'read'\)/);
  assert.match(migration, /require_effective_feature_access\(p_org_id, 'allocations', 'read'\)/);
  assert.match(migration, /require_effective_feature_access\(p_org_id, 'film_orders', 'read'\)/);
  assert.match(migration, /where j\.org_id = p_org_id\s+and j\.id = any\(v_job_ids\)/);
  assert.match(migration, /where j\.org_id = p_org_id\s+and j\.job_number = any\(v_job_numbers\)/);
  assert.match(migration, /a\.job_id is null/);
  assert.match(migration, /f\.job_id is null/);
  assert.match(migration, /p_legacy_job_numbers/);
  assert.match(migration, /p_include_phases/);
  assert.match(migration, /phase_install_end_date/);
  assert.match(migration, /auto_planning_suppressed/);
  assert.match(migration, /f\.status::text = 'FILM_ORDER'/);
  assert.match(migration, /f\.job_date is not null/);
  assert.match(migration, /f\.remaining_to_order_feet > 0/);
  assert.doesNotMatch(migration, /\b(?:insert into|update app\.|delete from|truncate)\b/i);
});

test('scoped job summary RPCs are authenticated-only', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const signatures = [
    'public.api_acl_list_jobs_by_ids(uuid, uuid[])',
    'public.api_acl_list_jobs_by_numbers(uuid, text[])',
    'public.api_acl_job_summary_snapshot(uuid, uuid[], boolean, text[], boolean)',
    'public.api_acl_has_film_orders_needing_attention(uuid)',
  ];

  for (const signature of signatures) {
    assert.ok(
      migration.includes(`revoke execute on function ${signature} from public, anon, service_role;`),
      `Expected authenticated-only revoke for ${signature}.`
    );
    assert.ok(
      migration.includes(`grant execute on function ${signature} to authenticated;`),
      `Expected authenticated grant for ${signature}.`
    );
  }
});

test('latest schema guard retains every migration 0194 scoped read RPC', async () => {
  const schemaGuard = await readFile(schemaGuardUrl, 'utf8');

  assert.match(schemaGuard, /const LATEST_MIGRATION = '0196_film_order_effective_list_status\.sql';/);
  for (const signature of [
    'public.api_acl_list_jobs_by_ids(uuid, uuid[])',
    'public.api_acl_list_jobs_by_numbers(uuid, text[])',
    'public.api_acl_job_summary_snapshot(uuid, uuid[], boolean, text[], boolean)',
    'public.api_acl_has_film_orders_needing_attention(uuid)',
  ]) {
    assert.ok(schemaGuard.includes(signature), `Expected schema guard coverage for ${signature}.`);
  }
});
