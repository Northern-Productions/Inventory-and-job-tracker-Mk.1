import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import {
  buildFixtureRecoveryPlan,
  buildSignedRuntimeRecord,
  captureAuthState,
  captureFixtureState,
  captureIdentityReferences,
  captureOwnerGuard,
  captureOwnerInvariant,
  captureProtectionFingerprint,
  captureSideEffectState,
  deleteBoxTransferHistoryForRecovery,
  deleteFilmOrderHistoryForRecovery,
  executeFixtureRecoveryTransaction,
  extractBoxTransferGuardFunctionSource,
  fixturePredicate,
  readRuntimeRecoveryAuthority,
  selectFixtureRecoveryMode,
  runtimeCanonicalSerialize
} from './fixture-recovery.mjs';
import {
  createPrivateDirectory,
  writePrivateBytesExclusive,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import {
  removeDisposablePostgres,
  resolvePostgresTools,
  startDisposablePostgres,
  withClient
} from './disposable-postgres.mjs';

function runtimeKey() {
  return crypto.randomBytes(32);
}

function writeAuthority(root, overrides = {}) {
  const directory = path.join(root, 'runtime');
  const keyPath = path.join(root, 'runtime.keys');
  createPrivateDirectory(root);
  createPrivateDirectory(directory);
  const key = runtimeKey();
  const keyBytes = Buffer.concat([Buffer.from('ESRUN001', 'ascii'), key]);
  writePrivateBytesExclusive(keyPath, keyBytes);
  keyBytes.fill(0);
  const projectRef = 'sandboxprojectref1234';
  const applicationCommit = 'a'.repeat(40);
  const organizationIds = [crypto.randomUUID(), crypto.randomUUID()];
  const temporaryUserId = crypto.randomUUID();
  const permanentSmokeUserId = crypto.randomUUID();
  const runTag = 'SANDBOX_GOLDEN_TEST_1234567890';
  const records = {
    manifest: {
      format: 'sandbox-golden-workflow-fixture-v1',
      projectRef,
      runTag,
      permanentSmokeUserId,
      temporaryIdentity: { userId: temporaryUserId },
      cleanupAuthority: { organizationIds, temporaryUserId },
      prefixture: {
        format: 'sandbox-golden-prefixture-v1',
        tableCount: 0,
        projections: [],
        projectionSetDigest: canonicalDigest([]),
        auth: {
          allUsers: 1,
          smokeUsers: 1,
          copiedUsers: 0,
          temporaryUsers: 0,
          usableCopiedCredentials: 0
        },
        sideEffects: {
          netQueue: 0,
          cronJobs: 0,
          netQueueAvailable: false,
          cronAvailable: false
        }
      }
    },
    failure: {
      format: 'sandbox-golden-workflow-failure-v1',
      completedWorkflows: 3
    },
    recovery: {
      format: 'sandbox-golden-recovery-v1',
      projectRef,
      fixtureRows: 4,
      cleanupCommits: 0,
      nonfixtureEqual: true
    },
    lineage: {
      format: 'sandbox-runtime-lineage-v1',
      projectRef,
      applicationCommit,
      certification: { recoveryRequired: true }
    }
  };
  Object.assign(records.manifest, overrides.manifest || {});
  const paths = {
    manifest: path.join(directory, 'golden-workflow-fixture.private.json'),
    failure: path.join(directory, 'golden-workflow-failure.private.json'),
    recovery: path.join(directory, 'golden-workflow-recovery.private.json'),
    lineage: path.join(directory, 'sandbox-runtime-lineage.private.json'),
    journal: path.join(directory, 'golden-workflow-ids.private.jsonl')
  };
  for (const name of ['manifest', 'failure', 'recovery', 'lineage']) {
    writePrivateJsonExclusive(paths[name], buildSignedRuntimeRecord(records[name], key));
  }
  const journal = [
    JSON.stringify({ format: 'sandbox-golden-id-journal-v1', runTag, entries: [] }, null, 2),
    JSON.stringify(
      { category: 'AUTH_CONTEXT', value: organizationIds.map((value) => ({ field: 'orgId', value })) },
      null,
      2
    ),
    JSON.stringify(
      { category: 'BOX_DEALERS_UPSERT', value: [{ field: 'dealerId', value: crypto.randomUUID() }] },
      null,
      2
    )
  ].join('\n');
  writePrivateBytesExclusive(paths.journal, Buffer.from(`${journal}\n`, 'utf8'));
  key.fill(0);
  return {
    directory,
    keyPath,
    paths,
    projectRef,
    applicationCommit,
    organizationIds,
    temporaryUserId,
    permanentSmokeUserId
  };
}

test('runtime recovery authority authenticates exact private records and rejects tampering', () => {
  const root = path.join(os.tmpdir(), `environment-sync-fixture-authority-${crypto.randomBytes(8).toString('hex')}`);
  try {
    const fixture = writeAuthority(root);
    const authority = readRuntimeRecoveryAuthority({
      directoryPath: fixture.directory,
      keyPath: fixture.keyPath,
      manifestPath: fixture.paths.manifest,
      failurePath: fixture.paths.failure,
      recoveryPath: fixture.paths.recovery,
      lineagePath: fixture.paths.lineage,
      journalPath: fixture.paths.journal,
      expectedProjectRef: fixture.projectRef,
      expectedApplicationCommit: fixture.applicationCommit
    });
    assert.deepEqual(authority.organizationIds, fixture.organizationIds);
    assert.equal(authority.temporaryUserId, fixture.temporaryUserId);
    assert.equal(authority.permanentSmokeUserId, fixture.permanentSmokeUserId);
    assert.equal(authority.journal.recordCount, 3);
    assert.equal(authority.journal.evidenceValueCount, 3);
    assert.equal(authority.journal.cleanupTargetCount, 0);
    authority.key.fill(0);

    const record = JSON.parse(fs.readFileSync(fixture.paths.recovery, 'utf8'));
    record.payload.fixtureRows += 1;
    fs.writeFileSync(fixture.paths.recovery, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    assert.throws(
      () =>
        readRuntimeRecoveryAuthority({
          directoryPath: fixture.directory,
          keyPath: fixture.keyPath,
          manifestPath: fixture.paths.manifest,
          failurePath: fixture.paths.failure,
          recoveryPath: fixture.paths.recovery,
          lineagePath: fixture.paths.lineage,
          journalPath: fixture.paths.journal,
          expectedProjectRef: fixture.projectRef,
          expectedApplicationCommit: fixture.applicationCommit
        }),
      (error) => error?.code === 'FIXTURE_RECOVERY_RECORD_AUTHENTICATION_FAILED'
    );
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: false });
  }
});

test('runtime recovery journal accepts bounded evidence but never broadens manifest authority', () => {
  const root = path.join(os.tmpdir(), `environment-sync-fixture-journal-${crypto.randomBytes(8).toString('hex')}`);
  try {
    const fixture = writeAuthority(root);
    const readAuthority = () =>
      readRuntimeRecoveryAuthority({
        directoryPath: fixture.directory,
        keyPath: fixture.keyPath,
        manifestPath: fixture.paths.manifest,
        failurePath: fixture.paths.failure,
        recoveryPath: fixture.paths.recovery,
        lineagePath: fixture.paths.lineage,
        journalPath: fixture.paths.journal,
        expectedProjectRef: fixture.projectRef,
        expectedApplicationCommit: fixture.applicationCommit
      });

    const authority = readAuthority();
    assert.equal(authority.journal.cleanupTargetCount, 0);
    assert.deepEqual(authority.organizationIds, fixture.organizationIds);
    authority.key.fill(0);

    fs.appendFileSync(
      fixture.paths.journal,
      `${JSON.stringify({
        category: 'FILM_ORDERS_GET',
        value: [{ field: 'film_order_id', value: crypto.randomUUID() }]
      })}\n`,
      { encoding: 'utf8' }
    );
    const snakeCaseAuthority = readAuthority();
    assert.equal(snakeCaseAuthority.journal.recordCount, 4);
    assert.equal(snakeCaseAuthority.journal.evidenceValueCount, 4);
    assert.equal(snakeCaseAuthority.journal.cleanupTargetCount, 0);
    assert.deepEqual(snakeCaseAuthority.organizationIds, fixture.organizationIds);
    snakeCaseAuthority.key.fill(0);

    const invalidJournal = [
      JSON.stringify({
        format: 'sandbox-golden-id-journal-v1',
        runTag: 'SANDBOX_GOLDEN_TEST_1234567890',
        entries: []
      }),
      JSON.stringify({
        category: 'AUTH_CONTEXT',
        value: [{ field: 'orgId', value: crypto.randomUUID() }]
      })
    ].join('\n');
    fs.writeFileSync(fixture.paths.journal, `${invalidJournal}\n`, { mode: 0o600 });
    assert.throws(readAuthority, (error) => error?.code === 'FIXTURE_RECOVERY_JOURNAL_SCOPE_INVALID');
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: false });
  }
});

test('fixture predicates use only exact manifest-root relationships', () => {
  assert.deepEqual(fixturePredicate('organizations', ['id']), {
    sql: 't.id = any($1::uuid[])',
    usesOrganizations: true
  });
  assert.deepEqual(fixturePredicate('warehouses', ['id', 'org_id']), {
    sql: 't.org_id = any($1::uuid[])',
    usesOrganizations: true
  });
  assert.deepEqual(
    fixturePredicate('user_organization_preferences', ['user_id', 'selected_org_id']),
    { sql: 't.selected_org_id = any($1::uuid[])', usesOrganizations: true }
  );
  assert.deepEqual(fixturePredicate('unrelated', ['id']), {
    sql: 'false',
    usesOrganizations: false
  });
});

test('Film Order history recovery deletes exact-root history in trigger-safe count-checked order', async () => {
  const organizationIds = [crypto.randomUUID(), crypto.randomUUID()];
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('delete from app.film_order_box_links')) return { rowCount: 1 };
      if (sql.startsWith('delete from app.film_orders')) return { rowCount: 1 };
      if (sql.startsWith('delete from app.film_order_events')) return { rowCount: 8 };
      throw new Error('unexpected query');
    }
  };
  const result = await deleteFilmOrderHistoryForRecovery(
    client,
    { organizationIds },
    {
      expected: {
        fixtureCounts: {
          film_order_box_links: 1,
          film_orders: 1,
          film_order_events: 6
        }
      }
    }
  );
  assert.deepEqual(result, {
    linksDeleted: 1,
    ordersDeleted: 1,
    eventsDeleted: 8,
    generatedEventsDeleted: 2
  });
  assert.deepEqual(
    calls.map(({ sql }) => sql.match(/^delete from app\.([a-z_]+)/)?.[1]),
    ['film_order_box_links', 'film_orders', 'film_order_events']
  );
  assert.ok(calls.every(({ values }) => values?.[0] === organizationIds));
});

test('recovery mode selects exact trigger-safe history ordering from complete signed budgets', () => {
  assert.equal(
    selectFixtureRecoveryMode({
      expected: { fixtureCounts: { film_order_box_links: 0, film_orders: 0, box_transfers: 0 } }
    }),
    'ordinary'
  );
  assert.equal(
    selectFixtureRecoveryMode({
      expected: { fixtureCounts: { film_order_box_links: 1, film_orders: 1, box_transfers: 0 } }
    }),
    'film-order-event-trigger-fk'
  );
  assert.equal(
    selectFixtureRecoveryMode({
      expected: { fixtureCounts: { film_order_box_links: 0, film_orders: 0, box_transfers: 1 } }
    }),
    'box-transfer-immutable-history'
  );
  assert.equal(
    selectFixtureRecoveryMode({
      expected: { fixtureCounts: { film_order_box_links: 1, film_orders: 1, box_transfers: 2 } }
    }),
    'film-order-and-box-transfer-history'
  );
  assert.throws(
    () => selectFixtureRecoveryMode({
      expected: { fixtureCounts: { film_order_box_links: 1, film_orders: 0, box_transfers: 0 } }
    }),
    (error) => error?.code === 'FIXTURE_RECOVERY_FILM_ORDER_HISTORY_BUDGET_INCONSISTENT'
  );
  assert.throws(
    () => selectFixtureRecoveryMode({
      expected: { fixtureCounts: { film_order_box_links: 0, film_orders: 1, box_transfers: 0 } }
    }),
    (error) => error?.code === 'FIXTURE_RECOVERY_FILM_ORDER_HISTORY_BUDGET_INCONSISTENT'
  );
});

test('box transfer recovery suspends only its exact guard and restores it after exact-root deletion', async () => {
  const organizationIds = [crypto.randomUUID(), crypto.randomUUID()];
  const expectedSource = 'begin\n  return new;\nend;';
  const calls = [];
  let enabled = 'O';
  const client = {
    async query(sql, values) {
      calls.push({ sql: String(sql).trim(), values });
      if (String(sql).includes('from pg_catalog.pg_trigger trigger')) {
        return {
          rowCount: 1,
          rows: [{
            tgenabled: enabled,
            trigger_type: 31,
            trigger_definition: 'CREATE TRIGGER trg_0191_guard_box_transfers BEFORE INSERT OR DELETE OR UPDATE ON app.box_transfers FOR EACH ROW EXECUTE FUNCTION app_api.guard_box_transfer_mutation()',
            function_source: expectedSource,
            security_definer: true,
            proconfig: ['search_path=public, app, app_api'],
            function_schema: 'app_api',
            function_name: 'guard_box_transfer_mutation',
            identity_arguments: '',
            owner_role: 'postgres'
          }]
        };
      }
      if (String(sql).includes('DISABLE TRIGGER trg_0191_guard_box_transfers')) {
        enabled = 'D';
        return { rowCount: null, rows: [] };
      }
      if (String(sql).startsWith('delete from app.box_transfers')) return { rowCount: 2, rows: [] };
      if (String(sql) === 'SET CONSTRAINTS ALL IMMEDIATE') return { rowCount: null, rows: [] };
      if (String(sql).includes('ENABLE TRIGGER trg_0191_guard_box_transfers')) {
        enabled = 'O';
        return { rowCount: null, rows: [] };
      }
      throw new Error('unexpected query');
    }
  };

  const result = await deleteBoxTransferHistoryForRecovery(
    client,
    { organizationIds },
    { expected: { fixtureCounts: { box_transfers: 2 } } },
    expectedSource
  );
  assert.deepEqual(result, { transfersDeleted: 2, transferGuardRestored: true });
  assert.deepEqual(
    calls
      .filter(({ sql }) => !sql.includes('from pg_catalog.pg_trigger trigger'))
      .map(({ sql }) => sql),
    [
      'ALTER TABLE app.box_transfers DISABLE TRIGGER trg_0191_guard_box_transfers',
      'delete from app.box_transfers where org_id = any($1::uuid[])',
      'SET CONSTRAINTS ALL IMMEDIATE',
      'ALTER TABLE app.box_transfers ENABLE TRIGGER trg_0191_guard_box_transfers'
    ]
  );
  assert.equal(calls.find(({ sql }) => sql.startsWith('delete from app.box_transfers')).values[0], organizationIds);
});

test('box transfer recovery pins the canonical immutable-history guard source', () => {
  const migration = fs.readFileSync(
    new URL('../../../migrations/0191_atomic_cross_warehouse_transfer_assisted_allocation.sql', import.meta.url),
    'utf8'
  );
  const source = extractBoxTransferGuardFunctionSource(migration);
  assert.match(source, /if tg_op = 'DELETE' then/);
  assert.match(source, /Transfer history cannot be deleted\./);
  assert.match(source, /current_transfer_workflow_action\(\)/);
  assert.throws(
    () => extractBoxTransferGuardFunctionSource('select 1;'),
    (error) => error?.code === 'FIXTURE_RECOVERY_BOX_TRANSFER_GUARD_SOURCE_MISSING'
  );
});

test('Film Order history recovery refuses generated-history budget drift', async () => {
  const client = {
    async query(sql) {
      if (sql.startsWith('delete from app.film_order_box_links')) return { rowCount: 1 };
      if (sql.startsWith('delete from app.film_orders')) return { rowCount: 1 };
      if (sql.startsWith('delete from app.film_order_events')) return { rowCount: 7 };
      throw new Error('unexpected query');
    }
  };
  await assert.rejects(
    deleteFilmOrderHistoryForRecovery(
      client,
      { organizationIds: [crypto.randomUUID(), crypto.randomUUID()] },
      {
        expected: {
          fixtureCounts: {
            film_order_box_links: 1,
            film_orders: 1,
            film_order_events: 6
          }
        }
      }
    ),
    (error) => error?.code === 'FIXTURE_RECOVERY_FILM_ORDER_EVENT_DELETE_COUNT_MISMATCH'
  );
});

async function baselineFor(client, organizationIds) {
  const tables = (await client.query(`
    select table_name
      from information_schema.tables
     where table_schema = 'app' and table_type = 'BASE TABLE'
     order by table_name
  `)).rows;
  const projections = [];
  for (const { table_name: table } of tables) {
    const rows = await client.query(`select to_jsonb(t) as row from app.${table} t order by to_jsonb(t)::text`);
    const digest = crypto.createHash('sha256');
    for (const row of rows.rows) digest.update(`${runtimeCanonicalSerialize(row.row)}\n`);
    projections.push({ table, count: rows.rowCount, digest: `sha256:${digest.digest('hex')}` });
  }
  return {
    format: 'sandbox-golden-prefixture-v1',
    tableCount: projections.length,
    projections,
    projectionSetDigest: canonicalDigest(projections),
    auth: {
      allUsers: 1,
      smokeUsers: 1,
      copiedUsers: 0,
      temporaryUsers: 0,
      usableCopiedCredentials: 0
    },
    sideEffects: {
      netQueue: 0,
      cronJobs: 0,
      netQueueAvailable: false,
      cronAvailable: false
    },
    organizationIds
  };
}

test('serializable recovery suspends only the exact owner guard and restores it before commit', { timeout: 120_000 }, async (t) => {
  let tools;
  try {
    tools = resolvePostgresTools();
  } catch {
    t.skip('Complete PostgreSQL 18 server tooling is unavailable.');
    return;
  }
  const root = path.join(os.tmpdir(), `environment-sync-rehearsal-source-${crypto.randomBytes(8).toString('hex')}`);
  let cluster;
  try {
    cluster = await startDisposablePostgres({ rootDirectory: root, postgresBin: tools.bin });
    await withClient(cluster.connectionString(), async (client) => {
      const survivorOrg = crypto.randomUUID();
      const fixtureOrgs = [crypto.randomUUID(), crypto.randomUUID()];
      const smokeUser = crypto.randomUUID();
      const temporaryUser = crypto.randomUUID();
      const functionSource = `declare
  v_remaining_owner_count integer;
begin
  if tg_op = 'DELETE' and old.role = 'owner' and old.status = 'active' then
    select count(*) into v_remaining_owner_count
      from app.organization_members membership
     where membership.org_id = old.org_id
       and membership.role = 'owner'
       and membership.status = 'active'
       and membership.user_id <> old.user_id;
    if v_remaining_owner_count = 0 then
      raise exception 'At least one active owner must remain.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;`;
      await client.query(`
        create schema app;
        create schema app_api;
        create schema auth;
        create table auth.users (
          id uuid primary key,
          raw_user_meta_data jsonb not null default '{}'::jsonb,
          encrypted_password text not null,
          banned_until timestamptz
        );
        create table app.organizations (id uuid primary key);
        create table app.organization_members (
          org_id uuid not null references app.organizations(id) on delete cascade,
          user_id uuid not null,
          role text not null,
          status text not null,
          primary key (org_id, user_id)
        );
        create or replace function app.prevent_last_owner_loss()
        returns trigger
        language plpgsql
        security definer
        set search_path = public, app, app_api
        as $$${functionSource}$$;
        create trigger trg_prevent_last_owner_loss
        before update or delete on app.organization_members
        for each row execute function app.prevent_last_owner_loss();
      `);
      await client.query('insert into auth.users values ($1, $2, $3, $4), ($5, $6, $7, $8)', [
        smokeUser,
        { x_np_target_native_smoke: true },
        'native-smoke-password',
        null,
        temporaryUser,
        { x_np_target_native_temporary: true },
        'temporary-password',
        null
      ]);
      await client.query('insert into app.organizations(id) values($1)', [survivorOrg]);
      await client.query(
        "insert into app.organization_members(org_id,user_id,role,status) values($1,$2,'owner','active')",
        [survivorOrg, smokeUser]
      );
      const prefixture = await baselineFor(client, fixtureOrgs);
      for (const orgId of fixtureOrgs) {
        await client.query('insert into app.organizations(id) values($1)', [orgId]);
        await client.query(
          "insert into app.organization_members(org_id,user_id,role,status) values($1,$2,'owner','active')",
          [orgId, smokeUser]
        );
      }
      await client.query('begin');
      await assert.rejects(
        client.query('delete from app.organizations where id = any($1::uuid[])', [fixtureOrgs]),
        (error) => error?.code === 'P0001'
      );
      await client.query('rollback');

      const manifest = {
        format: 'sandbox-golden-workflow-fixture-v1',
        projectRef: 'sandboxprojectref1234',
        runTag: 'SANDBOX_RECOVERY_LOCAL_1234567890',
        permanentSmokeUserId: smokeUser,
        cleanupAuthority: { organizationIds: fixtureOrgs, temporaryUserId: temporaryUser },
        prefixture
      };
      const authority = {
        manifest,
        recovery: { fixtureRows: 4 },
        organizationIds: fixtureOrgs,
        temporaryUserId: temporaryUser,
        permanentSmokeUserId: smokeUser,
        manifestByteDigest: canonicalDigest('manifest'),
        failureByteDigest: canonicalDigest('failure'),
        recoveryByteDigest: canonicalDigest('recovery'),
        lineageByteDigest: canonicalDigest('lineage'),
        journal: { byteDigest: canonicalDigest('journal'), recordCount: 2 }
      };
      const fixtureState = await captureFixtureState(client, authority);
      const authState = await captureAuthState(client, authority);
      const identityReferences = await captureIdentityReferences(client, authority);
      const sideEffects = await captureSideEffectState(client);
      const ownerGuard = await captureOwnerGuard(client, functionSource);
      const protection = await captureProtectionFingerprint(client);
      const ownerInvariantViolations = await captureOwnerInvariant(client, fixtureOrgs);
      const plan = buildFixtureRecoveryPlan({
        authority,
        fixtureState,
        authState,
        identityReferences,
        sideEffects,
        ownerGuard,
        protection,
        ownerInvariantViolations,
        expectedApplicationCommit: 'a'.repeat(40),
        createdAt: '2026-08-22T00:00:00.000Z'
      });
      let injected = false;
      const failingClient = {
        async query(sql, values) {
          if (!injected && /^delete from app\.organizations/i.test(String(sql))) {
            injected = true;
            const error = new Error('injected local failure');
            error.code = 'LOCAL_TEST_FAILURE';
            throw error;
          }
          return client.query(sql, values);
        }
      };
      await assert.rejects(
        executeFixtureRecoveryTransaction({
          client: failingClient,
          authority,
          plan,
          expectedFunctionSource: functionSource
        }),
        (error) => error?.code === 'LOCAL_TEST_FAILURE'
      );
      assert.equal(
        Number((await client.query('select count(*) from app.organizations where id = any($1::uuid[])', [fixtureOrgs])).rows[0].count),
        2
      );
      assert.equal(
        (await client.query("select tgenabled from pg_trigger where tgname='trg_prevent_last_owner_loss'")).rows[0].tgenabled,
        'O'
      );

      const result = await executeFixtureRecoveryTransaction({
        client,
        authority,
        plan,
        expectedFunctionSource: functionSource
      });
      assert.equal(result.committed, true);
      assert.equal(result.deletedOrganizationRoots, 2);
      assert.equal(result.fixtureRowsDeleted, 4);
      assert.equal(
        Number((await client.query('select count(*) from app.organizations where id = any($1::uuid[])', [fixtureOrgs])).rows[0].count),
        0
      );
      assert.equal(
        (await client.query("select tgenabled from pg_trigger where tgname='trg_prevent_last_owner_loss'")).rows[0].tgenabled,
        'O'
      );
      assert.equal(await captureOwnerInvariant(client, []), 0);
      assert.equal((await captureFixtureState(client, authority)).baselineEqual, true);
    });
  } finally {
    if (cluster) await removeDisposablePostgres(cluster);
  }
});
