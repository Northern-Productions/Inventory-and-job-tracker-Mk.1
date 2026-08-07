import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const backendMigrationUrl = new URL('../../migrations/0195_residual_efficiency_scoped_reads.sql', import.meta.url);
const supabaseMigrationUrl = new URL(
  '../../../supabase/migrations/20260806150000_residual_efficiency_scoped_reads.sql',
  import.meta.url
);
const schemaGuardUrl = new URL('../check-schema-latest.mjs', import.meta.url);

const signatures = [
  'public.api_acl_job_search_candidate_numbers(uuid, text, text, text)',
  'public.api_acl_job_calendar_candidate_numbers(uuid, date, date, text, text)',
  'public.api_acl_job_attention_candidate_numbers(uuid)',
  'public.api_acl_box_reservation_snapshot(uuid, text[], text[])',
];

test('residual efficiency migration stays byte-aligned between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationUrl),
    readFile(supabaseMigrationUrl),
  ]);
  assert.deepEqual(supabaseMigration, backendMigration);
});

test('summary snapshot removes only list-unused metadata and preserves ordering inputs', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  assert.match(migration, /create or replace function public\.api_acl_job_summary_snapshot\(/);
  assert.match(migration, /to_jsonb\(a\) - array\['id', 'org_id', 'created_by', 'resolved_by', 'notes'\]::text\[\]/);
  assert.match(migration, /order by a\.created_at desc, a\.allocation_id desc/);
  assert.match(migration, /order by f\.created_at desc, f\.film_order_id desc/);
  assert.match(migration, /order by p\.job_id asc, p\.phase_number asc, p\.created_at asc/);
  assert.match(migration, /order by q\.job_number asc, q\.phase_number asc, q\.manufacturer asc, q\.film_name asc, q\.width_in asc/);
  assert.match(migration, /phase_install_end_date/);
  assert.match(migration, /auto_planning_suppressed/);
});

test('candidate RPCs preserve tenant, lifecycle, warehouse, nullable legacy, and calendar overlap semantics', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  assert.match(migration, /api_acl_job_search_candidate_numbers/);
  assert.match(migration, /regexp_replace\(coalesce\(j\.job_number, ''\), '\[\^0-9\]', '', 'g'\)/);
  assert.match(migration, /j\.lifecycle_status::text = v_lifecycle_status/);
  assert.match(migration, /v_warehouse = '' or upper\(app_api\.trim_text\(j\.warehouse\)\) = v_warehouse/);
  assert.match(migration, /a\.job_id is null/);
  assert.match(migration, /f\.job_id is null/);

  assert.match(migration, /api_acl_job_calendar_candidate_numbers/);
  assert.match(migration, /p\.install_date <= p_range_end/);
  assert.match(migration, /p\.install_end_date is not null and p\.install_end_date >= p\.install_date/);
  assert.match(migration, /j\.due_date between p_range_start and p_range_end/);
  assert.match(migration, /a\.job_id = j\.id or \(a\.job_id is null and app_api\.trim_text\(a\.job_number\) = app_api\.trim_text\(j\.job_number\)\)/);
  assert.match(migration, /f\.job_id = j\.id or \(f\.job_id is null and app_api\.trim_text\(f\.job_number\) = app_api\.trim_text\(j\.job_number\)\)/);
  assert.match(migration, /order by a\.created_at desc, a\.allocation_id desc/);
  assert.match(migration, /order by f\.created_at desc, f\.film_order_id desc/);

  assert.match(migration, /api_acl_job_attention_candidate_numbers/);
  assert.match(migration, /j\.lifecycle_status::text = 'ACTIVE'/);
  assert.match(migration, /p\.install_date is not null/);
});

test('reservation snapshot batches exact targets without write behavior', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  assert.match(migration, /api_acl_box_reservation_snapshot/);
  assert.match(migration, /a\.allocation_id = any\(v_allocation_ids\)/);
  assert.match(migration, /upper\(app_api\.trim_text\(a\.box_id\)\) = any\(v_box_ids\)/);
  assert.match(migration, /upper\(app_api\.trim_text\(b\.box_id\)\) = any\(v_box_ids\)/);
  assert.match(migration, /'selectedAllocations', v_selected_allocations/);
  assert.match(migration, /'allocations', v_allocations/);
  assert.match(migration, /'boxes', v_boxes/);
  assert.match(migration, /'jobs', v_jobs/);
  assert.doesNotMatch(migration, /\b(?:insert into|update app\.|delete from|truncate|execute format)\b/i);
});

test('new RPCs remain authenticated-only and preserve feature ACLs', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  for (const signature of signatures) {
    assert.ok(migration.includes(`revoke execute on function ${signature} from public, anon, service_role;`));
    assert.ok(migration.includes(`grant execute on function ${signature} to authenticated;`));
  }
  for (const feature of ['jobs', 'allocations', 'film_orders', 'inventory']) {
    assert.match(migration, new RegExp(`require_effective_feature_access\\(p_org_id, '${feature}', 'read'\\)`));
  }
  assert.doesNotMatch(migration, /'write'/);
});

test('latest schema guard requires migration 0195 and every residual read RPC', async () => {
  const schemaGuard = await readFile(schemaGuardUrl, 'utf8');

  assert.match(schemaGuard, /const LATEST_MIGRATION = '0195_residual_efficiency_scoped_reads\.sql';/);
  for (const signature of signatures) {
    assert.ok(schemaGuard.includes(signature), `Expected schema guard coverage for ${signature}.`);
  }
});
