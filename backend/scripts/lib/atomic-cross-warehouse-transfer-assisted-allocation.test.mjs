import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0191_atomic_cross_warehouse_transfer_assisted_allocation.sql',
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260721100000_atomic_cross_warehouse_transfer_assisted_allocation.sql',
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function stripDollarQuotedBlocks(sql) {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, '$$BLOCK$$');
}

test('0191 remains byte-for-byte mirrored and advances the schema contract', async () => {
  const [backendMigration, supabaseMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
  assert.match(
    schemaCheck,
    /const LATEST_MIGRATION = '0197_film_order_order_scope_semantics\.sql';/,
  );
  assert.match(schemaCheck, /app\.box_transfers\.transfer_created_allocation_id/);
  assert.match(schemaCheck, /box_transfers_transfer_created_allocation_fk/);
  assert.match(schemaCheck, /trg_0191_guard_pending_transfer_allocations/);
});

test('0191 adds a nullable no-backfill link only after proving the canonical key', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const topLevelSql = stripDollarQuotedBlocks(migration);

  assert.match(migration, /add column if not exists transfer_created_allocation_id text;/);
  assert.match(migration, /where allocation_id is null\s+or btrim\(allocation_id\) = '';/s);
  assert.match(migration, /group by org_id, allocation_id\s+having count\(\*\) > 1/s);
  assert.match(migration, /pg_get_constraintdef\(oid\) = 'UNIQUE \(org_id, allocation_id\)'/);
  assert.match(
    migration,
    /foreign key \(org_id, transfer_created_allocation_id\)\s+references app\.allocations\(org_id, allocation_id\)\s+on update no action\s+on delete no action\s+deferrable initially deferred;/s,
  );
  assert.match(
    migration,
    /create unique index if not exists idx_box_transfers_transfer_created_allocation[\s\S]*where transfer_created_allocation_id is not null;/,
  );
  assert.doesNotMatch(topLevelSql, /^\s*(?:insert\s+into|update|delete\s+from|truncate)\s+app\./im);
  assert.doesNotMatch(migration, /alter column transfer_created_allocation_id set not null/i);
});

test('allocation apply validates duplicate use and starts the linked transfer atomically', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /perform app_api\.lock_film_material_flow\(\);/);
  assert.match(migration, /api_allocations_apply_pre_0191\(p_org_id, p_actor, v_payload\)/);
  assert.match(migration, /same box cannot be selected more than once in one allocation apply request/i);
  assert.match(migration, /Transfer-assisted allocation can start only from an in-stock box\./);
  assert.match(migration, /Transfer-assisted allocation requires a box with zero prior reservations\./);
  assert.match(migration, /Cross-warehouse extra film must be transferred and received before it can be allocated\./);
  assert.match(migration, /A cross-warehouse box can satisfy only one requirement per apply request\./);
  assert.match(migration, /app_api\.start_box_transfer_locked\(/);
  assert.match(migration, /'transferIds', to_jsonb\(v_transfer_ids\)/);
});

test('pending-transfer guards block incompatible physical and business mutations', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  for (const message of [
    'Pending-transfer boxes cannot receive additional allocations.',
    'A pending-transfer allocation cannot be fulfilled before receipt.',
    'A pending-transfer allocation cannot be reactivated.',
    'A pending-transfer allocation cannot be strengthened or reassigned.',
    'A job with film still in transfer cannot be staged for pickup.',
    'A job with film still in transfer cannot be completed or consumed.',
    'A requirement with film still in transfer cannot be completed, consumed, or reassigned.',
    'A phase with film still in transfer cannot be completed or consumed.',
    'Transfer history cannot be deleted.',
  ]) {
    assert.ok(migration.includes(message), `Missing guard message: ${message}`);
  }

  assert.match(migration, /before insert or update or delete on app\.allocations/);
  assert.match(migration, /before update or delete on app\.boxes/);
  assert.match(migration, /before insert or update or delete on app\.box_transfers/);
  assert.match(migration, /before update or delete on app\.jobs/);
  assert.match(migration, /before update or delete on app\.job_requirements/);
  assert.match(migration, /before update or delete on app\.job_phases/);
});

test('receipt and cancellation preserve custody, quantity, and allocation history', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const receiveBody = migration.match(
    /create or replace function public\.api_box_transfer_receive[\s\S]*?\n\$\$;\n\ncreate or replace function public\.api_box_transfer_cancel/,
  )?.[0] || '';
  const cancelBody = migration.match(
    /create or replace function public\.api_box_transfer_cancel[\s\S]*?\n\$\$;\n\ncreate or replace function public\.api_acl_box_transfer_start/,
  )?.[0] || '';

  assert.match(receiveBody, /update app\.allocations\s+set box_id = v_destination_box_id,\s+warehouse = v_transfer\.destination_warehouse/s);
  assert.doesNotMatch(receiveBody, /set status = 'ACTIVE'/);
  assert.match(receiveBody, /v_physical_feet := coalesce\(app_api\.box_physical_feet_available\(v_box\), 0\)/);
  assert.match(cancelBody, /if app_api\.trim_text\(v_transfer\.transfer_created_allocation_id\) <> '' then/);
  assert.match(cancelBody, /Explicit compatibility path for historical\/ordinary null-link transfers\./);
  assert.match(cancelBody, /set status = 'CANCELLED'/);
  assert.match(cancelBody, /set status = 'IN_STOCK'/);
  assert.doesNotMatch(cancelBody, /delete from app\.allocations/);
});

test('all reviewed mutation entry points acquire the shared advisory lock before delegation', async () => {
  const [migration, dbClient, localTransfers, localAllocationApply, edgeRoutes, devLockProbe] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(path.join(repoRoot, 'backend', 'src', 'db', 'client.mjs'), 'utf8'),
    readFile(path.join(repoRoot, 'backend', 'src', 'app', 'services', 'runtime', 'boxes', 'transfers.mjs'), 'utf8'),
    readFile(path.join(repoRoot, 'backend', 'src', 'app', 'services', 'runtime', 'runtimeAllocationApply.mjs'), 'utf8'),
    readFile(path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'backend', 'scripts', 'verify-material-flow-lock-order-dev.mjs'), 'utf8'),
  ]);

  for (const wrapper of [
    'api_allocations_remove_box',
    'api_acl_allocations_remove_box',
    'api_acl_boxes_set_status',
    'api_acl_boxes_resolve_checkout_allocations',
    'api_acl_jobs_update',
    'api_acl_job_requirement_set_state',
    'api_acl_job_phase_set_state',
    'api_acl_film_orders_cancel',
    'api_acl_jobs_set_staged_pickup',
    'api_acl_jobs_set_staged_pickup_for_user',
  ]) {
    assert.match(
      migration,
      new RegExp(`create or replace function public\\.${wrapper}[\\s\\S]*?perform app_api\\.lock_film_material_flow\\(\\);`),
    );
  }

  assert.ok(
    dbClient.indexOf("pg_advisory_xact_lock(hashtextextended('film-material-flow', 0))") <
      dbClient.indexOf('lock table'),
    'Local mutations must acquire the advisory lock before table locks.',
  );
  assert.match(localTransfers, /public\.api_acl_box_transfer_start/);
  assert.match(localTransfers, /public\.api_acl_box_transfer_receive/);
  assert.match(localTransfers, /public\.api_acl_box_transfer_cancel/);
  assert.match(localAllocationApply, /public\.api_acl_allocations_apply/);
  assert.match(edgeRoutes, /api_acl_box_transfer_start/);
  assert.match(edgeRoutes, /api_acl_box_transfer_receive/);
  assert.match(edgeRoutes, /api_acl_box_transfer_cancel/);
  assert.match(devLockProbe, /The second material-flow transaction bypassed the shared advisory lock\./);
  assert.match(devLockProbe, /deadlockDetected: false/);
  assert.doesNotMatch(devLockProbe, /\b(?:insert\s+into|update|delete\s+from|truncate)\s+app\./i);
});
