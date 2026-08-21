import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import { applyAuthQuarantine, createTargetNativeSmokeIdentity } from './auth-quarantine.mjs';
import { EXPECTED_PROD_EDGE } from './constants.mjs';
import {
  prepareRestoreDatabase,
  removeDisposablePostgres,
  startDisposablePostgres,
  withClient
} from './disposable-postgres.mjs';
import {
  captureEncryptedPgDump,
  readWrappedBaselineDataKey,
  restoreEncryptedPgDump,
  verifyEncryptedComponent,
  writeWrappedBaselineDataKey
} from './encrypted-baseline.mjs';
import { captureEnvironmentInventory } from './inventory.mjs';
import {
  authenticateManifest,
  buildBaselineManifest,
  buildDerivedManifest,
  compareInventoriesWithExceptions,
  verifyAuthenticatedManifest
} from './manifest.mjs';
import { verifySideEffectQuarantine } from './side-effect-quarantine.mjs';

const { Client } = pg;

function rehearsalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function existingCategoricalCode(error) {
  const code = String(error?.code || error?.message || '');
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : '';
}

function assertProdSourcePlatform(management = {}, edgeHealth = {}) {
  const api = (management.edge?.deployments || []).find(
    (entry) => entry.slug === EXPECTED_PROD_EDGE.slug
  );
  const matches =
    management.available === true &&
    management.project?.status === EXPECTED_PROD_EDGE.projectStatus &&
    management.project?.region === EXPECTED_PROD_EDGE.region &&
    api?.version === EXPECTED_PROD_EDGE.version &&
    api?.status === EXPECTED_PROD_EDGE.status &&
    api?.verifyJwt === EXPECTED_PROD_EDGE.verifyJwt &&
    edgeHealth.available === true &&
    edgeHealth.status === EXPECTED_PROD_EDGE.healthStatus &&
    edgeHealth.buildSha === EXPECTED_PROD_EDGE.buildSha;
  if (!matches) throw rehearsalError('PROD_SOURCE_PLATFORM_DRIFT');
  return true;
}

async function sourceSnapshot({ connectionString, target, projectRef, source, captureDump }) {
  const client = new Client({ connectionString, application_name: 'environment-sync-prod-readonly' });
  let began = false;
  try {
    await client.connect();
    await client.query('begin isolation level repeatable read read only');
    began = true;
    await client.query("set local time zone 'UTC'");
    const proof = await client.query(
      `select current_setting('transaction_read_only') as read_only,
              current_setting('transaction_isolation') as isolation`
    );
    if (proof.rows[0]?.read_only !== 'on' || proof.rows[0]?.isolation !== 'repeatable read') {
      throw rehearsalError('SOURCE_SNAPSHOT_NOT_READ_ONLY');
    }
    const snapshot = await client.query('select pg_catalog.pg_export_snapshot() as snapshot_id');
    const capturedAt = new Date().toISOString();
    const inventory = await captureEnvironmentInventory({
      client,
      target,
      projectRef,
      source,
      envValues: source.envValues,
      management: source.management,
      edgeHealth: source.edgeHealth,
      capturedAt
    });
    const directAppGrants = await directAppGrantSummaryFromClient(client);
    const applicationGrants = await captureApplicationGrantSemanticsFromClient(client);
    const constraintSemantics = await captureConstraintSemanticsFromClient(client);
    const dump = await captureDump(snapshot.rows[0]?.snapshot_id);
    await client.query('rollback');
    began = false;
    return {
      capturedAt,
      inventory,
      directAppGrants,
      applicationGrants,
      constraintSemantics,
      dump,
      rollback: true
    };
  } finally {
    if (began) {
      try { await client.query('rollback'); } catch {}
    }
    await client.end().catch(() => {});
  }
}

async function applyTransform(connectionString, smokeProfile) {
  return withClient(
    connectionString,
    async (client) => {
      await client.query('begin');
      try {
        const result = await applyAuthQuarantine(client);
        const nativeSmokeIdentity = await createTargetNativeSmokeIdentity(client, smokeProfile);
        await client.query('commit');
        return { ...result, nativeSmokeIdentity };
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    },
    { application_name: 'environment-sync-x-rehearsal' }
  );
}

async function captureLocalInventory(connectionString, target, projectRef, capturedAt, source) {
  return withClient(
    connectionString,
    async (client) => {
      await client.query('begin isolation level repeatable read read only');
      try {
        await client.query("set local time zone 'UTC'");
        const inventory = await captureEnvironmentInventory({
          client,
          target,
          projectRef,
          source,
          capturedAt
        });
        await client.query('rollback');
        return inventory;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    },
    { application_name: 'environment-sync-x-rehearsal' }
  );
}

async function directAppGrantSummary(connectionString) {
  return withClient(connectionString, directAppGrantSummaryFromClient);
}

async function directAppGrantSummaryFromClient(client) {
  const result = await client.query(
    `select table_schema, table_name, grantee, privilege_type, is_grantable
       from information_schema.role_table_grants
      where table_schema = 'app' and grantee in ('anon', 'authenticated', 'service_role')
      order by table_schema, table_name, grantee, privilege_type`
  );
  return {
    count: result.rows.length,
    authenticatedSelectCount: result.rows.filter(
      (row) => row.grantee === 'authenticated' && row.privilege_type === 'SELECT'
    ).length,
    digest: canonicalDigest(result.rows)
  };
}

async function captureApplicationGrantSemanticsFromClient(client) {
  const result = await client.query(
    `select 'table'::text as object_type, table_schema as schema_name, table_name as object_name,
            grantee, privilege_type, is_grantable
       from information_schema.role_table_grants
      where table_schema = any($1::text[])
      union all
     select 'routine'::text, routine_schema, routine_name, grantee, privilege_type, is_grantable
       from information_schema.role_routine_grants
      where routine_schema = any($1::text[])
      order by object_type, schema_name, object_name, grantee, privilege_type`,
    [['app', 'app_api', 'public']]
  );
  return result.rows;
}

async function captureApplicationGrantSemantics(connectionString) {
  return withClient(connectionString, captureApplicationGrantSemanticsFromClient);
}

async function captureConstraintSemanticsFromClient(client) {
  const result = await client.query(
    `select n.nspname as schema_name,
            c.relname as table_name,
            con.conname as constraint_name,
            con.contype,
            con.condeferrable,
            con.condeferred,
            con.convalidated,
            con.connoinherit,
            con.conislocal,
            con.confupdtype,
            con.confdeltype,
            con.confmatchtype,
            coalesce(ref_n.nspname, '') as referenced_schema,
            coalesce(ref_c.relname, '') as referenced_table,
            coalesce(pg_catalog.pg_get_expr(con.conbin, con.conrelid, false), '') as check_expression,
            coalesce((
              select pg_catalog.jsonb_agg(a.attname::text order by source.position)
                from unnest(con.conkey) with ordinality source(attnum, position)
                join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = source.attnum
            ), '[]'::jsonb) as source_columns,
            coalesce((
              select pg_catalog.jsonb_agg(a.attname::text order by target.position)
                from unnest(con.confkey) with ordinality target(attnum, position)
                join pg_catalog.pg_attribute a on a.attrelid = con.confrelid and a.attnum = target.attnum
            ), '[]'::jsonb) as referenced_columns,
            coalesce((
              select pg_catalog.jsonb_agg(
                       pg_catalog.format('%I.%I', op_n.nspname, op.oprname)
                       order by exclusion.position
                     )
                from unnest(con.conexclop) with ordinality exclusion(operator_oid, position)
                join pg_catalog.pg_operator op on op.oid = exclusion.operator_oid
                join pg_catalog.pg_namespace op_n on op_n.oid = op.oprnamespace
            ), '[]'::jsonb) as exclusion_operators
       from pg_catalog.pg_constraint con
       join pg_catalog.pg_class c on c.oid = con.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join pg_catalog.pg_class ref_c on ref_c.oid = con.confrelid
      left join pg_catalog.pg_namespace ref_n on ref_n.oid = ref_c.relnamespace
      where n.nspname = any($1::text[])
        and con.contype <> 'n'
      order by n.nspname, c.relname, con.conname`,
    [['app', 'app_api', 'public']]
  );
  return result.rows;
}

async function captureConstraintSemantics(connectionString) {
  return withClient(connectionString, captureConstraintSemanticsFromClient);
}

function sameCanonicalValue(left, right) {
  return canonicalDigest([left]) === canonicalDigest([right]);
}

function compareNamedFingerprints(leftRows = [], rightRows = []) {
  const left = new Map(leftRows.map((row) => [row.name, row]));
  const right = new Map(rightRows.map((row) => [row.name, row]));
  return Array.from(new Set([...left.keys(), ...right.keys()]))
    .sort()
    .flatMap((name) => {
      const source = left.get(name);
      const restored = right.get(name);
      if (!source || !restored) return [{ name, category: 'presence' }];
      if (source.rowCount !== restored.rowCount) return [{ name, category: 'count' }];
      if (source.fingerprint !== restored.fingerprint) return [{ name, category: 'fingerprint' }];
      return [];
    });
}

function compareConstraintSemantics(leftRows = [], rightRows = []) {
  const key = (row) => `${row.schema_name}.${row.table_name}.${row.constraint_name}`;
  const left = new Map(leftRows.map((row) => [key(row), row]));
  const right = new Map(rightRows.map((row) => [key(row), row]));
  return Array.from(new Set([...left.keys(), ...right.keys()]))
    .sort()
    .flatMap((name) => {
      const source = left.get(name);
      const restored = right.get(name);
      if (!source || !restored) {
        return [{
          name,
          fields: ['presence'],
          category: source ? 'missing_restored' : 'extra_restored'
        }];
      }
      const fields = Array.from(new Set([...Object.keys(source), ...Object.keys(restored)]))
        .sort()
        .filter((field) => !sameCanonicalValue(source[field], restored[field]));
      return fields.length > 0 ? [{ name, fields }] : [];
    });
}

function compareNativeRestoreToSource(
  sourceInventory,
  restoredInventory,
  sourceGrants,
  restoredGrants,
  sourceApplicationGrants,
  restoredApplicationGrants,
  sourceConstraints,
  restoredConstraints
) {
  const protectedDataMismatches = compareNamedFingerprints(
    sourceInventory.protectedData.tables,
    restoredInventory.protectedData.tables
  );
  const constraintMismatches = compareConstraintSemantics(sourceConstraints, restoredConstraints);
  const exactSections = {
    migration: sameCanonicalValue(sourceInventory.migration, restoredInventory.migration),
    protectedSchema: sameCanonicalValue(sourceInventory.protectedSchema, restoredInventory.protectedSchema),
    protectedData: protectedDataMismatches.length === 0,
    relations: sameCanonicalValue(sourceInventory.catalog.relations, restoredInventory.catalog.relations),
    columns: sameCanonicalValue(sourceInventory.catalog.columns, restoredInventory.catalog.columns),
    routines: sameCanonicalValue(sourceInventory.catalog.routines, restoredInventory.catalog.routines),
    triggers: sameCanonicalValue(sourceInventory.catalog.triggers, restoredInventory.catalog.triggers),
    constraints: constraintMismatches.length === 0,
    indexes: sameCanonicalValue(sourceInventory.catalog.indexes, restoredInventory.catalog.indexes),
    policies: sameCanonicalValue(sourceInventory.catalog.policies, restoredInventory.catalog.policies),
    sequences: sameCanonicalValue(sourceInventory.catalog.sequences, restoredInventory.catalog.sequences),
    authTopology: sameCanonicalValue(sourceInventory.authTopology, restoredInventory.authTopology),
    applicationGrants: sameCanonicalValue(sourceApplicationGrants, restoredApplicationGrants),
    directAppGrants: sameCanonicalValue(sourceGrants, restoredGrants)
  };
  const requiredExtensionAvailable = restoredInventory.catalog.extensions.names.includes('pgcrypto');
  const failedSections = Object.entries(exactSections)
    .filter(([, matches]) => !matches)
    .map(([name]) => name);
  return {
    ok: failedSections.length === 0 && requiredExtensionAvailable,
    exactSections,
    failedSections,
    protectedDataMismatches,
    constraintMismatches,
    requiredExtensionAvailable,
    semanticConstraintCount: restoredConstraints.length,
    managedSupabaseDifferences: [
      'auth_http_services',
      'database_side_effect_runtime',
      'managed_extension_availability',
      'managed_platform_metadata',
      'managed_secrets',
      'nonselected_managed_schemas',
      'postgres18_not_null_constraint_catalog',
      'postgres_server_major',
      'server_role_login_attributes'
    ]
  };
}

function assertNativeRestoreCompatibility(result, target) {
  if (result.ok) return;
  if (result.protectedDataMismatches.length > 0) {
    const mismatch = result.protectedDataMismatches[0];
    const name = mismatch.name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
    throw rehearsalError(
      `NATIVE_${target.toUpperCase()}_RESTORE_${name}_${mismatch.category.toUpperCase()}_MISMATCH`
    );
  }
  if (result.constraintMismatches.length > 0) {
    const mismatch = result.constraintMismatches[0];
    const field = mismatch.fields[0]
      .replace(/[^A-Za-z0-9]+/g, '_')
      .toUpperCase();
    const name = mismatch.name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase().slice(0, 32);
    const category = String(mismatch.category || 'changed').toUpperCase();
    throw rehearsalError(
      `NATIVE_${target.toUpperCase()}_CONSTRAINT_${category}_${field}_${name}`.slice(0, 80)
    );
  }
  const suffix = result.failedSections[0]
    ? result.failedSections[0].replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
    : 'REQUIRED_EXTENSION';
  throw rehearsalError(`NATIVE_${target.toUpperCase()}_RESTORE_${suffix}_MISMATCH`);
}

function localSideEffectPolicy(target) {
  return {
    version: 'nonprod-side-effect-policy-v1',
    target,
    authEmailMode: 'disabled',
    smsMode: 'disabled',
    edgeSecretsTargetLocal: true,
    frontendProductionAliasAbsent: true,
    nonprodUrlsVerified: true,
    storageBehaviorReviewed: true,
    databaseNetworkExtensionsDisabled: false,
    allowedSecretNames: []
  };
}

async function runGoldenBaselineRehearsal({
  prodConnectionString,
  prodProjectRef,
  source,
  postgresBin,
  temporaryParent = os.tmpdir()
} = {}) {
  assertProdSourcePlatform(source?.management, source?.edgeHealth);
  const runToken = crypto.randomBytes(8).toString('hex');
  const root = path.join(temporaryParent, `environment-sync-rehearsal-${runToken}`);
  let cluster;
  let wrappingKey;
  let teardown = false;
  let stage = 'STARTUP';
  const artifactPath = path.join(root, 'golden-x-rehearsal.pgdump.enc');
  const wrappedKeyPath = path.join(root, 'golden-x-rehearsal.key.enc');
  try {
    stage = 'DISPOSABLE_POSTGRES_START';
    cluster = await startDisposablePostgres({ rootDirectory: root, postgresBin });
    stage = 'SOURCE_SNAPSHOT';
    const snapshot = await sourceSnapshot({
      connectionString: prodConnectionString,
      target: 'prod',
      projectRef: prodProjectRef,
      source,
      captureDump: (snapshotId) =>
        captureEncryptedPgDump({
          pgDumpPath: cluster.tools.pgDump,
          connectionString: prodConnectionString,
          snapshotId,
          artifactPath
        })
    });
    if (!verifyEncryptedComponent(snapshot.dump.component, artifactPath)) {
      throw rehearsalError('BASELINE_COMPONENT_INTEGRITY_FAILED');
    }
    stage = 'BASELINE_KEY_WRAP';
    wrappingKey = crypto.randomBytes(32);
    let wrappedKey;
    try {
      wrappedKey = writeWrappedBaselineDataKey({
        dataKey: snapshot.dump.key,
        wrappingKey,
        artifactPath: wrappedKeyPath
      });
    } finally {
      snapshot.dump.key.fill(0);
      snapshot.dump.key = undefined;
    }
    if (!verifyEncryptedComponent(wrappedKey.component, wrappedKeyPath)) {
      throw rehearsalError('BASELINE_WRAPPED_KEY_INTEGRITY_FAILED');
    }
    const suffix = runToken.slice(0, 8);
    const devName = `x_rehearsal_dev_${suffix}`;
    const sandboxName = `x_rehearsal_sandbox_${suffix}`;
    stage = 'RESTORE_DATABASE_PREPARE';
    const devConnection = await prepareRestoreDatabase(cluster, devName);
    const sandboxConnection = await prepareRestoreDatabase(cluster, sandboxName);

    stage = 'DEV_RESTORE';
    let restoreKey = readWrappedBaselineDataKey({ wrappingKey, artifactPath: wrappedKeyPath });
    try {
      await restoreEncryptedPgDump({
        pgRestorePath: cluster.tools.pgRestore,
        connectionString: devConnection,
        artifactPath,
        key: restoreKey
      });
    } finally {
      restoreKey.fill(0);
      restoreKey = undefined;
    }
    if (!verifyEncryptedComponent(snapshot.dump.component, artifactPath)) {
      throw rehearsalError('BASELINE_COMPONENT_INTEGRITY_FAILED');
    }
    stage = 'SANDBOX_RESTORE';
    restoreKey = readWrappedBaselineDataKey({ wrappingKey, artifactPath: wrappedKeyPath });
    try {
      await restoreEncryptedPgDump({
        pgRestorePath: cluster.tools.pgRestore,
        connectionString: sandboxConnection,
        artifactPath,
        key: restoreKey
      });
    } finally {
      restoreKey.fill(0);
      restoreKey = undefined;
    }

    stage = 'RESTORED_GRANT_CAPTURE';
    const grantsBefore = [
      await directAppGrantSummary(devConnection),
      await directAppGrantSummary(sandboxConnection)
    ];
    if (JSON.stringify(grantsBefore[0]) !== JSON.stringify(grantsBefore[1])) {
      throw rehearsalError('RESTORED_GRANT_PARITY_FAILED');
    }

    stage = 'NATIVE_RESTORE_VALIDATION';
    const restoredDevInventory = await captureLocalInventory(
      devConnection,
      'dev',
      'mock-dev-target',
      snapshot.capturedAt,
      source
    );
    const restoredSandboxInventory = await captureLocalInventory(
      sandboxConnection,
      'sandbox',
      'mock-sandbox-target',
      snapshot.capturedAt,
      source
    );
    const restoredDevConstraints = await captureConstraintSemantics(devConnection);
    const restoredSandboxConstraints = await captureConstraintSemantics(sandboxConnection);
    const restoredDevApplicationGrants = await captureApplicationGrantSemantics(devConnection);
    const restoredSandboxApplicationGrants = await captureApplicationGrantSemantics(sandboxConnection);
    const nativeRestoreCompatibility = {
      dev: compareNativeRestoreToSource(
        snapshot.inventory,
        restoredDevInventory,
        snapshot.directAppGrants,
        grantsBefore[0],
        snapshot.applicationGrants,
        restoredDevApplicationGrants,
        snapshot.constraintSemantics,
        restoredDevConstraints
      ),
      sandbox: compareNativeRestoreToSource(
        snapshot.inventory,
        restoredSandboxInventory,
        snapshot.directAppGrants,
        grantsBefore[1],
        snapshot.applicationGrants,
        restoredSandboxApplicationGrants,
        snapshot.constraintSemantics,
        restoredSandboxConstraints
      )
    };
    assertNativeRestoreCompatibility(nativeRestoreCompatibility.dev, 'dev');
    assertNativeRestoreCompatibility(nativeRestoreCompatibility.sandbox, 'sandbox');

    stage = 'AUTH_QUARANTINE';
    const smokeProfile = {
      userId: crypto.randomUUID(),
      identityId: crypto.randomUUID(),
      email: `smoke-${crypto.randomBytes(20).toString('hex')}@users.invalid`,
      structuralIdentitySharedForParity: true,
      lifecycleTimestamp: new Date().toISOString()
    };
    const devTransform = await applyTransform(devConnection, smokeProfile);
    const sandboxTransform = await applyTransform(sandboxConnection, smokeProfile);
    const commonCapturedAt = new Date().toISOString();
    stage = 'DERIVED_INVENTORY';
    const devInventory = await captureLocalInventory(
      devConnection,
      'dev',
      'mock-dev-target',
      commonCapturedAt,
      source
    );
    const sandboxInventory = await captureLocalInventory(
      sandboxConnection,
      'sandbox',
      'mock-sandbox-target',
      commonCapturedAt,
      source
    );
    devInventory.declaredDevPreservationLayer = 'smoke-identity-and-target-settings-recreated';
    stage = 'SIDE_EFFECT_VERIFICATION';
    const sideEffects = {
      dev: verifySideEffectQuarantine({ inventory: devInventory, policy: localSideEffectPolicy('dev') }),
      sandbox: verifySideEffectQuarantine({ inventory: sandboxInventory, policy: localSideEffectPolicy('sandbox') })
    };
    if (!sideEffects.dev.ok || !sideEffects.sandbox.ok) {
      throw rehearsalError('SIDE_EFFECT_QUARANTINE_REHEARSAL_FAILED');
    }

    const exceptions = [
      '/declaredDevPreservationLayer',
      '/target/environment',
      '/target/projectRef'
    ];
    stage = 'DERIVED_PARITY';
    const parity = compareInventoriesWithExceptions(devInventory, sandboxInventory, exceptions);
    if (!parity.ok) throw rehearsalError('DERIVED_TARGET_PARITY_FAILED');

    stage = 'MANIFEST_AUTHENTICATION';
    const manifestKey = crypto.randomBytes(32);
    try {
      const baseline = authenticateManifest(
        buildBaselineManifest({
          baselineId: `x-rehearsal-${runToken}`,
          sourceSnapshotTimestamp: snapshot.capturedAt,
          sourceCommit: source.gitCommit,
          inventory: snapshot.inventory,
          components: [snapshot.dump.component, wrappedKey.component],
          edgeIdentity: source.edgeIdentity,
          platformClassifications: {
            rehearsal: true,
            project: snapshot.inventory.platform.project,
            auth: snapshot.inventory.platform.auth,
            secrets: snapshot.inventory.platform.secrets,
            managementAvailable: snapshot.inventory.platform.managementAvailable,
            edge: snapshot.inventory.edge
          },
          sideEffectInventory: snapshot.inventory.sideEffects,
          allowedExceptions: exceptions
        }),
        manifestKey
      );
      const derivedDev = authenticateManifest(
        buildDerivedManifest({
          baselineManifest: baseline,
          target: devInventory.target,
          transform: { id: 'x-np', version: devTransform.version },
          inventory: devInventory,
          allowedExceptions: exceptions
        }),
        manifestKey
      );
      const derivedSandbox = authenticateManifest(
        buildDerivedManifest({
          baselineManifest: baseline,
          target: sandboxInventory.target,
          transform: { id: 'x-np', version: sandboxTransform.version },
          inventory: sandboxInventory,
          allowedExceptions: exceptions
        }),
        manifestKey
      );
      verifyAuthenticatedManifest(baseline, manifestKey);
      verifyAuthenticatedManifest(derivedDev, manifestKey);
      verifyAuthenticatedManifest(derivedSandbox, manifestKey);
    } finally {
      manifestKey.fill(0);
    }

    stage = 'COMPLETE';
    return {
      classification: 'X_REHEARSAL_PASSED',
      source: {
        readOnly: true,
        rollback: snapshot.rollback,
        migrationCount: snapshot.inventory.migration.count,
        migrationTip: snapshot.inventory.migration.tip
      },
      component: snapshot.dump.component,
      wrappedKey,
      restores: 2,
      transforms: {
        dev: devTransform,
        sandbox: sandboxTransform
      },
      directGrantParity: true,
      nativeRestoreCompatibility,
      sideEffects,
      parity: {
        ok: parity.ok,
        declaredDifferenceCount: parity.changed.length,
        exceptions
      },
      manifestsAuthenticated: true
    };
  } catch (error) {
    const code = existingCategoricalCode(error);
    if (code) throw error;
    throw rehearsalError(`X_REHEARSAL_${stage}_FAILED`);
  } finally {
    if (wrappingKey) wrappingKey.fill(0);
    if (cluster) {
      await removeDisposablePostgres(cluster);
      teardown = !fs.existsSync(root);
    }
    if (cluster && !teardown) throw rehearsalError('REHEARSAL_TEARDOWN_FAILED');
  }
}

export { assertProdSourcePlatform, runGoldenBaselineRehearsal };
