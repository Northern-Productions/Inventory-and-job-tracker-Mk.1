#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import pg from 'pg';

import { assertManagedNonprodTarget } from './lib/environment-sync/auth-quarantine.mjs';
import {
  RECOVERY_ATTEMPT_FORMAT,
  RECOVERY_OVERRIDE_ATTEMPT_FORMAT,
  RECOVERY_OVERRIDE_RESULT_FORMAT,
  RECOVERY_PLAN_FORMAT,
  RECOVERY_RESULT_FORMAT,
  assertPlanMatchesAuthority,
  buildFixtureRecoveryPlan,
  buildRecoveryAttempt,
  buildRecoveryResult,
  buildSignedRuntimeRecord,
  captureAuthState,
  captureBoxTransferGuard,
  captureFixtureState,
  captureIdentityReferences,
  captureOwnerGuard,
  captureOwnerInvariant,
  captureProtectionFingerprint,
  captureRecoveryPreconditions,
  captureSideEffectState,
  executeFixtureRecoveryTransaction,
  extractBoxTransferGuardFunctionSource,
  extractOwnerGuardFunctionSource,
  readRuntimeRecoveryAuthority,
  readSignedRuntimeRecord,
  selectFixtureRecoveryMode,
  runtimeCanonicalSerialize
} from './lib/environment-sync/fixture-recovery.mjs';
import {
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  writePrivateJsonExclusive
} from './lib/environment-sync/private-artifacts.mjs';
import { DEV_PROJECT_REF, PROD_PROJECT_REF } from './lib/target-env-guards.mjs';

const { Client } = pg;
const APPLICATION_NAME = 'environment-sync-x-np-managed';
const FILES = Object.freeze({
  manifest: 'golden-workflow-fixture.private.json',
  failure: 'golden-workflow-failure.private.json',
  recovery: 'golden-workflow-recovery.private.json',
  lineage: 'sandbox-runtime-lineage.private.json',
  journal: 'golden-workflow-ids.private.jsonl',
  plan: 'fixture-recovery-plan.private.json',
  attempt: 'fixture-recovery-attempt.private.json',
  result: 'fixture-recovery-result.private.json',
  overrideAttempt: 'fixture-recovery-override-attempt.private.json',
  overrideResult: 'fixture-recovery-override-result.private.json'
});

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function text(value) {
  return String(value ?? '').trim();
}

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw categoricalError('FIXTURE_RECOVERY_ARGUMENT_INVALID');
    const [name, inline] = token.slice(2).split('=', 2);
    if (!name) throw categoricalError('FIXTURE_RECOVERY_ARGUMENT_INVALID');
    if (inline !== undefined) {
      options[name] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[name] = true;
      continue;
    }
    options[name] = next;
    index += 1;
  }
  return options;
}

function booleanOption(value) {
  return value === true || ['true', '1', 'yes'].includes(text(value).toLowerCase());
}

function requiredOption(options, name) {
  const value = text(options[name]);
  if (!value) throw categoricalError('FIXTURE_RECOVERY_ARGUMENT_MISSING');
  return value;
}

function printUsage() {
  console.log(`Usage:
  npm --prefix backend run env:sandbox:fixture-recovery -- --action prepare \\
    --expected-project-ref <sandbox-ref> --expected-application-commit <commit> \\
    --authority-dir <private-dir> --authority-key <private-key> \\
    --project-artifact <private-project-json> --database-password-artifact <private-password>

  npm --prefix backend run env:sandbox:fixture-recovery -- --action cleanup --apply \\
    --quiet-window-active --expected-project-ref <sandbox-ref> \\
    --expected-application-commit <commit> --authority-dir <private-dir> \\
    --authority-key <private-key> --project-artifact <private-project-json> \\
    --database-password-artifact <private-password>

  Recovery-only action: --action recover-film-order-history --apply --quiet-window-active
    --confirmed-failure-constraint film_order_events_org_id_fkey (plus the same private inputs).

  Recovery-only action: --action recover-transfer-history --apply --quiet-window-active
    --confirmed-failure-routine guard_box_transfer_mutation (plus the same private inputs).

This command is SANDBOX-only. Preparation writes an authenticated private plan after a
rolled-back read-only snapshot. Cleanup is permanent and one-shot after its private attempt
marker is published. The Film Order recovery action requires the authenticated failed marker,
uses a separate one-shot marker, and never accepts discovered cleanup roots. Transfer-history
recovery has the same one-shot authority and suspends only the exact immutable-history trigger.`);
}

function resolveFiles(directoryPath) {
  return Object.fromEntries(
    Object.entries(FILES).map(([key, name]) => [key, privateArtifactPath(directoryPath, name)])
  );
}

function assertAbsent(filePath, code) {
  if (fs.existsSync(filePath)) throw categoricalError(code);
}

function readProjectAndConnection({ projectArtifactPath, passwordArtifactPath, expectedProjectRef }) {
  verifyPrivateArtifactProtection(projectArtifactPath);
  verifyPrivateArtifactProtection(passwordArtifactPath);
  const projectBytes = fs.readFileSync(projectArtifactPath);
  const passwordBytes = fs.readFileSync(passwordArtifactPath);
  let password = '';
  try {
    const project = JSON.parse(projectBytes.toString('utf8'));
    const projectRef = text(expectedProjectRef).toLowerCase();
    if (
      !/^[a-z0-9]{10,40}$/.test(projectRef) ||
      [DEV_PROJECT_REF, PROD_PROJECT_REF].includes(projectRef) ||
      text(project?.ref).toLowerCase() !== projectRef ||
      text(project?.database?.host).toLowerCase() !== `db.${projectRef}.supabase.co`
    ) {
      throw categoricalError('FIXTURE_RECOVERY_TARGET_GUARD_FAILED');
    }
    password = passwordBytes.toString('utf8').trim();
    if (!password) throw categoricalError('FIXTURE_RECOVERY_DATABASE_CREDENTIAL_UNAVAILABLE');
    return {
      projectRef,
      connectionString: `postgresql://postgres:${encodeURIComponent(password)}@db.${projectRef}.supabase.co:5432/postgres`
    };
  } catch (error) {
    if (error?.code) throw error;
    throw categoricalError('FIXTURE_RECOVERY_PROJECT_ARTIFACT_INVALID');
  } finally {
    password = '';
    projectBytes.fill(0);
    passwordBytes.fill(0);
  }
}

function createClient(connectionString) {
  return new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    application_name: APPLICATION_NAME
  });
}

async function guardConnectedSandbox(client, projectRef) {
  return assertManagedNonprodTarget(client, {
    managedNonprodTarget: 'sandbox',
    envValues: {
      SANDBOX_SUPABASE_PROJECT_REF: projectRef,
      SANDBOX_DATABASE_URL: client.connectionParameters?.connectionString ||
        `postgresql://postgres:guarded@db.${projectRef}.supabase.co:5432/postgres`
    },
    sandboxRef: projectRef
  });
}

async function withReadOnlySnapshot(client, callback) {
  let begun = false;
  let rolledBack = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    begun = true;
    const mode = await client.query('SHOW transaction_read_only');
    if (text(mode.rows[0]?.transaction_read_only).toLowerCase() !== 'on') {
      throw categoricalError('FIXTURE_RECOVERY_READ_ONLY_UNPROVEN');
    }
    const result = await callback();
    await client.query('ROLLBACK');
    rolledBack = true;
    return result;
  } finally {
    if (begun && !rolledBack) {
      try {
        await client.query('ROLLBACK');
      } catch {
        throw categoricalError('FIXTURE_RECOVERY_READ_ONLY_ROLLBACK_UNPROVEN');
      }
    }
  }
}

function loadAuthority(options, files) {
  return readRuntimeRecoveryAuthority({
    directoryPath: requiredOption(options, 'authority-dir'),
    keyPath: requiredOption(options, 'authority-key'),
    manifestPath: files.manifest,
    failurePath: files.failure,
    recoveryPath: files.recovery,
    lineagePath: files.lineage,
    journalPath: files.journal,
    expectedProjectRef: requiredOption(options, 'expected-project-ref'),
    expectedApplicationCommit: requiredOption(options, 'expected-application-commit')
  });
}

function loadOwnerGuardSource(options) {
  const override = text(options['owner-guard-migration']);
  const migrationPath = override
    ? path.resolve(override)
    : new URL('../migrations/0184_team_user_invite_management.sql', import.meta.url);
  const bytes = fs.readFileSync(migrationPath);
  try {
    return extractOwnerGuardFunctionSource(bytes.toString('utf8'));
  } finally {
    bytes.fill(0);
  }
}

function loadBoxTransferGuardSource(options) {
  const override = text(options['box-transfer-guard-migration']);
  const migrationPath = override
    ? path.resolve(override)
    : new URL('../migrations/0191_atomic_cross_warehouse_transfer_assisted_allocation.sql', import.meta.url);
  const bytes = fs.readFileSync(migrationPath);
  try {
    return extractBoxTransferGuardFunctionSource(bytes.toString('utf8'));
  } finally {
    bytes.fill(0);
  }
}

async function prepare(options, context) {
  const { files, authority, ownerGuardSource, client, applicationCommit } = context;
  assertAbsent(files.plan, 'FIXTURE_RECOVERY_PLAN_ALREADY_EXISTS');
  assertAbsent(files.attempt, 'FIXTURE_RECOVERY_NAMESPACE_FROZEN');
  assertAbsent(files.result, 'FIXTURE_RECOVERY_NAMESPACE_FROZEN');
  const evidence = await withReadOnlySnapshot(client, () =>
    captureRecoveryPreconditions(client, authority, ownerGuardSource)
  );
  const plan = buildFixtureRecoveryPlan({
    authority,
    ...evidence,
    expectedApplicationCommit: applicationCommit
  });
  writePrivateJsonExclusive(files.plan, buildSignedRuntimeRecord(plan, authority.key));
  console.log(
    JSON.stringify({
      result: 'SANDBOX_FIXTURE_RECOVERY_PREPARED',
      target: 'sandbox',
      readOnlySnapshot: true,
      rolledBack: true,
      fixtureRows: plan.expected.fixtureRows,
      fixtureTables: Object.keys(plan.expected.fixtureCounts).length,
      applicationTablesEqual: plan.expected.applicationTables,
      nonfixtureEqual: true,
      ownerGuardCertified: true,
      protectedStateBound: true,
      oneShotCleanupReady: true
    })
  );
}

async function managementRead(projectRef, pathname) {
  const token = text(process.env.SUPABASE_ACCESS_TOKEN);
  if (!token) throw categoricalError('FIXTURE_RECOVERY_MANAGEMENT_TOKEN_UNAVAILABLE');
  const response = await fetch(`https://api.supabase.com${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw categoricalError('FIXTURE_RECOVERY_MANAGEMENT_READ_FAILED');
  const value = await response.json();
  if (pathname === `/v1/projects/${projectRef}`) {
    const returnedRef = text(value?.ref || value?.id).toLowerCase();
    if (returnedRef !== projectRef || !['ACTIVE', 'ACTIVE_HEALTHY'].includes(text(value?.status).toUpperCase())) {
      throw categoricalError('FIXTURE_RECOVERY_MANAGEMENT_TARGET_MISMATCH');
    }
  }
  return value;
}

async function proveManagementTarget(projectRef) {
  await managementRead(projectRef, `/v1/projects/${projectRef}`);
  return true;
}

async function loadServiceRoleKey(projectRef) {
  const rows = await managementRead(projectRef, `/v1/projects/${projectRef}/api-keys?reveal=true`);
  const matches = (Array.isArray(rows) ? rows : []).filter(
    (entry) => text(entry?.name) === 'service_role' && text(entry?.type) === 'legacy'
  );
  const key = text(matches[0]?.api_key || matches[0]?.key);
  if (matches.length !== 1 || !key) throw categoricalError('FIXTURE_RECOVERY_SERVICE_KEY_SHAPE_INVALID');
  return key;
}

async function deleteTemporaryAuthUser(projectRef, serviceKey, userId) {
  const response = await fetch(
    `https://${projectRef}.supabase.co/auth/v1/admin/users/${encodeURIComponent(userId)}?should_soft_delete=false`,
    {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(20_000)
    }
  );
  if (!response.ok) throw categoricalError('FIXTURE_RECOVERY_AUTH_DELETE_FAILED');
}

async function proveTemporaryAuthUser(projectRef, serviceKey, userId) {
  const response = await fetch(
    `https://${projectRef}.supabase.co/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(20_000)
    }
  );
  if (!response.ok) throw categoricalError('FIXTURE_RECOVERY_AUTH_PREFLIGHT_FAILED');
  const value = await response.json();
  if (text(value?.id).toLowerCase() !== userId) {
    throw categoricalError('FIXTURE_RECOVERY_AUTH_PREFLIGHT_MISMATCH');
  }
}

function assertAuthAfterCleanup(authState, authority) {
  const baseline = authority.manifest.prefixture.auth || {};
  if (
    authState.all_users !== Number(baseline.allUsers) ||
    authState.temporary_exact !== 0 ||
    authState.temporary_users !== 0 ||
    authState.smoke_exact !== 1 ||
    authState.smoke_users !== Number(baseline.smokeUsers) ||
    authState.copied_users !== Number(baseline.copiedUsers) ||
    authState.usable_copied_credentials !== Number(baseline.usableCopiedCredentials)
  ) {
    throw categoricalError('FIXTURE_RECOVERY_AUTH_AFTER_STATE_MISMATCH');
  }
}

async function verifyAfterCleanup(client, { authority, plan, ownerGuardSource }) {
  return withReadOnlySnapshot(client, async () => {
    const fixtureState = await captureFixtureState(client, authority);
    const authState = await captureAuthState(client, authority);
    const identityReferences = await captureIdentityReferences(client, authority);
    const sideEffects = await captureSideEffectState(client);
    const ownerGuard = await captureOwnerGuard(client, ownerGuardSource);
    const protection = await captureProtectionFingerprint(client);
    const ownerViolations = await captureOwnerInvariant(client, []);
    if (
      fixtureState.fixtureRows !== 0 ||
      fixtureState.baselineEqual !== true ||
      identityReferences.exactReferences !== 0 ||
      identityReferences.nonfixtureReferences !== 0 ||
      runtimeCanonicalSerialize(sideEffects) !== runtimeCanonicalSerialize(plan.expected.sideEffects) ||
      runtimeCanonicalSerialize(ownerGuard) !== runtimeCanonicalSerialize(plan.expected.ownerGuard) ||
      runtimeCanonicalSerialize(protection) !== runtimeCanonicalSerialize(plan.expected.protection) ||
      ownerViolations !== 0
    ) {
      throw categoricalError('FIXTURE_RECOVERY_STRICT_AFTER_STATE_MISMATCH');
    }
    assertAuthAfterCleanup(authState, authority);
    return { fixtureState, authState, ownerGuard, protection };
  });
}

function writeFailureResult(files, authority, plan, code, transactionResult = null) {
  if (fs.existsSync(files.result)) return;
  const payload = buildRecoveryResult(plan, {
    status: code === 'FIXTURE_RECOVERY_COMMIT_OUTCOME_AMBIGUOUS' ? 'commit_ambiguous' : 'failed',
    category: code,
    databaseCommitKnown: transactionResult?.committed === true,
    authCleanupKnown: false,
    retryAllowed: false
  });
  writePrivateJsonExclusive(files.result, buildSignedRuntimeRecord(payload, authority.key));
}

async function cleanup(options, context) {
  const {
    files,
    authority,
    ownerGuardSource,
    boxTransferGuardSource,
    client,
    applicationCommit,
    projectRef
  } = context;
  if (!booleanOption(options.apply) || !booleanOption(options['quiet-window-active'])) {
    throw categoricalError('FIXTURE_RECOVERY_APPLY_GUARD_MISSING');
  }
  if (!fs.existsSync(files.plan)) throw categoricalError('FIXTURE_RECOVERY_PLAN_MISSING');
  assertAbsent(files.attempt, 'FIXTURE_RECOVERY_NAMESPACE_FROZEN');
  assertAbsent(files.result, 'FIXTURE_RECOVERY_NAMESPACE_FROZEN');
  const plan = readSignedRuntimeRecord(files.plan, authority.key, RECOVERY_PLAN_FORMAT).payload;
  assertPlanMatchesAuthority(plan, authority, applicationCommit);
  await proveManagementTarget(projectRef);
  let serviceKey = await loadServiceRoleKey(projectRef);
  await proveTemporaryAuthUser(projectRef, serviceKey, authority.temporaryUserId);
  const attempt = buildRecoveryAttempt(plan);
  writePrivateJsonExclusive(files.attempt, buildSignedRuntimeRecord(attempt, authority.key));

  let transactionResult;
  try {
    const recoveryMode = selectFixtureRecoveryMode(plan);
    transactionResult = await executeFixtureRecoveryTransaction({
      client,
      authority,
      plan,
      expectedFunctionSource: ownerGuardSource,
      expectedBoxTransferGuardSource: boxTransferGuardSource,
      recoveryMode
    });
    await deleteTemporaryAuthUser(projectRef, serviceKey, authority.temporaryUserId);
    serviceKey = '';
    const after = await verifyAfterCleanup(client, { authority, plan, ownerGuardSource });
    const payload = buildRecoveryResult(plan, {
      status: 'succeeded',
      databaseCommitKnown: true,
      authCleanupKnown: true,
      deletedOrganizationRoots: transactionResult.deletedOrganizationRoots,
      fixtureRowsDeleted: transactionResult.fixtureRowsDeleted,
      fixtureCountsDeleted: transactionResult.fixtureCountsDeleted,
      temporaryAuthUsersDeleted: 1,
      applicationTablesEqual: after.fixtureState.tableCount,
      nonfixtureEqual: true,
      triggerRestored: true,
      protectedStateEqual: true,
      permanentSmokeUsers: after.authState.smoke_users,
      copiedUsers: after.authState.copied_users,
      temporaryUsers: after.authState.temporary_users,
      recoveryMode,
      recoveryHistory: transactionResult.recoveryHistory,
      retryAllowed: false
    });
    writePrivateJsonExclusive(files.result, buildSignedRuntimeRecord(payload, authority.key));
    console.log(
      JSON.stringify({
        result: 'SANDBOX_FIXTURE_RECOVERY_SUCCEEDED',
        target: 'sandbox',
        serializableTransactions: 1,
        organizationRootsDeleted: transactionResult.deletedOrganizationRoots,
        applicationFixtureRowsDeleted: transactionResult.fixtureRowsDeleted,
        temporaryAuthUsersDeleted: 1,
        applicationFixtureResidue: 0,
        nonfixtureEqual: true,
        ownerGuardRestored: true,
        protectedStateEqual: true,
        permanentSmokeUsers: after.authState.smoke_users,
        copiedUsers: after.authState.copied_users,
        temporaryUsers: after.authState.temporary_users,
        filmOrderHistoryPredeleted: transactionResult.recoveryHistory !== null,
        oneShotMarkerRetained: true
      })
    );
  } catch (error) {
    serviceKey = '';
    const code = text(error?.code || error?.message || 'FIXTURE_RECOVERY_FAILED').replace(
      /[^A-Z0-9_]/gi,
      '_'
    );
    try {
      writeFailureResult(files, authority, plan, code, transactionResult);
    } catch {
      // The permanent attempt marker remains the authoritative freeze if result persistence fails.
    }
    throw categoricalError(code);
  } finally {
    serviceKey = '';
  }
}

function loadFailedCleanupState(files, authority, plan, expectedCategory = '23503') {
  const attempt = readSignedRuntimeRecord(
    files.attempt,
    authority.key,
    RECOVERY_ATTEMPT_FORMAT
  ).payload;
  const result = readSignedRuntimeRecord(
    files.result,
    authority.key,
    RECOVERY_RESULT_FORMAT
  ).payload;
  const expectedAttempt = buildRecoveryAttempt(plan, { startedAt: attempt.startedAt });
  if (
    runtimeCanonicalSerialize(attempt) !== runtimeCanonicalSerialize(expectedAttempt) ||
    result.projectRef !== plan.projectRef ||
    result.runTag !== plan.runTag ||
    result.planDigest !== attempt.planDigest ||
    result.status !== 'failed' ||
    result.category !== expectedCategory ||
    result.databaseCommitKnown !== false ||
    result.authCleanupKnown !== false ||
    result.retryAllowed !== false
  ) {
    throw categoricalError('FIXTURE_RECOVERY_OVERRIDE_PREDECESSOR_INVALID');
  }
  return { attempt, result };
}

async function assertFilmOrderRecoveryPreflight(context, plan) {
  const { authority, ownerGuardSource, client, applicationCommit } = context;
  await withReadOnlySnapshot(client, async () => {
    const evidence = await captureRecoveryPreconditions(client, authority, ownerGuardSource);
    const currentPlan = buildFixtureRecoveryPlan({
      authority,
      ...evidence,
      expectedApplicationCommit: applicationCommit,
      createdAt: plan.createdAt
    });
    if (runtimeCanonicalSerialize(currentPlan) !== runtimeCanonicalSerialize(plan)) {
      throw categoricalError('FIXTURE_RECOVERY_OVERRIDE_STATE_MISMATCH');
    }
    const contract = await client.query(`
      select
        (
          select count(*)::integer
          from pg_constraint c
          join pg_class child on child.oid = c.conrelid
          join pg_namespace child_ns on child_ns.oid = child.relnamespace
          join pg_class parent on parent.oid = c.confrelid
          join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
          where c.contype = 'f'
            and c.conname = 'film_order_events_org_id_fkey'
            and child_ns.nspname = 'app'
            and child.relname = 'film_order_events'
            and parent_ns.nspname = 'app'
            and parent.relname = 'organizations'
            and c.confdeltype = 'c'
        ) as cascade_fk,
        (
          select count(*)::integer
          from pg_trigger t
          join pg_class trigger_table on trigger_table.oid = t.tgrelid
          join pg_namespace trigger_ns on trigger_ns.oid = trigger_table.relnamespace
          where trigger_ns.nspname = 'app'
            and t.tgname in ('trg_film_order_events_for_links', 'trg_film_order_events_for_orders')
            and t.tgenabled = 'O'
            and not t.tgisinternal
        ) as enabled_history_triggers
    `);
    if (
      Number(contract.rows[0]?.cascade_fk) !== 1 ||
      Number(contract.rows[0]?.enabled_history_triggers) !== 2
    ) {
      throw categoricalError('FIXTURE_RECOVERY_OVERRIDE_SCHEMA_CONTRACT_MISMATCH');
    }
  });
}

async function assertBoxTransferRecoveryPreflight(context, plan) {
  const {
    authority,
    ownerGuardSource,
    boxTransferGuardSource,
    client,
    applicationCommit
  } = context;
  await withReadOnlySnapshot(client, async () => {
    const evidence = await captureRecoveryPreconditions(client, authority, ownerGuardSource);
    const currentPlan = buildFixtureRecoveryPlan({
      authority,
      ...evidence,
      expectedApplicationCommit: applicationCommit,
      createdAt: plan.createdAt
    });
    if (runtimeCanonicalSerialize(currentPlan) !== runtimeCanonicalSerialize(plan)) {
      throw categoricalError('FIXTURE_RECOVERY_OVERRIDE_STATE_MISMATCH');
    }
    const recoveryMode = selectFixtureRecoveryMode(plan);
    if (!['box-transfer-immutable-history', 'film-order-and-box-transfer-history'].includes(recoveryMode)) {
      throw categoricalError('FIXTURE_RECOVERY_BOX_TRANSFER_HISTORY_NOT_APPLICABLE');
    }
    await captureBoxTransferGuard(client, boxTransferGuardSource);
  });
}

function writeOverrideFailureResult(
  files,
  authority,
  plan,
  code,
  transactionResult = null,
  recoveryMode = 'film_order_event_trigger_fk'
) {
  if (fs.existsSync(files.overrideResult)) return;
  const payload = {
    ...buildRecoveryResult(plan, {
      status: code === 'FIXTURE_RECOVERY_COMMIT_OUTCOME_AMBIGUOUS' ? 'commit_ambiguous' : 'failed',
      category: code,
      databaseCommitKnown: transactionResult?.committed === true,
      authCleanupKnown: false,
      retryAllowed: false,
      recoveryMode
    }),
    format: RECOVERY_OVERRIDE_RESULT_FORMAT
  };
  writePrivateJsonExclusive(files.overrideResult, buildSignedRuntimeRecord(payload, authority.key));
}

async function recoverFilmOrderHistory(options, context) {
  const { files, authority, ownerGuardSource, client, applicationCommit, projectRef } = context;
  if (!booleanOption(options.apply) || !booleanOption(options['quiet-window-active'])) {
    throw categoricalError('FIXTURE_RECOVERY_OVERRIDE_APPLY_GUARD_MISSING');
  }
  if (requiredOption(options, 'confirmed-failure-constraint') !== 'film_order_events_org_id_fkey') {
    throw categoricalError('FIXTURE_RECOVERY_OVERRIDE_CONSTRAINT_UNCONFIRMED');
  }
  if (!fs.existsSync(files.plan) || !fs.existsSync(files.attempt) || !fs.existsSync(files.result)) {
    throw categoricalError('FIXTURE_RECOVERY_OVERRIDE_PREDECESSOR_MISSING');
  }
  assertAbsent(files.overrideAttempt, 'FIXTURE_RECOVERY_OVERRIDE_NAMESPACE_FROZEN');
  assertAbsent(files.overrideResult, 'FIXTURE_RECOVERY_OVERRIDE_NAMESPACE_FROZEN');
  const plan = readSignedRuntimeRecord(files.plan, authority.key, RECOVERY_PLAN_FORMAT).payload;
  assertPlanMatchesAuthority(plan, authority, applicationCommit);
  const failed = loadFailedCleanupState(files, authority, plan);
  await assertFilmOrderRecoveryPreflight(context, plan);
  await proveManagementTarget(projectRef);
  let serviceKey = await loadServiceRoleKey(projectRef);
  await proveTemporaryAuthUser(projectRef, serviceKey, authority.temporaryUserId);
  const overrideAttempt = {
    ...buildRecoveryAttempt(plan),
    format: RECOVERY_OVERRIDE_ATTEMPT_FORMAT,
    recoveryMode: 'film_order_event_trigger_fk',
    predecessorPlanDigest: failed.attempt.planDigest,
    predecessorCategory: failed.result.category,
    confirmedFailureConstraint: 'film_order_events_org_id_fkey'
  };
  writePrivateJsonExclusive(
    files.overrideAttempt,
    buildSignedRuntimeRecord(overrideAttempt, authority.key)
  );

  let transactionResult;
  try {
    transactionResult = await executeFixtureRecoveryTransaction({
      client,
      authority,
      plan,
      expectedFunctionSource: ownerGuardSource,
      recoveryMode: 'film-order-event-trigger-fk'
    });
    await deleteTemporaryAuthUser(projectRef, serviceKey, authority.temporaryUserId);
    serviceKey = '';
    const after = await verifyAfterCleanup(client, { authority, plan, ownerGuardSource });
    const payload = {
      ...buildRecoveryResult(plan, {
        status: 'succeeded',
        databaseCommitKnown: true,
        authCleanupKnown: true,
        deletedOrganizationRoots: transactionResult.deletedOrganizationRoots,
        fixtureRowsDeleted: transactionResult.fixtureRowsDeleted,
        fixtureCountsDeleted: transactionResult.fixtureCountsDeleted,
        temporaryAuthUsersDeleted: 1,
        applicationTablesEqual: after.fixtureState.tableCount,
        nonfixtureEqual: true,
        triggerRestored: true,
        protectedStateEqual: true,
        permanentSmokeUsers: after.authState.smoke_users,
        copiedUsers: after.authState.copied_users,
        temporaryUsers: after.authState.temporary_users,
        retryAllowed: false,
        recoveryMode: 'film_order_event_trigger_fk',
        recoveryHistory: transactionResult.recoveryHistory
      }),
      format: RECOVERY_OVERRIDE_RESULT_FORMAT
    };
    writePrivateJsonExclusive(files.overrideResult, buildSignedRuntimeRecord(payload, authority.key));
    console.log(JSON.stringify({
      result: 'SANDBOX_FIXTURE_RECOVERY_OVERRIDE_SUCCEEDED',
      target: 'sandbox',
      serializableTransactions: 1,
      organizationRootsDeleted: transactionResult.deletedOrganizationRoots,
      applicationFixtureRowsDeleted: transactionResult.fixtureRowsDeleted,
      filmOrderLinksDeleted: transactionResult.recoveryHistory.linksDeleted,
      filmOrdersDeleted: transactionResult.recoveryHistory.ordersDeleted,
      filmOrderEventsDeleted: transactionResult.recoveryHistory.eventsDeleted,
      cleanupGeneratedEventsDeleted: transactionResult.recoveryHistory.generatedEventsDeleted,
      temporaryAuthUsersDeleted: 1,
      applicationFixtureResidue: 0,
      nonfixtureEqual: true,
      ownerGuardRestored: true,
      protectedStateEqual: true,
      permanentSmokeUsers: after.authState.smoke_users,
      copiedUsers: after.authState.copied_users,
      temporaryUsers: after.authState.temporary_users,
      ordinaryMarkerRetained: true,
      overrideMarkerRetained: true
    }));
  } catch (error) {
    serviceKey = '';
    const code = text(error?.code || error?.message || 'FIXTURE_RECOVERY_OVERRIDE_FAILED').replace(
      /[^A-Z0-9_]/gi,
      '_'
    );
    try {
      writeOverrideFailureResult(files, authority, plan, code, transactionResult);
    } catch {
      // The override attempt marker remains the authoritative freeze.
    }
    throw categoricalError(code);
  } finally {
    serviceKey = '';
  }
}

async function recoverTransferHistory(options, context) {
  const {
    files,
    authority,
    ownerGuardSource,
    boxTransferGuardSource,
    client,
    applicationCommit,
    projectRef
  } = context;
  if (!booleanOption(options.apply) || !booleanOption(options['quiet-window-active'])) {
    throw categoricalError('FIXTURE_RECOVERY_OVERRIDE_APPLY_GUARD_MISSING');
  }
  if (requiredOption(options, 'confirmed-failure-routine') !== 'guard_box_transfer_mutation') {
    throw categoricalError('FIXTURE_RECOVERY_OVERRIDE_ROUTINE_UNCONFIRMED');
  }
  if (!fs.existsSync(files.plan) || !fs.existsSync(files.attempt) || !fs.existsSync(files.result)) {
    throw categoricalError('FIXTURE_RECOVERY_OVERRIDE_PREDECESSOR_MISSING');
  }
  assertAbsent(files.overrideAttempt, 'FIXTURE_RECOVERY_OVERRIDE_NAMESPACE_FROZEN');
  assertAbsent(files.overrideResult, 'FIXTURE_RECOVERY_OVERRIDE_NAMESPACE_FROZEN');
  const plan = readSignedRuntimeRecord(files.plan, authority.key, RECOVERY_PLAN_FORMAT).payload;
  assertPlanMatchesAuthority(plan, authority, applicationCommit);
  const failed = loadFailedCleanupState(files, authority, plan, 'P0001');
  await assertBoxTransferRecoveryPreflight(context, plan);
  await proveManagementTarget(projectRef);
  let serviceKey = await loadServiceRoleKey(projectRef);
  await proveTemporaryAuthUser(projectRef, serviceKey, authority.temporaryUserId);
  const recoveryMode = selectFixtureRecoveryMode(plan);
  const overrideAttempt = {
    ...buildRecoveryAttempt(plan),
    format: RECOVERY_OVERRIDE_ATTEMPT_FORMAT,
    recoveryMode,
    predecessorPlanDigest: failed.attempt.planDigest,
    predecessorCategory: failed.result.category,
    confirmedFailureRoutine: 'guard_box_transfer_mutation'
  };
  writePrivateJsonExclusive(
    files.overrideAttempt,
    buildSignedRuntimeRecord(overrideAttempt, authority.key)
  );

  let transactionResult;
  try {
    transactionResult = await executeFixtureRecoveryTransaction({
      client,
      authority,
      plan,
      expectedFunctionSource: ownerGuardSource,
      expectedBoxTransferGuardSource: boxTransferGuardSource,
      recoveryMode
    });
    await deleteTemporaryAuthUser(projectRef, serviceKey, authority.temporaryUserId);
    serviceKey = '';
    const after = await verifyAfterCleanup(client, { authority, plan, ownerGuardSource });
    const payload = {
      ...buildRecoveryResult(plan, {
        status: 'succeeded',
        databaseCommitKnown: true,
        authCleanupKnown: true,
        deletedOrganizationRoots: transactionResult.deletedOrganizationRoots,
        fixtureRowsDeleted: transactionResult.fixtureRowsDeleted,
        fixtureCountsDeleted: transactionResult.fixtureCountsDeleted,
        temporaryAuthUsersDeleted: 1,
        applicationTablesEqual: after.fixtureState.tableCount,
        nonfixtureEqual: true,
        triggerRestored: true,
        protectedStateEqual: true,
        permanentSmokeUsers: after.authState.smoke_users,
        copiedUsers: after.authState.copied_users,
        temporaryUsers: after.authState.temporary_users,
        retryAllowed: false,
        recoveryMode,
        recoveryHistory: transactionResult.recoveryHistory
      }),
      format: RECOVERY_OVERRIDE_RESULT_FORMAT
    };
    writePrivateJsonExclusive(files.overrideResult, buildSignedRuntimeRecord(payload, authority.key));
    console.log(JSON.stringify({
      result: 'SANDBOX_FIXTURE_TRANSFER_RECOVERY_OVERRIDE_SUCCEEDED',
      target: 'sandbox',
      serializableTransactions: 1,
      organizationRootsDeleted: transactionResult.deletedOrganizationRoots,
      applicationFixtureRowsDeleted: transactionResult.fixtureRowsDeleted,
      boxTransfersDeleted: transactionResult.recoveryHistory.transfersDeleted,
      filmOrderHistoryPredeleted: Number(transactionResult.recoveryHistory.linksDeleted || 0) > 0,
      temporaryAuthUsersDeleted: 1,
      applicationFixtureResidue: 0,
      nonfixtureEqual: true,
      ownerGuardRestored: true,
      boxTransferGuardRestored: transactionResult.recoveryHistory.transferGuardRestored === true,
      protectedStateEqual: true,
      permanentSmokeUsers: after.authState.smoke_users,
      copiedUsers: after.authState.copied_users,
      temporaryUsers: after.authState.temporary_users,
      ordinaryMarkerRetained: true,
      overrideMarkerRetained: true
    }));
  } catch (error) {
    serviceKey = '';
    const code = text(error?.code || error?.message || 'FIXTURE_RECOVERY_OVERRIDE_FAILED').replace(
      /[^A-Z0-9_]/gi,
      '_'
    );
    try {
      writeOverrideFailureResult(files, authority, plan, code, transactionResult, recoveryMode);
    } catch {
      // The override attempt marker remains the authoritative freeze.
    }
    throw categoricalError(code);
  } finally {
    serviceKey = '';
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.h) {
    printUsage();
    return;
  }
  const action = requiredOption(options, 'action').toLowerCase();
  if (![
    'prepare',
    'cleanup',
    'recover-film-order-history',
    'recover-transfer-history'
  ].includes(action)) {
    throw categoricalError('FIXTURE_RECOVERY_ACTION_INVALID');
  }
  const authorityDirectory = path.resolve(requiredOption(options, 'authority-dir'));
  const files = resolveFiles(authorityDirectory);
  const applicationCommit = requiredOption(options, 'expected-application-commit').toLowerCase();
  const project = readProjectAndConnection({
    projectArtifactPath: requiredOption(options, 'project-artifact'),
    passwordArtifactPath: requiredOption(options, 'database-password-artifact'),
    expectedProjectRef: requiredOption(options, 'expected-project-ref')
  });
  const authority = loadAuthority(options, files);
  const ownerGuardSource = loadOwnerGuardSource(options);
  const boxTransferGuardSource = loadBoxTransferGuardSource(options);
  const client = createClient(project.connectionString);
  await client.connect();
  try {
    await guardConnectedSandbox(client, project.projectRef);
    const context = {
      files,
      authority,
      ownerGuardSource,
      boxTransferGuardSource,
      client,
      applicationCommit,
      projectRef: project.projectRef
    };
    if (action === 'prepare') await prepare(options, context);
    else if (action === 'cleanup') await cleanup(options, context);
    else if (action === 'recover-film-order-history') await recoverFilmOrderHistory(options, context);
    else await recoverTransferHistory(options, context);
  } finally {
    authority.key.fill(0);
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  const code = text(error?.code || error?.message || 'FIXTURE_RECOVERY_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_')
    .slice(0, 120);
  console.error(`[sandbox-fixture-recovery] ${code}`);
  process.exitCode = 1;
});
