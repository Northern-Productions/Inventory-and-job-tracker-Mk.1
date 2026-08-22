#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import pg from 'pg';

import { assertManagedNonprodTarget } from './lib/environment-sync/auth-quarantine.mjs';
import {
  RECOVERY_PLAN_FORMAT,
  assertPlanMatchesAuthority,
  buildFixtureRecoveryPlan,
  buildRecoveryAttempt,
  buildRecoveryResult,
  buildSignedRuntimeRecord,
  captureAuthState,
  captureFixtureState,
  captureIdentityReferences,
  captureOwnerGuard,
  captureOwnerInvariant,
  captureProtectionFingerprint,
  captureRecoveryPreconditions,
  captureSideEffectState,
  executeFixtureRecoveryTransaction,
  extractOwnerGuardFunctionSource,
  readRuntimeRecoveryAuthority,
  readSignedRuntimeRecord,
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
  result: 'fixture-recovery-result.private.json'
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

This command is SANDBOX-only. Preparation writes an authenticated private plan after a
rolled-back read-only snapshot. Cleanup is permanent and one-shot after its private attempt
marker is published. It never accepts discovered cleanup roots.`);
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
  const { files, authority, ownerGuardSource, client, applicationCommit, projectRef } = context;
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
    transactionResult = await executeFixtureRecoveryTransaction({
      client,
      authority,
      plan,
      expectedFunctionSource: ownerGuardSource
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.h) {
    printUsage();
    return;
  }
  const action = requiredOption(options, 'action').toLowerCase();
  if (!['prepare', 'cleanup'].includes(action)) {
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
  const client = createClient(project.connectionString);
  await client.connect();
  try {
    await guardConnectedSandbox(client, project.projectRef);
    const context = {
      files,
      authority,
      ownerGuardSource,
      client,
      applicationCommit,
      projectRef: project.projectRef
    };
    if (action === 'prepare') await prepare(options, context);
    else await cleanup(options, context);
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
