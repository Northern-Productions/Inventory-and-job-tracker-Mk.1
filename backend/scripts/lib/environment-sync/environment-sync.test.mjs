import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { canonicalDigest } from '../readonly-diagnostics.mjs';

import {
  CURRENT_AUTH_TABLES,
  ENVIRONMENT_INVENTORY_FORMAT,
  SIDE_EFFECT_POLICY_VERSION
} from './constants.mjs';
import {
  buildArchitectureAlignmentTemplate,
  buildGoldenWorkflowContract,
  buildSyncRunbook
} from './contracts.mjs';
import {
  authenticateManifest,
  buildBaselineManifest,
  buildDerivedManifest,
  compareInventoriesWithExceptions,
  sha256Bytes,
  verifyAuthenticatedManifest,
  verifyComponentBytes
} from './manifest.mjs';
import { buildDevPreservationManifest, buildDevRecoveryManifest } from './preservation.mjs';
import { assertProdSourcePlatform, runGoldenBaselineRehearsal } from './rehearsal.mjs';
import { applyAuthQuarantine } from './auth-quarantine.mjs';
import {
  captureEncryptedPgDump,
  decryptBaselineBytes,
  encryptBaselineBytes,
  restoreEncryptedPgDump
} from './encrypted-baseline.mjs';
import { captureEnvironmentInventory } from './inventory.mjs';
import { writePrivateBytesExclusive } from './private-artifacts.mjs';
import { verifySideEffectQuarantine } from './side-effect-quarantine.mjs';
import {
  assertDisposableRoot,
  prepareRestoreDatabase,
  removeDisposablePostgres,
  resolvePostgresTools,
  startDisposablePostgres,
  withClient
} from './disposable-postgres.mjs';

function digest(value = '') {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function inventory() {
  return {
    format: ENVIRONMENT_INVENTORY_FORMAT,
    migration: { count: 185, tip: '20260814210000', digest: digest('migration') },
    catalog: { routines: { count: 1, digest: digest('routine') } },
    protectedData: { tables: [] },
    authTopology: { users: 1 },
    edge: { health: { apiVersion: 'v279' } },
    sideEffects: { database: {} }
  };
}

test('authenticated baseline and derived manifests fail closed on tampering', () => {
  const key = crypto.randomBytes(32);
  const bytes = Buffer.from('encrypted-component');
  try {
    const baseline = authenticateManifest(
      buildBaselineManifest({
        baselineId: 'x-test',
        sourceSnapshotTimestamp: '2026-08-16T00:00:00.000Z',
        sourceCommit: 'a'.repeat(40),
        inventory: inventory(),
        components: [{ name: 'database', size: bytes.length, digest: sha256Bytes(bytes) }],
        edgeIdentity: {
          source: 'certified-main',
          graphDigest: digest('edge-graph'),
          lockDigest: digest('edge-lock')
        }
      }),
      key
    );
    assert.equal(verifyAuthenticatedManifest(baseline, key), true);
    assert.equal(verifyComponentBytes(baseline.components[0], bytes), true);
    const derived = authenticateManifest(
      buildDerivedManifest({
        baselineManifest: baseline,
        target: { environment: 'sandbox', projectRef: 'future-ref' },
        transform: { id: 'x-np', version: 'v1' },
        inventory: inventory(),
        allowedExceptions: ['/target/environment']
      }),
      key
    );
    assert.equal(verifyAuthenticatedManifest(derived, key), true);
    assert.throws(() => verifyAuthenticatedManifest({ ...derived, baselineId: 'changed' }, key));
    assert.throws(() => verifyComponentBytes(baseline.components[0], Buffer.from('changed')));
    assert.throws(() =>
      buildBaselineManifest({
        baselineId: 'x-test',
        sourceSnapshotTimestamp: 'not-an-iso-timestamp',
        sourceCommit: 'not-a-commit',
        inventory: inventory(),
        components: []
      })
    );
  } finally {
    key.fill(0);
    bytes.fill(0);
  }
});

test('parity comparison rejects undeclared and missing declared differences', () => {
  const left = { target: 'dev', stable: 1, declared: true };
  const right = { target: 'sandbox', stable: 1 };
  assert.deepEqual(compareInventoriesWithExceptions(left, right, ['/declared', '/target']).ok, true);
  assert.equal(compareInventoriesWithExceptions(left, right, ['/target']).ok, false);
  assert.equal(compareInventoriesWithExceptions(left, right, ['/declared', '/target', '/stable']).ok, false);
});

test('side-effect quarantine requires positive non-production evidence', () => {
  const inventoryValue = {
    sideEffects: {
      database: {
        pgCronJobs: 0,
        pgNetEnabled: false,
        databaseWebhookCount: 0,
        foreignTableCount: 0,
        externalFunctionReferenceCount: 0
      }
    },
    platform: { secrets: { names: [] } }
  };
  const policy = {
    version: SIDE_EFFECT_POLICY_VERSION,
    target: 'sandbox',
    authEmailMode: 'disabled',
    smsMode: 'disabled',
    edgeSecretsTargetLocal: true,
    frontendProductionAliasAbsent: true,
    nonprodUrlsVerified: true,
    storageBehaviorReviewed: true,
    databaseNetworkExtensionsDisabled: false
  };
  assert.equal(verifySideEffectQuarantine({ inventory: inventoryValue, policy }).ok, true);
  assert.equal(
    verifySideEffectQuarantine({
      inventory: { ...inventoryValue, platform: { secrets: { names: ['PROD_WEBHOOK_SECRET'] } } },
      policy
    }).ok,
    false
  );
  assert.equal(
    verifySideEffectQuarantine({
      inventory: {
        ...inventoryValue,
        sideEffects: { database: { ...inventoryValue.sideEffects.database, pgNetEnabled: true } }
      },
      policy
    }).ok,
    false
  );
  assert.equal(
    verifySideEffectQuarantine({
      inventory: {
        ...inventoryValue,
        sideEffects: { database: { ...inventoryValue.sideEffects.database, pgNetEnabled: true } }
      },
      policy: { ...policy, databaseNetworkExtensionsDisabled: true }
    }).ok,
    true
  );
});

test('DEV preservation and recovery manifests retain names and categories, not values', () => {
  const preserved = buildDevPreservationManifest({
    projectRef: 'dev-ref',
    capturedAt: '2026-08-16T00:00:00.000Z',
    smokeIdentity: {
      userId: 'private-user-id',
      memberships: [{ orgId: 'private-org-id', role: 'admin', status: 'active' }]
    },
    secretNames: ['EDGE_SECRET_NAME'],
    environmentVariableNames: ['DEV_DATABASE_URL'],
    retainedTestConfiguration: ['checkout-smoke']
  });
  assert.deepEqual(preserved.secretNames, ['EDGE_SECRET_NAME']);
  assert.equal(JSON.stringify(preserved).includes('secret-value'), false);
  const recovery = buildDevRecoveryManifest({
    recoveryId: 'y-test',
    capturedAt: '2026-08-16T00:00:00.000Z',
    inventoryDigest: digest('inventory'),
    preservationManifestDigest: digest('preservation'),
    restoreTest: { completed: true, result: 'passed' }
  });
  assert.equal(recovery.restoreTest.completed, true);
  assert.equal(recovery.retention, 'through_post_refresh_acceptance');
});

test('runbook and architecture handoff preserve the approved sequence and 20 workflows', () => {
  const workflows = buildGoldenWorkflowContract();
  assert.equal(workflows.workflows.length, 20);
  assert.deepEqual(buildSyncRunbook().checkpoints.map((entry) => entry.id), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.ok(buildArchitectureAlignmentTemplate().sections.includes('film_physical_capacity_model'));
});

test('PROD rehearsal platform evidence is pinned and drift fails closed', () => {
  const management = {
    available: true,
    project: { status: 'ACTIVE_HEALTHY', region: 'us-west-2' },
    edge: { deployments: [{ slug: 'api', version: 279, status: 'ACTIVE', verifyJwt: false }] }
  };
  const health = {
    available: true,
    status: 'ok',
    buildSha: '647ecc8611a2283ac3d77a56d1103a03b4ad268d'
  };
  assert.equal(assertProdSourcePlatform(management, health), true);
  assert.throws(
    () => assertProdSourcePlatform(management, { ...health, buildSha: '0'.repeat(40) }),
    (error) => error?.code === 'PROD_SOURCE_PLATFORM_DRIFT'
  );
});

test('disposable PostgreSQL cleanup authority accepts only exact rehearsal roots', () => {
  const accepted = path.join(os.tmpdir(), 'environment-sync-rehearsal-0123456789abcdef');
  assert.equal(assertDisposableRoot(accepted), path.resolve(accepted));
  assert.throws(
    () => assertDisposableRoot(path.join(os.tmpdir(), 'environment-sync-rehearsal-0123456789abcdef-extra')),
    /DISPOSABLE_POSTGRES_PATH_REJECTED/
  );
  assert.throws(
    () => assertDisposableRoot(os.tmpdir()),
    /DISPOSABLE_POSTGRES_PATH_REJECTED/
  );
});

async function seedSyntheticSupabaseShape(connectionOrClient) {
  const seed = async (client) => {
    await client.query('create schema auth; create schema app; create schema app_api; create schema supabase_migrations');
    await client.query(`
      create table auth.users (
        instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255) unique,
        encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz,
        confirmation_token varchar(255) not null default '', confirmation_sent_at timestamptz,
        recovery_token varchar(255) not null default '', recovery_sent_at timestamptz,
        email_change_token_new varchar(255) not null default '', email_change varchar(255) not null default '',
        email_change_sent_at timestamptz, last_sign_in_at timestamptz,
        raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
        created_at timestamptz not null, updated_at timestamptz not null, phone text,
        phone_confirmed_at timestamptz, phone_change text not null default '',
        phone_change_token varchar(255) not null default '', phone_change_sent_at timestamptz,
        confirmed_at timestamptz, email_change_token_current varchar(255) not null default '',
        email_change_confirm_status smallint not null default 0, banned_until timestamptz,
        reauthentication_token varchar(255) not null default '', reauthentication_sent_at timestamptz,
        is_sso_user boolean not null default false, deleted_at timestamptz,
        is_anonymous boolean not null default false
      );
      create table auth.identities (
        provider_id text not null, user_id uuid not null references auth.users(id), identity_data jsonb not null,
        provider text not null, last_sign_in_at timestamptz, created_at timestamptz,
        updated_at timestamptz, email text, id uuid primary key
      );
    `);
    for (const tableName of CURRENT_AUTH_TABLES.filter((name) => !['users', 'identities'].includes(name))) {
      await client.query(`create table auth."${tableName}" (id text primary key)`);
    }
    await client.query(`
      create table app.organization_members (
        id uuid primary key, user_id uuid not null references auth.users(id), role text not null, status text not null
      );
      create table supabase_migrations.schema_migrations (version text primary key);
      insert into supabase_migrations.schema_migrations(version) values ('20260814210000');
      insert into auth.users(
        instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,
        recovery_token,email_change_token_new,email_change,raw_app_meta_data,raw_user_meta_data,
        created_at,updated_at,phone,phone_change,phone_change_token,email_change_token_current,
        email_change_confirm_status,reauthentication_token,banned_until,is_sso_user,is_anonymous
      ) values (
        '00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','authenticated','authenticated',
        'synthetic@example.test','$2a$10$synthetic','2026-08-16T00:00:00Z','confirmation','recovery','email-new','new@example.test',
        '{"provider":"email","providers":["email"]}','{"display":"Synthetic"}',
        '2026-08-16T00:00:00Z','2026-08-16T00:00:00Z','+15555550100','pending','phone-token','email-current',0,
        'reauth','2026-08-17T00:00:00Z',false,false
      );
      insert into auth.identities(provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at,email,id)
      values ('synthetic@example.test','11111111-1111-1111-1111-111111111111','{"sub":"11111111-1111-1111-1111-111111111111","email":"synthetic@example.test"}',
              'email','2026-08-16T00:00:00Z','2026-08-16T00:00:00Z','2026-08-16T00:00:00Z','synthetic@example.test','22222222-2222-2222-2222-222222222222');
      insert into app.organization_members values ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','admin','active');
      insert into auth.sessions(id) values ('synthetic-session');
      insert into auth.refresh_tokens(id) values ('synthetic-refresh');
      grant select on app.organization_members to authenticated;
    `);
  };
  if (connectionOrClient && typeof connectionOrClient.query === 'function') {
    await seed(connectionOrClient);
    return;
  }
  await withClient(connectionOrClient, seed);
}

class PGliteAdapter {
  constructor(database) {
    this.database = database;
  }

  async query(input, values = []) {
    const text = typeof input === 'string' ? input : input.text;
    const parameters = typeof input === 'string' ? values : input.values || [];
    if (parameters.length === 0 && text.split(';').filter((entry) => entry.trim()).length > 1) {
      const results = await this.database.exec(text);
      const result = results.at(-1) || { rows: [], fields: [], affectedRows: 0 };
      return { ...result, rowCount: result.affectedRows || 0 };
    }
    const result = await this.database.query(text, parameters);
    return { ...result, rowCount: result.affectedRows || 0 };
  }
}

async function seedSyntheticPGlite(database) {
  await database.exec('create role authenticated nologin; create schema extensions; create extension pgcrypto with schema extensions');
  await seedSyntheticSupabaseShape(new PGliteAdapter(database));
}

test('pinned PGlite rehearsal derives two targets from the same encrypted baseline bytes', { timeout: 120_000 }, async () => {
  const source = new PGlite({ extensions: { pgcrypto } });
  let dev;
  let sandbox;
  const key = crypto.randomBytes(32);
  try {
    await source.waitReady;
    await seedSyntheticPGlite(source);
    const sourceClient = new PGliteAdapter(source);
    await sourceClient.query('begin isolation level repeatable read read only');
    const fixedCapture = {
      client: sourceClient,
      target: 'local',
      projectRef: 'synthetic-local',
      capturedAt: '2026-08-16T00:00:00.000Z',
      source: { gitCommit: 'a'.repeat(40) }
    };
    const firstInventory = await captureEnvironmentInventory(fixedCapture);
    const secondInventory = await captureEnvironmentInventory(fixedCapture);
    await sourceClient.query('rollback');
    assert.equal(canonicalDigest(firstInventory), canonicalDigest(secondInventory));
    const baselineBlob = await source.dumpDataDir('gzip');
    const baselineBytes = Buffer.from(await baselineBlob.arrayBuffer());
    const encrypted = encryptBaselineBytes(baselineBytes, key);
    const componentDigest = sha256Bytes(encrypted);
    const devBytes = decryptBaselineBytes(encrypted, key);
    const sandboxBytes = decryptBaselineBytes(encrypted, key);
    assert.equal(sha256Bytes(encrypted), componentDigest);
    assert.deepEqual(devBytes, sandboxBytes);

    dev = new PGlite({ loadDataDir: new Blob([devBytes]), extensions: { pgcrypto } });
    sandbox = new PGlite({ loadDataDir: new Blob([sandboxBytes]), extensions: { pgcrypto } });
    await Promise.all([dev.waitReady, sandbox.waitReady]);
    const transformed = [];
    for (const database of [dev, sandbox]) {
      const client = new PGliteAdapter(database);
      await client.query("set application_name = 'environment-sync-x-rehearsal'");
      await client.query('begin');
      transformed.push(await applyAuthQuarantine(client, { disposableEngine: 'pglite-0.5.4' }));
      await client.query('commit');
    }
    assert.equal(transformed[0].verification.ok, true);
    assert.equal(transformed[1].verification.ok, true);
    assert.deepEqual(transformed[0].counts, transformed[1].counts);
    const summaries = await Promise.all(
      [dev, sandbox].map((database) =>
        database.query(`select
          (select count(*)::integer from auth.users) as users,
          (select count(*)::integer from auth.identities) as identities,
          (select count(*)::integer from auth.sessions) as sessions,
          (select count(*)::integer from auth.refresh_tokens) as refresh_tokens,
          (select count(*)::integer from app.organization_members) as memberships`)
      )
    );
    assert.deepEqual(summaries[0].rows, summaries[1].rows);
    const devEvidence = { database: summaries[0].rows[0], declaredDevPreservationLayer: true };
    const sandboxEvidence = { database: summaries[1].rows[0] };
    assert.equal(
      compareInventoriesWithExceptions(devEvidence, sandboxEvidence, ['/declaredDevPreservationLayer']).ok,
      true
    );
    baselineBytes.fill(0);
    encrypted.fill(0);
    devBytes.fill(0);
    sandboxBytes.fill(0);
  } finally {
    key.fill(0);
    await Promise.all([dev?.close(), sandbox?.close(), source.close()].filter(Boolean));
  }
});

test('streaming dump and restore failures are categorical and leave no partial capture', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-sync-stream-failure-'));
  const artifactPath = path.join(root, 'baseline.enc');
  const connectionString = 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic?sslmode=disable';
  const key = crypto.randomBytes(32);
  const plain = Buffer.from('not-a-postgres-archive', 'utf8');
  let encrypted;
  try {
    await assert.rejects(
      captureEncryptedPgDump({
        pgDumpPath: process.execPath,
        connectionString,
        snapshotId: 'synthetic-snapshot',
        artifactPath
      }),
      (error) => error?.code === 'BASELINE_PG_DUMP_FAILED'
    );
    assert.equal(fs.existsSync(artifactPath), false);

    encrypted = encryptBaselineBytes(plain, key);
    writePrivateBytesExclusive(artifactPath, encrypted);
    await assert.rejects(
      restoreEncryptedPgDump({
        pgRestorePath: process.execPath,
        connectionString,
        artifactPath,
        key
      }),
      (error) => error?.code === 'BASELINE_PG_RESTORE_FAILED'
    );
    assert.equal(fs.existsSync(artifactPath), true);
  } finally {
    key.fill(0);
    plain.fill(0);
    encrypted?.fill(0);
    const resolved = path.resolve(root);
    assert.equal(resolved.startsWith(path.resolve(os.tmpdir())), true);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('one encrypted local baseline feeds two independently restored and quarantined targets', { timeout: 240_000 }, async (t) => {
  try {
    resolvePostgresTools();
  } catch {
    t.skip('PostgreSQL 18 tooling is unavailable.');
    return;
  }
  const token = crypto.randomBytes(6).toString('hex');
  const sourceRoot = path.join(os.tmpdir(), `environment-sync-rehearsal-source-${token}`);
  let sourceCluster;
  let completed = false;
  try {
    sourceCluster = await startDisposablePostgres({ rootDirectory: sourceRoot });
    const sourceConnection = await prepareRestoreDatabase(sourceCluster, `x_rehearsal_dev_source_${token}`);
    await seedSyntheticSupabaseShape(sourceConnection);
    const result = await runGoldenBaselineRehearsal({
      prodConnectionString: sourceConnection,
      prodProjectRef: 'synthetic-prod-ref',
      source: {
        gitCommit: 'a'.repeat(40),
        management: {
          available: true,
          project: { status: 'ACTIVE_HEALTHY', region: 'us-west-2' },
          edge: {
            deployments: [{ slug: 'api', version: 279, status: 'ACTIVE', verifyJwt: false }]
          }
        },
        edgeHealth: {
          available: true,
          status: 'ok',
          buildSha: '647ecc8611a2283ac3d77a56d1103a03b4ad268d'
        },
        edgeIdentity: {
          source: 'synthetic-test-source',
          graphDigest: digest('graph'),
          lockDigest: digest('lock')
        }
      }
    });
    assert.equal(result.classification, 'X_REHEARSAL_PASSED');
    assert.equal(result.restores, 2);
    assert.equal(result.transforms.dev.verification.ok, true);
    assert.equal(result.transforms.sandbox.verification.ok, true);
    assert.equal(result.transforms.dev.verification.sessionAndTokenCounts.sessions, 0);
    assert.equal(result.parity.ok, true);
    assert.equal(result.directGrantParity, true);
    completed = true;
  } finally {
    if (sourceCluster) await removeDisposablePostgres(sourceCluster);
    if (completed) assert.equal(fs.existsSync(sourceRoot), false);
  }
});
