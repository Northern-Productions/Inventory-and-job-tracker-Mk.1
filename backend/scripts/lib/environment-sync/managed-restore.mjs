import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { PROD_PROJECT_REF } from '../target-env-guards.mjs';
import {
  AUTH_PURGE_ORDER,
  AUTH_RECOVERY_TABLE_CLASSIFICATION,
  CURRENT_AUTH_TABLES
} from './constants.mjs';
import {
  APPLICATION_ACL_CONTRACT_FORMAT,
  buildApplicationAclConvergenceSql,
  verifyApplicationAclContract
} from './application-acl-convergence.mjs';
import {
  APPLICATION_DEFAULT_ACL_MANIFEST_FORMAT,
  buildApplicationDefaultAclPreservationSql,
  buildApplicationDefaultAclVerificationSql,
  normalizeSemanticEntries as normalizeApplicationDefaultAclEntries,
  verifyApplicationDefaultAclManifest
} from './application-default-acl-preservation.mjs';
import { parseDatabaseConnection, postgresChildEnvironment } from './encrypted-baseline.mjs';
import {
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  verifyPrivateDirectoryProtection,
  writePrivateBytesExclusive,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import { runPrivateDiagnosticCommand } from './private-diagnostics.mjs';
import {
  managedProfileEvidenceFromCatalog,
  verifyManagedProfileCertificate
} from './managed-profile.mjs';
import {
  authenticateManifest,
  verifyAuthenticatedManifest
} from './manifest.mjs';
import { verifyNativeSmokePreservation } from './native-smoke-preservation.mjs';

const MANAGED_RESTORE_MANIFEST_FORMAT = 'supabase-managed-overlay-restore-manifest-v1';
const MANAGED_RESTORE_CANONICALIZATION = 'supabase-managed-overlay-toc-c14n-v1';
const DEV_Y2_AUTH_RECOVERY_FORMAT = 'dev-y2-exact-auth-recovery-v1';
const DEV_Y2_AUTH_RECOVERY_MODE = 'exact-dev-y2-recovery';
const DEV_REMEDIATION_AUTH_PRESERVATION_FORMAT = 'dev-remediation-auth-preservation-v1';
const DEV_REMEDIATION_AUTH_PRESERVATION_MODE = 'preserve-target-native-auth';
const MANAGED_OVERLAY_COMPATIBILITY_BINDING_FIELDS = Object.freeze([
  Object.freeze({ guardField: 'managedCatalogDigest', packageField: 'targetCompatibility.catalogDigest' }),
  Object.freeze({ guardField: 'managedProfileDigest', packageField: 'targetCompatibility.managedProfileDigest' }),
  Object.freeze({ guardField: 'managedProfileId', packageField: 'targetCompatibility.managedProfileId' }),
  Object.freeze({
    guardField: 'managedProfileSecurityDigest',
    packageField: 'targetCompatibility.managedProfileSecurityDigest'
  }),
  Object.freeze({ guardField: 'managedProfileTarget', packageField: 'targetCompatibility.managedProfileTarget' }),
  Object.freeze({ guardField: 'authShapeDigest', packageField: 'targetCompatibility.authShapeDigest' }),
  Object.freeze({
    guardField: 'applicationReplacementDigest',
    packageField: 'targetCompatibility.applicationReplacementDigest'
  }),
  Object.freeze({ guardField: 'restorePlanDigest', packageField: 'manifest.planDigest' })
]);
const MANAGED_RESTORE_ACTIONS = Object.freeze([
  'restore',
  'transform',
  'skip-as-managed',
  'recreate-target-locally',
  'preserve-target-native'
]);
const MANAGED_RESTORE_CATEGORIES = Object.freeze({
  A: 'PORTABLE_APPLICATION_OBJECT',
  B: 'PORTABLE_APPLICATION_DATA',
  C: 'PORTABLE_APPLICATION_ROLE_GRANT',
  D: 'AUTH_RELATIONAL_DATA_NEEDED_FOR_UUID_SHAPE',
  E: 'TARGET_MANAGED_OBJECT',
  F: 'TARGET_MANAGED_ROLE_OWNERSHIP',
  G: 'PLATFORM_CONFIG',
  H: 'UNCERTAIN'
});
const REQUIRED_MANAGED_ROLES = Object.freeze([
  'anon',
  'authenticated',
  'authenticator',
  'postgres',
  'service_role',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_realtime_admin',
  'supabase_storage_admin'
]);
const TARGET_NATIVE_SCHEMAS = Object.freeze([
  'auth',
  'extensions',
  'graphql',
  'graphql_public',
  'public',
  'realtime',
  'storage',
  'vault'
]);
const REQUIRED_TARGET_EXTENSIONS = Object.freeze(['pgcrypto', 'uuid-ossp']);
const AUTH_OVERLAY_TABLES = Object.freeze(['users', 'identities']);
const AUTH_PRESERVED_TABLES = Object.freeze(['instances', 'schema_migrations']);
const AUTH_USERS_COPY_COLUMNS = Object.freeze([
  'instance_id', 'id', 'aud', 'role', 'email', 'encrypted_password',
  'email_confirmed_at', 'invited_at', 'confirmation_token', 'confirmation_sent_at',
  'recovery_token', 'recovery_sent_at', 'email_change_token_new', 'email_change',
  'email_change_sent_at', 'last_sign_in_at', 'raw_app_meta_data', 'raw_user_meta_data',
  'is_super_admin', 'created_at', 'updated_at', 'phone', 'phone_confirmed_at',
  'phone_change', 'phone_change_token', 'phone_change_sent_at',
  'email_change_token_current', 'email_change_confirm_status', 'banned_until',
  'reauthentication_token', 'reauthentication_sent_at', 'is_sso_user', 'deleted_at',
  'is_anonymous'
]);
const AUTH_IDENTITIES_COPY_COLUMNS = Object.freeze([
  'provider_id', 'user_id', 'identity_data', 'provider', 'last_sign_in_at',
  'created_at', 'updated_at', 'id'
]);
const MANAGED_OWNER_ROLES = new Set([
  'pg_database_owner',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_realtime_admin',
  'supabase_storage_admin'
]);
const TOC_LINE = /^(\d+);\s+(\d+)\s+(\d+)\s+(.+?)\s+(-|app|app_api|auth|public|supabase_migrations)\s+(.+)\s+(\S+)$/;

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function managedOverlayCompatibilityBinding(packageResult) {
  const compatibility = packageResult?.targetCompatibility;
  const manifest = packageResult?.manifest;
  const binding = {
    managedCatalogDigest: compatibility?.catalogDigest,
    managedProfileDigest: compatibility?.managedProfileDigest,
    managedProfileId: compatibility?.managedProfileId,
    managedProfileSecurityDigest: compatibility?.managedProfileSecurityDigest,
    managedProfileTarget: compatibility?.managedProfileTarget,
    authShapeDigest: compatibility?.authShapeDigest,
    applicationReplacementDigest: compatibility?.applicationReplacementDigest,
    restorePlanDigest: manifest?.planDigest
  };
  const digestFields = [
    'managedCatalogDigest',
    'managedProfileDigest',
    'managedProfileSecurityDigest',
    'authShapeDigest',
    'applicationReplacementDigest',
    'restorePlanDigest'
  ];
  if (
    !packageResult || typeof packageResult !== 'object' || Array.isArray(packageResult) ||
    !compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility) ||
    !manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
    Object.keys(binding).join(',') !==
      MANAGED_OVERLAY_COMPATIBILITY_BINDING_FIELDS.map(({ guardField }) => guardField).join(',') ||
    digestFields.some((name) => !/^sha256:[a-f0-9]{64}$/.test(String(binding[name] || ''))) ||
    !/^[a-z][a-z0-9._-]{2,95}$/.test(String(binding.managedProfileId || '')) ||
    !binding.managedProfileTarget || typeof binding.managedProfileTarget !== 'object' ||
    Array.isArray(binding.managedProfileTarget) ||
    !['dev', 'sandbox'].includes(binding.managedProfileTarget.environment) ||
    !/^[a-z0-9]{20}$/.test(String(binding.managedProfileTarget.projectRef || ''))
  ) {
    throw categoricalError('MANAGED_OVERLAY_COMPATIBILITY_BINDING_INVALID');
  }
  return {
    ...binding,
    managedProfileTarget: { ...binding.managedProfileTarget }
  };
}

function buildManagedOverlayTargetGuard({
  packageResult,
  target,
  projectRef,
  mutationGuardPassed,
  projectRefMatched
} = {}) {
  const binding = managedOverlayCompatibilityBinding(packageResult);
  if (
    mutationGuardPassed !== true || projectRefMatched !== true ||
    !['dev', 'sandbox'].includes(target) ||
    !/^[a-z0-9]{20}$/.test(String(projectRef || '')) ||
    binding.managedProfileTarget.environment !== target ||
    binding.managedProfileTarget.projectRef !== projectRef
  ) {
    throw categoricalError('MANAGED_OVERLAY_COMPATIBILITY_BINDING_INVALID');
  }
  return {
    target,
    projectRef,
    mutationGuardPassed,
    projectRefMatched,
    ...binding
  };
}

function safeCount(value, code = 'MANAGED_RESTORE_COUNT_INVALID') {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw categoricalError(code);
  return count;
}

function normalizeAuthRecoveryTable(entry = {}, expectedName = '') {
  const tableName = String(entry.tableName || '');
  const count = safeCount(entry.count, 'DEV_Y2_AUTH_RECOVERY_COUNT_INVALID');
  const digest = String(entry.digest || '').toLowerCase();
  if (
    tableName !== expectedName ||
    !CURRENT_AUTH_TABLES.includes(tableName) ||
    !/^sha256:[a-f0-9]{64}$/.test(digest) ||
    Object.keys(entry).sort().join(',') !== 'count,digest,tableName'
  ) {
    throw categoricalError('DEV_Y2_AUTH_RECOVERY_TABLE_INVALID');
  }
  return { tableName, count, digest };
}

async function captureExactAuthRecoveryEvidence(client) {
  if (!client || typeof client.query !== 'function') {
    throw categoricalError('DEV_Y2_AUTH_RECOVERY_CLIENT_INVALID');
  }
  const tables = [];
  for (const tableName of CURRENT_AUTH_TABLES) {
    const result = await client.query(
      `select count(*)::bigint as count,
              'sha256:' || encode(extensions.digest(
                convert_to(coalesce(string_agg(pg_catalog.to_jsonb(t)::text, E'\\n'
                  order by pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), ''), 'UTF8'),
                'sha256'
              ), 'hex') as digest
         from auth."${tableName}" t`
    );
    tables.push(normalizeAuthRecoveryTable({
      tableName,
      count: result.rows[0]?.count,
      digest: result.rows[0]?.digest
    }, tableName));
  }
  return {
    format: 'dev-y2-exact-auth-evidence-v1',
    algorithm: 'sha256',
    serialization: 'postgres-jsonb-text-lf-bytewise-utf8-v1',
    tables
  };
}

function buildExactAuthRecoveryAuthority({
  attemptId,
  target,
  sourceComponentDigest,
  migration,
  evidence
} = {}, key) {
  const normalizedAttemptId = String(attemptId || '');
  const normalizedTarget = {
    environment: String(target?.environment || ''),
    projectRef: String(target?.projectRef || '')
  };
  const normalizedSourceDigest = String(sourceComponentDigest || '').toLowerCase();
  const normalizedMigration = {
    count: safeCount(migration?.count, 'DEV_Y2_AUTH_RECOVERY_MIGRATION_INVALID'),
    tip: String(migration?.tip || '')
  };
  if (
    !/^[a-z0-9][a-z0-9._-]{7,127}$/.test(normalizedAttemptId) ||
    normalizedTarget.environment !== 'dev' ||
    !/^[a-z0-9]{10,40}$/.test(normalizedTarget.projectRef) ||
    !/^sha256:[a-f0-9]{64}$/.test(normalizedSourceDigest) ||
    !/^20\d{12}$/.test(normalizedMigration.tip) ||
    evidence?.format !== 'dev-y2-exact-auth-evidence-v1' ||
    evidence?.algorithm !== 'sha256' ||
    evidence?.serialization !== 'postgres-jsonb-text-lf-bytewise-utf8-v1' ||
    !Array.isArray(evidence?.tables) ||
    evidence.tables.length !== CURRENT_AUTH_TABLES.length
  ) {
    throw categoricalError('DEV_Y2_AUTH_RECOVERY_AUTHORITY_INVALID');
  }
  const tables = CURRENT_AUTH_TABLES.map((tableName, index) =>
    normalizeAuthRecoveryTable(evidence.tables[index], tableName));
  return authenticateManifest({
    format: DEV_Y2_AUTH_RECOVERY_FORMAT,
    version: 1,
    mode: DEV_Y2_AUTH_RECOVERY_MODE,
    attemptId: normalizedAttemptId,
    target: normalizedTarget,
    sourceComponentDigest: normalizedSourceDigest,
    migration: normalizedMigration,
    authEvidence: {
      format: evidence.format,
      algorithm: evidence.algorithm,
      serialization: evidence.serialization,
      tables
    }
  }, key);
}

function verifyExactAuthRecoveryAuthority(authority, key, {
  attemptId,
  target,
  sourceComponentDigest,
  migration
} = {}) {
  verifyAuthenticatedManifest(authority, key);
  const rebuilt = buildExactAuthRecoveryAuthority({
    attemptId: authority.attemptId,
    target: authority.target,
    sourceComponentDigest: authority.sourceComponentDigest,
    migration: authority.migration,
    evidence: authority.authEvidence
  }, key);
  if (
    canonicalSerialize(rebuilt) !== canonicalSerialize(authority) ||
    authority.attemptId !== attemptId ||
    canonicalSerialize(authority.target) !== canonicalSerialize(target) ||
    authority.sourceComponentDigest !== sourceComponentDigest ||
    canonicalSerialize(authority.migration) !== canonicalSerialize(migration)
  ) {
    throw categoricalError('DEV_Y2_AUTH_RECOVERY_AUTHORITY_MISMATCH');
  }
  return authority;
}

function buildAuthPreservationAuthority({
  attemptId,
  target,
  sourceComponentDigest,
  migration,
  evidence
} = {}, key) {
  const exact = buildExactAuthRecoveryAuthority({
    attemptId, target, sourceComponentDigest, migration, evidence
  }, key);
  const payload = {
    ...Object.fromEntries(Object.entries(exact).filter(([name]) => name !== 'authentication')),
    format: DEV_REMEDIATION_AUTH_PRESERVATION_FORMAT,
    mode: DEV_REMEDIATION_AUTH_PRESERVATION_MODE,
    tableClassificationDigest: canonicalDigest(AUTH_RECOVERY_TABLE_CLASSIFICATION),
    authTableDml: 'none'
  };
  return authenticateManifest(payload, key);
}

function verifyAuthPreservationAuthority(authority, key, {
  attemptId,
  target,
  sourceComponentDigest,
  migration
} = {}) {
  verifyAuthenticatedManifest(authority, key);
  const rebuilt = buildAuthPreservationAuthority({
    attemptId: authority.attemptId,
    target: authority.target,
    sourceComponentDigest: authority.sourceComponentDigest,
    migration: authority.migration,
    evidence: authority.authEvidence
  }, key);
  if (
    canonicalSerialize(rebuilt) !== canonicalSerialize(authority) ||
    authority.attemptId !== attemptId ||
    canonicalSerialize(authority.target) !== canonicalSerialize(target) ||
    authority.sourceComponentDigest !== sourceComponentDigest ||
    canonicalSerialize(authority.migration) !== canonicalSerialize(migration)
  ) throw categoricalError('DEV_REMEDIATION_AUTH_PRESERVATION_AUTHORITY_MISMATCH');
  return authority;
}

function parsePgRestoreList(tocText) {
  const lines = String(tocText || '').split(/\r?\n/);
  const entries = [];
  const dumpIds = new Set();
  for (const rawLine of lines) {
    if (!/^\d+;/.test(rawLine)) continue;
    const match = rawLine.match(TOC_LINE);
    if (!match) throw categoricalError('MANAGED_RESTORE_TOC_LINE_UNRECOGNIZED');
    const entry = {
      dumpId: Number(match[1]),
      catalogOid: Number(match[2]),
      objectOid: Number(match[3]),
      objectType: match[4].trim(),
      schema: match[5],
      name: match[6].trim(),
      owner: match[7].trim(),
      rawLine
    };
    if (!Number.isSafeInteger(entry.dumpId) || dumpIds.has(entry.dumpId)) {
      throw categoricalError('MANAGED_RESTORE_TOC_ID_INVALID');
    }
    dumpIds.add(entry.dumpId);
    entries.push(entry);
  }
  if (entries.length === 0) throw categoricalError('MANAGED_RESTORE_TOC_EMPTY');
  return entries;
}

function disposition(category, action, reason) {
  return { category, action, reason };
}

function isSchemaDescriptor(entry, schemaName) {
  return entry.objectType === 'SCHEMA' && entry.schema === '-' && entry.name === schemaName;
}

function isSchemaMetadata(entry, schemaName) {
  return entry.schema === '-' && entry.name === `SCHEMA ${schemaName}`;
}

function classifyTocEntry(entry) {
  const isData = ['TABLE DATA', 'SEQUENCE SET'].includes(entry.objectType);
  const isGrant = ['ACL', 'DEFAULT ACL'].includes(entry.objectType);

  if (entry.objectType === 'DEFAULT ACL') {
    return disposition(
      MANAGED_RESTORE_CATEGORIES.F,
      'preserve-target-native',
      'target-native default privileges are certified by the managed profile'
    );
  }

  if (['app', 'app_api'].includes(entry.schema)) {
    if (entry.owner !== 'postgres') {
      return disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'application object has an unreviewed owner');
    }
    if (isData) return disposition(MANAGED_RESTORE_CATEGORIES.B, 'restore', 'application data');
    if (isGrant) return disposition(MANAGED_RESTORE_CATEGORIES.C, 'restore', 'application ACL');
    return disposition(MANAGED_RESTORE_CATEGORIES.A, 'restore', 'application object');
  }

  if (entry.schema === 'public') {
    if (entry.objectType === 'DEFAULT ACL') {
      return disposition(MANAGED_RESTORE_CATEGORIES.F, 'preserve-target-native', 'native public defaults');
    }
    const portableTypes = new Set(['FUNCTION', 'PROCEDURE', 'COMMENT', 'ACL']);
    if (!portableTypes.has(entry.objectType) || entry.owner !== 'postgres') {
      return disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'public object is outside the reviewed application facade');
    }
    if (entry.objectType === 'ACL') {
      return disposition(MANAGED_RESTORE_CATEGORIES.C, 'restore', 'application facade ACL');
    }
    return disposition(MANAGED_RESTORE_CATEGORIES.A, 'restore', 'application facade object');
  }

  if (entry.schema === 'auth') {
    if (isData && AUTH_OVERLAY_TABLES.includes(entry.name)) {
      return disposition(
        MANAGED_RESTORE_CATEGORIES.D,
        'transform',
        'pre-quarantine and transplant relational UUID rows'
      );
    }
    if (isData) {
      const action = AUTH_PRESERVED_TABLES.includes(entry.name)
        ? 'preserve-target-native'
        : 'skip-as-managed';
      return disposition(
        MANAGED_RESTORE_CATEGORIES.E,
        action,
        AUTH_PRESERVED_TABLES.includes(entry.name)
          ? 'target-native Auth control data'
          : 'copied Auth session, token, state, or audit data is omitted'
      );
    }
    if (isGrant) {
      return disposition(MANAGED_RESTORE_CATEGORIES.F, 'preserve-target-native', 'native Auth ownership and ACL');
    }
    return disposition(MANAGED_RESTORE_CATEGORIES.E, 'preserve-target-native', 'native Auth definition');
  }

  if (entry.schema === 'supabase_migrations') {
    if (entry.owner !== 'postgres') {
      return disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'migration ledger owner is unreviewed');
    }
    return disposition(MANAGED_RESTORE_CATEGORIES.G, 'recreate-target-locally', 'migration ledger is restored separately');
  }

  if (entry.schema === '-') {
    if (isSchemaDescriptor(entry, 'app') || isSchemaDescriptor(entry, 'app_api')) {
      return entry.owner === 'postgres'
        ? disposition(MANAGED_RESTORE_CATEGORIES.A, 'restore', 'application schema')
        : disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'application schema owner is unreviewed');
    }
    if (isSchemaMetadata(entry, 'app') || isSchemaMetadata(entry, 'app_api')) {
      return entry.owner === 'postgres'
        ? disposition(MANAGED_RESTORE_CATEGORIES.C, 'restore', 'application schema ACL')
        : disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'application schema ACL owner is unreviewed');
    }
    if (
      isSchemaDescriptor(entry, 'auth') ||
      isSchemaMetadata(entry, 'auth') ||
      isSchemaDescriptor(entry, 'public') ||
      isSchemaMetadata(entry, 'public')
    ) {
      return disposition(
        isGrant ? MANAGED_RESTORE_CATEGORIES.F : MANAGED_RESTORE_CATEGORIES.E,
        'preserve-target-native',
        'native managed schema primitive'
      );
    }
    if (isSchemaDescriptor(entry, 'supabase_migrations') || isSchemaMetadata(entry, 'supabase_migrations')) {
      return entry.owner === 'postgres'
        ? disposition(MANAGED_RESTORE_CATEGORIES.G, 'recreate-target-locally', 'migration ledger schema')
        : disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'migration ledger schema owner is unreviewed');
    }
  }

  if (/\b(?:ROLE|ROLE MEMBERSHIP)\b/.test(entry.objectType)) {
    if (REQUIRED_MANAGED_ROLES.includes(entry.name) || MANAGED_OWNER_ROLES.has(entry.name)) {
      return disposition(MANAGED_RESTORE_CATEGORIES.F, 'preserve-target-native', 'managed role');
    }
  }
  return disposition(MANAGED_RESTORE_CATEGORIES.H, '', 'unreviewed archive object');
}

function manifestPayload(manifest) {
  const { planDigest: _planDigest, ...payload } = manifest;
  return payload;
}

function buildManagedRestoreManifest({
  tocText,
  sourceComponent = {},
  applicationAclContract,
  applicationDefaultAclCertificate
} = {}) {
  if (applicationAclContract !== undefined) verifyApplicationAclContract(applicationAclContract);
  if (
    applicationDefaultAclCertificate !== undefined &&
    applicationDefaultAclCertificate?.format !== APPLICATION_DEFAULT_ACL_MANIFEST_FORMAT
  ) {
    throw categoricalError('MANAGED_RESTORE_DEFAULT_ACL_PRESERVATION_INVALID');
  }
  const parsed = parsePgRestoreList(tocText);
  const entries = parsed.map((entry) => {
    const classified = classifyTocEntry(entry);
    return {
      dumpId: entry.dumpId,
      catalogOid: entry.catalogOid,
      objectOid: entry.objectOid,
      objectType: entry.objectType,
      schema: entry.schema,
      name: entry.name,
      owner: entry.owner,
      ...classified
    };
  });
  const unknown = entries.filter((entry) => entry.category === MANAGED_RESTORE_CATEGORIES.H);
  if (unknown.length > 0) throw categoricalError('MANAGED_RESTORE_UNKNOWN_OBJECT');
  const categoryCounts = Object.fromEntries(
    Object.values(MANAGED_RESTORE_CATEGORIES).map((category) => [
      category,
      entries.filter((entry) => entry.category === category).length
    ])
  );
  const actionCounts = Object.fromEntries(
    MANAGED_RESTORE_ACTIONS.map((action) => [action, entries.filter((entry) => entry.action === action).length])
  );
  const manifest = {
    format: MANAGED_RESTORE_MANIFEST_FORMAT,
    version: 1,
    canonicalization: MANAGED_RESTORE_CANONICALIZATION,
    sourceComponent: {
      name: String(sourceComponent.name || 'postgres-logical-custom-encrypted'),
      size: safeCount(sourceComponent.size || 0),
      digest: String(sourceComponent.digest || '').toLowerCase()
    },
    toc: {
      count: entries.length,
      digest: sha256(Buffer.from(String(tocText || '').replace(/\r\n/g, '\n'), 'utf8'))
    },
    categoryCounts,
    actionCounts,
    managedPlane: {
      roles: [...REQUIRED_MANAGED_ROLES],
      schemas: [...TARGET_NATIVE_SCHEMAS],
      copiedAuthDefinitions: false,
      copiedAuthCredentials: false,
      copiedAuthEphemera: false,
      sessionReplicationRoleRequired: false
    },
    applicationAclConvergence: applicationAclContract === undefined ? null : {
      format: APPLICATION_ACL_CONTRACT_FORMAT,
      contractDigest: applicationAclContract.contractDigest,
      objectDigest: applicationAclContract.objectDigest,
      grantDigest: applicationAclContract.grantDigest,
      objectCount: applicationAclContract.objects.length,
      grantCount: applicationAclContract.grants.length
    },
    applicationDefaultAclPreservation: applicationDefaultAclCertificate === undefined ? null : {
      format: APPLICATION_DEFAULT_ACL_MANIFEST_FORMAT,
      beforeDigest: applicationDefaultAclCertificate.beforeDigest,
      expectedAfterDigest: applicationDefaultAclCertificate.expectedAfterDigest,
      planDigest: applicationDefaultAclCertificate.planDigest,
      entryCount: applicationDefaultAclCertificate.entryCount,
      unknownCount: applicationDefaultAclCertificate.unknownCount,
      target: applicationDefaultAclCertificate.target,
      managedProfile: applicationDefaultAclCertificate.managedProfile
    },
    entries
  };
  manifest.planDigest = sha256(Buffer.from(canonicalSerialize(manifestPayload(manifest)), 'utf8'));
  return manifest;
}

function verifyManagedRestoreManifest(manifest) {
  if (
    manifest?.format !== MANAGED_RESTORE_MANIFEST_FORMAT ||
    manifest?.version !== 1 ||
    manifest?.canonicalization !== MANAGED_RESTORE_CANONICALIZATION ||
    !Array.isArray(manifest?.entries) ||
    manifest.entries.length === 0
  ) {
    throw categoricalError('MANAGED_RESTORE_MANIFEST_INVALID');
  }
  if (new Set(manifest.entries.map((entry) => entry.dumpId)).size !== manifest.entries.length) {
    throw categoricalError('MANAGED_RESTORE_MANIFEST_INVALID');
  }
  for (const entry of manifest.entries) {
    if (
      !Object.values(MANAGED_RESTORE_CATEGORIES).includes(entry.category) ||
      !MANAGED_RESTORE_ACTIONS.includes(entry.action) ||
      entry.category === MANAGED_RESTORE_CATEGORIES.H ||
      !String(entry.reason || '').trim()
    ) {
      throw categoricalError('MANAGED_RESTORE_MANIFEST_INVALID');
    }
  }
  if (manifest.applicationAclConvergence != null) {
    const acl = manifest.applicationAclConvergence;
    if (
      acl?.format !== APPLICATION_ACL_CONTRACT_FORMAT ||
      !/^sha256:[a-f0-9]{64}$/.test(String(acl?.contractDigest || '')) ||
      !/^sha256:[a-f0-9]{64}$/.test(String(acl?.objectDigest || '')) ||
      !/^sha256:[a-f0-9]{64}$/.test(String(acl?.grantDigest || '')) ||
      !Number.isSafeInteger(acl?.objectCount) || acl.objectCount < 1 ||
      !Number.isSafeInteger(acl?.grantCount) || acl.grantCount < 0
    ) {
      throw categoricalError('MANAGED_RESTORE_ACL_CONVERGENCE_INVALID');
    }
  }
  if (manifest.applicationDefaultAclPreservation != null) {
    const defaults = manifest.applicationDefaultAclPreservation;
    if (
      defaults?.format !== APPLICATION_DEFAULT_ACL_MANIFEST_FORMAT ||
      !/^sha256:[a-f0-9]{64}$/.test(String(defaults?.beforeDigest || '')) ||
      defaults.expectedAfterDigest !== defaults.beforeDigest ||
      !/^sha256:[a-f0-9]{64}$/.test(String(defaults?.planDigest || '')) ||
      !Number.isSafeInteger(defaults?.entryCount) || defaults.entryCount < 1 ||
      defaults?.unknownCount !== 0 ||
      !['dev', 'sandbox'].includes(defaults?.target?.environment) ||
      !/^[a-z0-9]{20}$/.test(String(defaults?.target?.projectRef || '')) ||
      !/^[a-z][a-z0-9._-]{2,95}$/.test(String(defaults?.managedProfile?.profileId || '')) ||
      !/^sha256:[a-f0-9]{64}$/.test(String(defaults?.managedProfile?.profileDigest || ''))
    ) {
      throw categoricalError('MANAGED_RESTORE_DEFAULT_ACL_PRESERVATION_INVALID');
    }
  }
  const expected = sha256(Buffer.from(canonicalSerialize(manifestPayload(manifest)), 'utf8'));
  if (manifest.planDigest !== expected) throw categoricalError('MANAGED_RESTORE_MANIFEST_DIGEST_MISMATCH');
  return true;
}

function restoreListFromManifest(tocText, manifest, actions, predicate = () => true) {
  verifyManagedRestoreManifest(manifest);
  const allowed = new Set(actions);
  const selectedIds = new Set(
    manifest.entries
      .filter((entry) => allowed.has(entry.action) && predicate(entry))
      .map((entry) => entry.dumpId)
  );
  const selected = parsePgRestoreList(tocText).filter((entry) => selectedIds.has(entry.dumpId));
  if (selected.length !== selectedIds.size) throw categoricalError('MANAGED_RESTORE_LIST_COVERAGE_MISMATCH');
  return `${selected.map((entry) => entry.rawLine).join('\n')}\n`;
}

function applicationRestoreList(tocText, manifest) {
  return restoreListFromManifest(tocText, manifest, ['restore']);
}

function applicationSchemaRestoreList(tocText, manifest) {
  return restoreListFromManifest(
    tocText,
    manifest,
    ['restore'],
    (entry) => isSchemaDescriptor(entry, 'app') || isSchemaDescriptor(entry, 'app_api')
  );
}

function applicationContentRestoreList(tocText, manifest) {
  return restoreListFromManifest(
    tocText,
    manifest,
    ['restore'],
    (entry) => !isSchemaDescriptor(entry, 'app') && !isSchemaDescriptor(entry, 'app_api')
  );
}

function migrationRestoreList(tocText, manifest) {
  return restoreListFromManifest(tocText, manifest, ['recreate-target-locally']);
}

function authTransformEntries(manifest) {
  verifyManagedRestoreManifest(manifest);
  return manifest.entries.filter((entry) => entry.action === 'transform');
}

function normalizeAuthShape(rows = []) {
  return rows.map((row) => ({
    tableName: String(row.table_name || row.tableName || ''),
    ordinalPosition: Number(row.ordinal_position || row.ordinalPosition || 0),
    columnName: String(row.column_name || row.columnName || ''),
    udtName: String(row.udt_name || row.udtName || ''),
    nullable: String(row.is_nullable || row.nullable || ''),
    generated: String(row.is_generated || row.generated || 'NEVER'),
    generationExpression: String(row.generation_expression || row.generationExpression || '')
  }));
}

function assertAuthOverlayCompatibility({ sourceColumns = [], targetColumns = [], targetTriggers = [] } = {}) {
  const source = normalizeAuthShape(sourceColumns);
  const target = normalizeAuthShape(targetColumns);
  if (canonicalSerialize(source) !== canonicalSerialize(target)) {
    throw categoricalError('MANAGED_AUTH_COLUMN_SHAPE_MISMATCH');
  }
  const expectedCopyColumns = new Map([
    ['users', AUTH_USERS_COPY_COLUMNS],
    ['identities', AUTH_IDENTITIES_COPY_COLUMNS]
  ]);
  for (const [tableName, expected] of expectedCopyColumns) {
    const actual = target
      .filter((column) => column.tableName === tableName && column.generated !== 'ALWAYS')
      .map((column) => column.columnName);
    if (canonicalSerialize(actual) !== canonicalSerialize(expected)) {
      throw categoricalError('MANAGED_AUTH_COPY_COLUMNS_UNREVIEWED');
    }
  }
  if (targetTriggers.length !== 0) throw categoricalError('MANAGED_AUTH_TRIGGER_SHAPE_UNREVIEWED');
  return {
    compatible: true,
    sourceDigest: canonicalDigest(source),
    targetDigest: canonicalDigest(target),
    copiedTables: [...AUTH_OVERLAY_TABLES],
    generatedColumnsOmitted: ['auth.users.confirmed_at', 'auth.identities.email']
  };
}

async function captureManagedTargetCatalog(client) {
  const transaction = (await client.query(
    `select current_setting('transaction_read_only') as transaction_read_only,
            current_user as role_name,
            r.rolsuper,
            pg_catalog.pg_has_role(current_user, 'supabase_admin', 'member') as member_supabase_admin,
            pg_catalog.pg_has_role(current_user, 'supabase_auth_admin', 'member') as member_auth_admin,
            pg_catalog.pg_has_role(current_user, 'supabase_storage_admin', 'member') as member_storage_admin,
            pg_catalog.pg_has_role(current_user, 'supabase_realtime_admin', 'member') as member_realtime_admin,
            pg_catalog.has_parameter_privilege(current_user, 'session_replication_role', 'set') as can_set_replication_role,
            pg_catalog.has_schema_privilege(current_user, 'auth', 'usage') as auth_schema_usage,
            pg_catalog.has_table_privilege(current_user, 'auth.users', 'insert,delete') as auth_users_dml,
            pg_catalog.has_table_privilege(current_user, 'auth.identities', 'insert,delete') as auth_identities_dml
       from pg_catalog.pg_roles r
      where r.rolname = current_user`
  )).rows[0];
  const roles = (await client.query(
    `select rolname as role_name, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
            rolcanlogin, rolreplication, rolbypassrls,
            coalesce(rolconfig, array[]::text[]) as rolconfig
       from pg_catalog.pg_roles
      order by rolname`
  )).rows;
  const schemas = (await client.query(
    `select n.nspname as schema_name, r.rolname as owner_role
       from pg_catalog.pg_namespace n
       join pg_catalog.pg_roles r on r.oid = n.nspowner
      where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
        and n.nspname <> all(array['app','app_api'])
      order by n.nspname`
  )).rows;
  const authOwners = (await client.query(
    `select distinct owner_role from (
       select r.rolname as owner_role
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         join pg_catalog.pg_roles r on r.oid = c.relowner
        where n.nspname = 'auth'
       union all
       select r.rolname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         join pg_catalog.pg_roles r on r.oid = p.proowner
        where n.nspname = 'auth'
     ) owners order by owner_role`
  )).rows;
  const extensions = (await client.query(
    `select e.extname as extension_name, n.nspname as schema_name,
            owner.rolname as owner_role, e.extversion as extension_version
       from pg_catalog.pg_extension e
       join pg_catalog.pg_namespace n on n.oid = e.extnamespace
       join pg_catalog.pg_roles owner on owner.oid = e.extowner
      order by e.extname`
  )).rows;
  const publications = (await client.query(
    `select publication.pubname as publication_name, owner.rolname as owner_role,
            publication.puballtables as all_tables,
            publication.pubinsert as insert_enabled,
            publication.pubupdate as update_enabled,
            publication.pubdelete as delete_enabled,
            publication.pubtruncate as truncate_enabled,
            publication.pubviaroot as via_root
       from pg_catalog.pg_publication publication
       join pg_catalog.pg_roles owner on owner.oid = publication.pubowner
      order by pubname`
  )).rows;
  const publicationRelations = (await client.query(
    `select publication.pubname as publication_name,
            namespace.nspname as schema_name, relation.relname as relation_name
       from pg_catalog.pg_publication_rel membership
       join pg_catalog.pg_publication publication on publication.oid = membership.prpubid
       join pg_catalog.pg_class relation on relation.oid = membership.prrelid
       join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname !~ '^pg_' and namespace.nspname <> 'information_schema'
        and namespace.nspname <> all(array['app','app_api','public','supabase_migrations'])
      order by publication_name, schema_name, relation_name`
  )).rows;
  const defaultAcls = (await client.query(
    `select owner.rolname as owner_role,
            coalesce(namespace.nspname, '') as schema_name,
            defaults.defaclobjtype as object_type,
            grantor.rolname as grantor_role,
            coalesce(grantee.rolname, 'PUBLIC') as grantee,
            acl.privilege_type, acl.is_grantable
       from pg_catalog.pg_default_acl defaults
       join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
       left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
       cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
       join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
       left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
      order by owner_role, schema_name, object_type, grantor_role, grantee,
               privilege_type, is_grantable`
  )).rows;
  const memberships = (await client.query(
    `select member.rolname as member_role, granted.rolname as granted_role,
            grantor.rolname as grantor_role, membership.admin_option,
            membership.inherit_option, membership.set_option
       from pg_catalog.pg_auth_members membership
       join pg_catalog.pg_roles member on member.oid = membership.member
       join pg_catalog.pg_roles granted on granted.oid = membership.roleid
       join pg_catalog.pg_roles grantor on grantor.oid = membership.grantor
      order by member_role, granted_role, grantor_role`
  )).rows;
  const schemaAcls = (await client.query(
    `select namespace.nspname as schema_name, owner.rolname as owner_role,
            grantor.rolname as grantor_role,
            coalesce(grantee.rolname, 'PUBLIC') as grantee,
            acl.privilege_type, acl.is_grantable
       from pg_catalog.pg_namespace namespace
       join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
       cross join lateral pg_catalog.aclexplode(
         coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
       ) acl
       join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
       left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
      where namespace.nspname !~ '^pg_' and namespace.nspname <> 'information_schema'
        and namespace.nspname <> all(array['app','app_api'])
      order by schema_name, owner_role, grantor_role, grantee, privilege_type, is_grantable`
  )).rows;
  const managedObjects = (await client.query(
    `select namespace.nspname as schema_name,
            'relation:' || relation.relkind::text as object_type,
            relation.relname as object_identity, owner.rolname as owner_role
       from pg_catalog.pg_class relation
       join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
       join pg_catalog.pg_roles owner on owner.oid = relation.relowner
      where namespace.nspname !~ '^pg_' and namespace.nspname <> 'information_schema'
        and namespace.nspname <> all(array['app','app_api','public','supabase_migrations'])
      union
     select namespace.nspname, 'routine:' || routine.prokind::text,
            routine.proname || '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')',
            owner.rolname
       from pg_catalog.pg_proc routine
       join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
       join pg_catalog.pg_roles owner on owner.oid = routine.proowner
      where namespace.nspname !~ '^pg_' and namespace.nspname <> 'information_schema'
        and namespace.nspname <> all(array['app','app_api','public','supabase_migrations'])
      union
     select namespace.nspname, 'type:' || type.typtype::text,
            type.typname, owner.rolname
       from pg_catalog.pg_type type
       join pg_catalog.pg_namespace namespace on namespace.oid = type.typnamespace
       join pg_catalog.pg_roles owner on owner.oid = type.typowner
      where namespace.nspname !~ '^pg_' and namespace.nspname <> 'information_schema'
        and namespace.nspname <> all(array['app','app_api','public','supabase_migrations'])
      order by schema_name, object_type, object_identity, owner_role`
  )).rows;
  const managedObjectAcls = (await client.query(
    `select namespace.nspname as schema_name,
            'relation:' || relation.relkind::text as object_type,
            relation.relname as object_identity, owner.rolname as owner_role,
            grantor.rolname as grantor_role, coalesce(grantee.rolname, 'PUBLIC') as grantee,
            acl.privilege_type, acl.is_grantable
       from pg_catalog.pg_class relation
       join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
       join pg_catalog.pg_roles owner on owner.oid = relation.relowner
       cross join lateral pg_catalog.aclexplode(coalesce(
         relation.relacl,
         pg_catalog.acldefault(
           case when relation.relkind = 'S' then 'S'::\"char\" else 'r'::\"char\" end,
           relation.relowner
         )
       )) acl
       join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
       left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
      where relation.relkind = any(array['r','p','v','m','S','f']::\"char\"[])
        and namespace.nspname !~ '^pg_' and namespace.nspname <> 'information_schema'
        and namespace.nspname <> all(array['app','app_api','public','supabase_migrations'])
      union
     select namespace.nspname, 'routine:' || routine.prokind::text,
            routine.proname || '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')',
            owner.rolname, grantor.rolname, coalesce(grantee.rolname, 'PUBLIC'),
            acl.privilege_type, acl.is_grantable
       from pg_catalog.pg_proc routine
       join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
       join pg_catalog.pg_roles owner on owner.oid = routine.proowner
       cross join lateral pg_catalog.aclexplode(coalesce(
         routine.proacl, pg_catalog.acldefault('f', routine.proowner)
       )) acl
       join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
       left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
      where namespace.nspname !~ '^pg_' and namespace.nspname <> 'information_schema'
        and namespace.nspname <> all(array['app','app_api','public','supabase_migrations'])
      union
     select namespace.nspname, 'type:' || type.typtype::text, type.typname,
            owner.rolname, grantor.rolname, coalesce(grantee.rolname, 'PUBLIC'),
            acl.privilege_type, acl.is_grantable
       from pg_catalog.pg_type type
       join pg_catalog.pg_namespace namespace on namespace.oid = type.typnamespace
       join pg_catalog.pg_roles owner on owner.oid = type.typowner
       cross join lateral pg_catalog.aclexplode(coalesce(
         type.typacl, pg_catalog.acldefault('T', type.typowner)
       )) acl
       join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
       left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
      where namespace.nspname !~ '^pg_' and namespace.nspname <> 'information_schema'
        and namespace.nspname <> all(array['app','app_api','public','supabase_migrations'])
      order by schema_name, object_type, object_identity, owner_role, grantor_role,
               grantee, privilege_type, is_grantable`
  )).rows;
  const roleCapabilities = (await client.query(
    `select role.rolname as role_name,
            pg_catalog.has_schema_privilege(role.oid, namespace.oid, 'USAGE') as public_usage,
            pg_catalog.has_schema_privilege(role.oid, namespace.oid, 'CREATE') as public_create,
            pg_catalog.pg_has_role(role.oid, namespace.nspowner, 'MEMBER') as public_owner_member
       from pg_catalog.pg_roles role
       cross join pg_catalog.pg_namespace namespace
      where namespace.nspname = 'public'
      order by role.rolname`
  )).rows;
  return {
    transaction,
    roles,
    schemas,
    authOwners,
    extensions,
    publications,
    publicationRelations,
    defaultAcls,
    memberships,
    schemaAcls,
    managedObjects,
    managedObjectAcls,
    roleCapabilities
  };
}

async function captureApplicationReplacementCatalog(client) {
  const schemas = (await client.query(
    `select n.nspname as schema_name, r.rolname as owner_role
       from pg_catalog.pg_namespace n
       join pg_catalog.pg_roles r on r.oid = n.nspowner
      where n.nspname = any(array['app','app_api'])
      order by n.nspname`
  )).rows;
  const publicRoutines = (await client.query(
    `select p.prokind, p.proname as routine_name,
            pg_catalog.oidvectortypes(p.proargtypes) as arguments
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       join pg_catalog.pg_roles r on r.oid = p.proowner
      where n.nspname = 'public' and r.rolname = 'postgres'
      order by p.prokind, p.proname, pg_catalog.oidvectortypes(p.proargtypes)`
  )).rows;
  const external = (await client.query(
    `with app_relations as (
       select c.oid from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(array['app','app_api'])
     ), app_routines as (
       select p.oid from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = any(array['app','app_api'])
     )
     select
       (select count(*)::bigint
          from pg_catalog.pg_constraint con
          join app_relations referenced on referenced.oid = con.confrelid
          join pg_catalog.pg_namespace owner_namespace on owner_namespace.oid = con.connamespace
         where owner_namespace.nspname <> all(array['app','app_api'])) as foreign_keys,
       (select count(distinct rewrite.oid)::bigint
          from pg_catalog.pg_depend dependency
          join app_relations referenced
            on dependency.refclassid = 'pg_catalog.pg_class'::regclass
           and dependency.refobjid = referenced.oid
          join pg_catalog.pg_rewrite rewrite
            on dependency.classid = 'pg_catalog.pg_rewrite'::regclass
           and dependency.objid = rewrite.oid
          join pg_catalog.pg_class dependent_relation on dependent_relation.oid = rewrite.ev_class
          join pg_catalog.pg_namespace dependent_namespace on dependent_namespace.oid = dependent_relation.relnamespace
         where dependent_namespace.nspname <> all(array['app','app_api'])) as views,
       (select count(distinct trigger.oid)::bigint
          from pg_catalog.pg_depend dependency
          join app_routines referenced
            on dependency.refclassid = 'pg_catalog.pg_proc'::regclass
           and dependency.refobjid = referenced.oid
          join pg_catalog.pg_trigger trigger
            on dependency.classid = 'pg_catalog.pg_trigger'::regclass
           and dependency.objid = trigger.oid
          join pg_catalog.pg_class dependent_relation on dependent_relation.oid = trigger.tgrelid
          join pg_catalog.pg_namespace dependent_namespace on dependent_namespace.oid = dependent_relation.relnamespace
         where dependent_namespace.nspname <> all(array['app','app_api'])) as triggers,
       (select count(distinct policy.oid)::bigint
          from pg_catalog.pg_depend dependency
          join app_routines referenced
            on dependency.refclassid = 'pg_catalog.pg_proc'::regclass
           and dependency.refobjid = referenced.oid
          join pg_catalog.pg_policy policy
            on dependency.classid = 'pg_catalog.pg_policy'::regclass
           and dependency.objid = policy.oid
          join pg_catalog.pg_class dependent_relation on dependent_relation.oid = policy.polrelid
          join pg_catalog.pg_namespace dependent_namespace on dependent_namespace.oid = dependent_relation.relnamespace
         where dependent_namespace.nspname <> all(array['app','app_api'])) as policies`
  )).rows[0];
  return { schemas, publicRoutines, external };
}

function assertApplicationReplacementCompatibility(manifest, evidence = {}) {
  verifyManagedRestoreManifest(manifest);
  if ((evidence.schemas || []).some((row) => row.owner_role !== 'postgres')) {
    throw categoricalError('MANAGED_APPLICATION_TARGET_OWNER_INCOMPATIBLE');
  }
  const expectedPublicRoutines = new Set(
    manifest.entries
      .filter(
        (entry) =>
          entry.schema === 'public' &&
          entry.action === 'restore' &&
          ['FUNCTION', 'PROCEDURE'].includes(entry.objectType)
      )
      .map((entry) => `${entry.objectType === 'PROCEDURE' ? 'p' : 'f'}:${entry.name}`)
  );
  const targetPublicRoutines = (evidence.publicRoutines || []).map(
    (row) => `${row.prokind}:${row.routine_name}(${row.arguments})`
  );
  if (targetPublicRoutines.some((identity) => !expectedPublicRoutines.has(identity))) {
    throw categoricalError('MANAGED_APPLICATION_TARGET_PUBLIC_ROUTINE_UNREVIEWED');
  }
  const external = evidence.external || {};
  if (['foreign_keys', 'views', 'triggers', 'policies'].some((key) => safeCount(external[key]) !== 0)) {
    throw categoricalError('MANAGED_APPLICATION_EXTERNAL_DEPENDENCY_REJECTED');
  }
  return {
    compatible: true,
    replacementDigest: canonicalDigest(evidence),
    existingApplicationSchemas: (evidence.schemas || []).length,
    reviewedPublicRoutines: targetPublicRoutines.length,
    externalDependencyCount: 0
  };
}

function assertManagedTargetCatalogCompatibility(evidence = {}, managedProfile = {}) {
  const transaction = evidence.transaction || {};
  if (
    !Array.isArray(evidence.defaultAcls) ||
    !Array.isArray(evidence.memberships) ||
    !Array.isArray(evidence.schemaAcls) ||
    !Array.isArray(evidence.managedObjects) ||
    !Array.isArray(evidence.managedObjectAcls) ||
    !Array.isArray(evidence.roleCapabilities)
  ) {
    throw categoricalError('MANAGED_TARGET_SECURITY_CATALOG_INCOMPATIBLE');
  }
  if (
    transaction.transaction_read_only !== 'on' ||
    transaction.role_name !== 'postgres' ||
    transaction.rolsuper !== false ||
    transaction.member_supabase_admin !== false ||
    transaction.member_auth_admin !== false ||
    transaction.member_storage_admin !== false ||
    transaction.member_realtime_admin !== false ||
    transaction.can_set_replication_role !== false ||
    transaction.auth_schema_usage !== true ||
    transaction.auth_users_dml !== true ||
    transaction.auth_identities_dml !== true
  ) {
    throw categoricalError('MANAGED_TARGET_EXECUTION_ROLE_INCOMPATIBLE');
  }
  const roleNames = new Set((evidence.roles || []).map((row) => row.role_name));
  if (REQUIRED_MANAGED_ROLES.some((roleName) => !roleNames.has(roleName))) {
    throw categoricalError('MANAGED_TARGET_ROLE_SET_INCOMPATIBLE');
  }
  const schemaOwners = new Map((evidence.schemas || []).map((row) => [row.schema_name, row.owner_role]));
  if (TARGET_NATIVE_SCHEMAS.some((schemaName) => !schemaOwners.has(schemaName))) {
    throw categoricalError('MANAGED_TARGET_SCHEMA_SET_INCOMPATIBLE');
  }
  const authOwners = [...new Set((evidence.authOwners || []).map((row) => row.owner_role))];
  if (authOwners.length !== 1 || authOwners[0] !== 'supabase_auth_admin') {
    throw categoricalError('MANAGED_TARGET_AUTH_OWNERSHIP_INCOMPATIBLE');
  }
  const extensions = new Map(
    (evidence.extensions || []).map((row) => [row.extension_name, row.schema_name])
  );
  if (REQUIRED_TARGET_EXTENSIONS.some((extensionName) => extensions.get(extensionName) !== 'extensions')) {
    throw categoricalError('MANAGED_TARGET_EXTENSION_PLANE_INCOMPATIBLE');
  }
  if (
    (evidence.publications || []).length !== 1 ||
    evidence.publications[0]?.publication_name !== 'supabase_realtime'
  ) {
    throw categoricalError('MANAGED_TARGET_PUBLICATION_PLANE_INCOMPATIBLE');
  }
  const profile = verifyManagedProfileCertificate({
    certificate: managedProfile.certificate,
    key: managedProfile.key,
    target: managedProfile.target,
    evidence: managedProfileEvidenceFromCatalog(evidence),
    expectedProfileId: managedProfile.expectedProfileId
  });
  const applicationDefaultAclEntries = normalizeApplicationDefaultAclEntries(
    evidence.defaultAcls.filter((row) => ['app', 'app_api'].includes(row.schema_name))
  );
  return {
    compatible: true,
    authenticated: profile.authenticated,
    catalogDigest: profile.profileDigest,
    profileDigest: profile.profileDigest,
    profileId: profile.profileId,
    profileTarget: profile.target,
    securityDigest: profile.securityDigest,
    security: profile.security,
    transactionReadOnly: true,
    executionRole: 'postgres',
    requiredRoles: [...REQUIRED_MANAGED_ROLES],
    requiredSchemas: [...TARGET_NATIVE_SCHEMAS],
    managedSchemaCount: (evidence.schemas || []).length,
    defaultAclCount: evidence.defaultAcls.length,
    applicationDefaultAclEntries,
    membershipCount: evidence.memberships.length
  };
}

function assertManagedCompatibilityProof({
  authCompatibility,
  targetCatalog,
  applicationReplacement,
  applicationDefaultAcl
} = {}) {
  if (
    authCompatibility?.compatible !== true ||
    authCompatibility?.sourceDigest !== authCompatibility?.targetDigest ||
    !/^sha256:[a-f0-9]{64}$/.test(String(authCompatibility?.targetDigest || '')) ||
    canonicalSerialize(authCompatibility?.copiedTables) !== canonicalSerialize(AUTH_OVERLAY_TABLES) ||
    targetCatalog?.compatible !== true ||
    targetCatalog?.authenticated !== true ||
    targetCatalog?.transactionReadOnly !== true ||
    !/^sha256:[a-f0-9]{64}$/.test(String(targetCatalog?.catalogDigest || '')) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(targetCatalog?.securityDigest || '')) ||
    !/^[a-z][a-z0-9._-]{2,95}$/.test(String(targetCatalog?.profileId || '')) ||
    !['dev', 'sandbox'].includes(targetCatalog?.profileTarget?.environment) ||
    !/^[a-z0-9]{20}$/.test(String(targetCatalog?.profileTarget?.projectRef || '')) ||
    applicationDefaultAcl?.authenticated !== true ||
    applicationDefaultAcl?.entryCount < 1 ||
    applicationDefaultAcl?.beforeDigest !== applicationDefaultAcl?.expectedAfterDigest ||
    applicationDefaultAcl?.target?.environment !== targetCatalog?.profileTarget?.environment ||
    applicationDefaultAcl?.target?.projectRef !== targetCatalog?.profileTarget?.projectRef ||
    applicationDefaultAcl?.managedProfile?.profileId !== targetCatalog?.profileId ||
    applicationDefaultAcl?.managedProfile?.profileDigest !== targetCatalog?.profileDigest ||
    applicationReplacement?.compatible !== true ||
    applicationReplacement?.externalDependencyCount !== 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(String(applicationReplacement?.replacementDigest || ''))
  ) {
    throw categoricalError('MANAGED_TARGET_COMPATIBILITY_PROOF_INVALID');
  }
  return {
    authShapeDigest: authCompatibility.targetDigest,
    catalogDigest: targetCatalog.catalogDigest,
    managedProfileDigest: targetCatalog.profileDigest,
    managedProfileId: targetCatalog.profileId,
    managedProfileTarget: targetCatalog.profileTarget,
    managedProfileSecurityDigest: targetCatalog.securityDigest,
    applicationDefaultAclDigest: applicationDefaultAcl.beforeDigest,
    applicationDefaultAclPlanDigest: applicationDefaultAcl.planDigest,
    applicationDefaultAclEntryCount: applicationDefaultAcl.entryCount,
    applicationReplacementDigest: applicationReplacement.replacementDigest,
    copiedAuthTables: [...AUTH_OVERLAY_TABLES],
    transactionReadOnly: true
  };
}

async function captureAuthOverlaySourceEvidence(client) {
  const counts = (await client.query(
    `select
       (select count(*)::bigint from auth.users) as users,
       (select count(*)::bigint from auth.identities) as identities,
       (select count(*)::bigint from auth.users
         where email !~ '^[a-z0-9-]+@users\\.invalid$'
            or phone is not null or phone_change <> ''
            or encrypted_password <> '!x-np-disabled-v1!'
            or banned_until <> 'infinity'::timestamptz
            or confirmation_token <> '' or recovery_token <> ''
            or email_change_token_new <> '' or email_change_token_current <> ''
            or reauthentication_token <> '') as unsafe_users,
       (select count(*)::bigint from auth.identities i
          join auth.users u on u.id = i.user_id
         where i.provider <> 'email' or i.provider_id <> u.email
            or i.identity_data->>'email' <> u.email
            or coalesce((i.identity_data->>'x_np_quarantined')::boolean, false) is not true) as unsafe_identities,
       (select count(*)::bigint from auth.identities i
          left join auth.users u on u.id = i.user_id where u.id is null) as dangling_identities`
  )).rows[0];
  const ephemera = {};
  for (const tableName of AUTH_PURGE_ORDER) {
    const result = await client.query(`select count(*)::bigint as count from auth."${tableName}"`);
    ephemera[tableName] = safeCount(result.rows[0]?.count);
  }
  const result = {
    users: safeCount(counts?.users),
    identities: safeCount(counts?.identities),
    unsafeUsers: safeCount(counts?.unsafe_users),
    unsafeIdentities: safeCount(counts?.unsafe_identities),
    danglingIdentities: safeCount(counts?.dangling_identities),
    ephemera
  };
  if (
    result.unsafeUsers !== 0 ||
    result.unsafeIdentities !== 0 ||
    result.danglingIdentities !== 0 ||
    Object.values(ephemera).some((count) => count !== 0)
  ) {
    throw categoricalError('MANAGED_AUTH_SOURCE_NOT_QUARANTINED');
  }
  return result;
}

function buildAuthOverlayPurgeSql({ exactRecovery = false, preserveAuth = false } = {}) {
  const reviewedTables = new Set([...AUTH_PURGE_ORDER, ...AUTH_OVERLAY_TABLES, ...AUTH_PRESERVED_TABLES]);
  if (
    reviewedTables.size !== CURRENT_AUTH_TABLES.length ||
    CURRENT_AUTH_TABLES.some((tableName) => !reviewedTables.has(tableName))
  ) {
    throw categoricalError('MANAGED_AUTH_TABLE_SHAPE_UNREVIEWED');
  }
  if (preserveAuth) return 'select 1 as managed_auth_preserved;';
  return [
    ...AUTH_PURGE_ORDER.map((tableName) => `delete from auth."${tableName}";`),
    'delete from auth.identities;',
    'delete from auth.users;',
    ...(exactRecovery ? [
      'delete from auth.instances;',
      'delete from auth.schema_migrations;'
    ] : [])
  ].join('\n');
}

function assertChunkBoundary(sql, kind) {
  const text = String(sql || '');
  if (!text.trim()) throw categoricalError(`MANAGED_RESTORE_${kind}_EMPTY`);
  if (/^(?:BEGIN|START TRANSACTION|COMMIT|ROLLBACK)\s*;/gim.test(text)) {
    throw categoricalError('MANAGED_RESTORE_NESTED_TRANSACTION_REJECTED');
  }
  if (/^\s*(?:CREATE|ALTER|DROP)\s+ROLE\b/gim.test(text) || /cli_login_postgres/i.test(text)) {
    throw categoricalError('MANAGED_RESTORE_ROLE_STATEMENT_REJECTED');
  }
  return text;
}

function assertApplicationChunk(sql) {
  const text = assertChunkBoundary(sql, 'APPLICATION_CHUNK');
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim();
    if (
      /^(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:SCHEMA|TABLE|SEQUENCE|TYPE|FUNCTION|PROCEDURE|VIEW|MATERIALIZED VIEW)\b.*\bauth\b/i.test(normalized) ||
      /^COPY\s+auth\./i.test(normalized) ||
      /^DROP SCHEMA\b.*\bpublic\b/i.test(normalized) ||
      /^ALTER DEFAULT PRIVILEGES\b.*\b(?:supabase_admin|supabase_auth_admin)\b/i.test(normalized)
    ) {
      throw categoricalError('MANAGED_RESTORE_MANAGED_PLANE_MUTATION_REJECTED');
    }
  }
  return text;
}

function buildApplicationPlaneResetSql(manifest) {
  verifyManagedRestoreManifest(manifest);
  const routines = manifest.entries.filter(
    (entry) =>
      entry.schema === 'public' &&
      entry.action === 'restore' &&
      ['FUNCTION', 'PROCEDURE'].includes(entry.objectType)
  );
  const drops = routines.map((entry) => {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*\([A-Za-z0-9_., ()\[\]"]*\)$/.test(entry.name) ||
      /(?:--|\/\*|\*\/|;)/.test(entry.name)
    ) {
      throw categoricalError('MANAGED_APPLICATION_ROUTINE_IDENTITY_UNREVIEWED');
    }
    return `DROP ${entry.objectType} IF EXISTS public.${entry.name};`;
  });
  return `do $managed_application_owner_guard$
begin
  if exists (
    select 1
      from pg_catalog.pg_namespace n
      join pg_catalog.pg_roles r on r.oid = n.nspowner
     where n.nspname = any(array['app','app_api'])
       and r.rolname <> current_user
  ) then raise exception 'MANAGED_APPLICATION_SCHEMA_OWNER_MISMATCH'; end if;
end
$managed_application_owner_guard$;
DROP SCHEMA IF EXISTS app_api CASCADE;
DROP SCHEMA IF EXISTS app CASCADE;
${drops.join('\n')}`;
}

function assertAuthDataChunk(sql, tableName) {
  const text = assertChunkBoundary(sql, 'AUTH_DATA_CHUNK');
  const otherTable = tableName === 'users' ? 'identities' : 'users';
  if (
    !new RegExp(`\\bauth\\.${tableName}\\b`, 'i').test(text) ||
    new RegExp(`\\bauth\\.${otherTable}\\b`, 'i').test(text) ||
    /session_replication_role/i.test(text) ||
    /@(?!(?:users\.invalid)\b)[A-Za-z0-9.-]+/i.test(text)
  ) {
    throw categoricalError('MANAGED_AUTH_DATA_CHUNK_REJECTED');
  }
  return text;
}

function assertExactAuthRecoveryDataChunk(sql) {
  const text = assertChunkBoundary(sql, 'AUTH_RECOVERY_DATA_CHUNK');
  if (
    /session_replication_role/i.test(text) ||
    /^(?:CREATE|ALTER|DROP|TRUNCATE|DELETE|UPDATE)\b/gim.test(text) ||
    /^COPY\s+/gim.test(text)
  ) {
    throw categoricalError('DEV_Y2_AUTH_RECOVERY_DATA_CHUNK_REJECTED');
  }
  const insertTargets = [...text.matchAll(/^INSERT INTO auth\."?([a-z0-9_]+)"?\b/gim)]
    .map((match) => match[1]);
  if (
    insertTargets.some((tableName) => !CURRENT_AUTH_TABLES.includes(tableName)) ||
    [...text.matchAll(/^INSERT INTO\s+([^\s(]+)/gim)].length !== insertTargets.length
  ) {
    throw categoricalError('DEV_Y2_AUTH_RECOVERY_DATA_CHUNK_REJECTED');
  }
  return text;
}

function exactAuthRecoveryAssertions(authority, tableNames = CURRENT_AUTH_TABLES) {
  const selected = new Set(tableNames);
  return authority.authEvidence.tables.filter((entry) => selected.has(entry.tableName)).map((entry) => `
  select count(*)::bigint,
         'sha256:' || encode(extensions.digest(
           convert_to(coalesce(string_agg(pg_catalog.to_jsonb(t)::text, E'\\n'
             order by pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), ''), 'UTF8'),
           'sha256'
         ), 'hex')
    into v_auth_count, v_auth_digest
    from auth."${entry.tableName}" t;
  if v_auth_count <> ${entry.count} or v_auth_digest <> '${entry.digest}' then
    raise exception 'DEV_Y2_AUTH_RECOVERY_POSTCHECK_MISMATCH';
  end if;`).join('\n');
}

function authPreservationAssertions(authority) {
  const classifications = Object.entries(AUTH_RECOVERY_TABLE_CLASSIFICATION);
  if (
    classifications.length !== CURRENT_AUTH_TABLES.length ||
    CURRENT_AUTH_TABLES.some((tableName) => !AUTH_RECOVERY_TABLE_CLASSIFICATION[tableName]) ||
    classifications.some(([, entry]) => entry.dml !== 'none' || entry.recoveryOwned !== false)
  ) throw categoricalError('DEV_REMEDIATION_AUTH_TABLE_CLASSIFICATION_INVALID');
  const volatileTables = new Set(classifications
    .filter(([, entry]) => entry.state !== 'stable_exact')
    .map(([tableName]) => tableName));
  const table = (tableName) => authority.authEvidence.tables.find((entry) => entry.tableName === tableName);
  const users = table('users');
  const identities = table('identities');
  const sessions = table('sessions');
  const refreshTokens = table('refresh_tokens');
  if (![users, identities, sessions, refreshTokens].every(Boolean)) {
    throw categoricalError('DEV_REMEDIATION_AUTH_PRESERVATION_AUTHORITY_INCOMPLETE');
  }
  return `${exactAuthRecoveryAssertions(
    authority,
    CURRENT_AUTH_TABLES.filter((tableName) => !volatileTables.has(tableName))
  )}
  select count(*)::bigint into v_auth_count from auth.users;
  if v_auth_count <> ${users.count} then
    raise exception 'DEV_REMEDIATION_AUTH_PRESERVATION_COUNT_MISMATCH';
  end if;
  select count(*)::bigint into v_auth_count from auth.identities;
  if v_auth_count <> ${identities.count} then
    raise exception 'DEV_REMEDIATION_AUTH_PRESERVATION_COUNT_MISMATCH';
  end if;
  select count(*)::bigint into v_auth_count from auth.sessions;
  if v_auth_count < ${sessions.count} or v_auth_count > ${sessions.count + 1} then
    raise exception 'DEV_REMEDIATION_AUTH_PRESERVATION_EPHEMERA_MISMATCH';
  end if;
  select count(*)::bigint into v_auth_count from auth.refresh_tokens;
  if v_auth_count < ${refreshTokens.count} or v_auth_count > ${refreshTokens.count + 1} then
    raise exception 'DEV_REMEDIATION_AUTH_PRESERVATION_EPHEMERA_MISMATCH';
  end if;`;
}

function buildVerificationSql({
  authEvidence = {},
  migration = {},
  authMode = 'quarantined-overlay',
  authRecoveryAuthority = null,
  nativePreservation = null
} = {}) {
  const nativeUsers = nativePreservation ? safeCount(nativePreservation.evidence.userCount) : 0;
  const nativeIdentities = nativePreservation ? safeCount(nativePreservation.evidence.identityCount) : 0;
  const users = safeCount(authEvidence.users || 0) + nativeUsers;
  const identities = safeCount(authEvidence.identities || 0) + nativeIdentities;
  const migrationCount = safeCount(migration.count || 0);
  const migrationTip = String(migration.tip || '');
  if (!/^\d{14}$/.test(migrationTip)) throw categoricalError('MANAGED_RESTORE_MIGRATION_TIP_INVALID');
  const ephemeraAssertions = AUTH_PURGE_ORDER.map(
    (tableName) =>
      `if exists (select 1 from auth."${tableName}") then raise exception 'MANAGED_AUTH_EPHEMERA_NOT_EMPTY'; end if;`
  ).join('\n  ');
  const exactRecovery = authMode === DEV_Y2_AUTH_RECOVERY_MODE;
  const preserveAuth = authMode === DEV_REMEDIATION_AUTH_PRESERVATION_MODE;
  if ((exactRecovery || preserveAuth) && !authRecoveryAuthority) {
    throw categoricalError('DEV_Y2_AUTH_RECOVERY_AUTHORITY_REQUIRED');
  }
  return `do $managed_overlay_verify$
declare
  v_users bigint;
  v_identities bigint;
  v_migrations bigint;
  v_tip text;
  v_auth_count bigint;
  v_auth_digest text;
begin
  if to_regnamespace('app') is null or to_regnamespace('app_api') is null then
    raise exception 'MANAGED_APPLICATION_SCHEMA_MISSING';
  end if;
  ${exactRecovery ? exactAuthRecoveryAssertions(authRecoveryAuthority) : preserveAuth
    ? authPreservationAssertions(authRecoveryAuthority) : `select count(*) into v_users from auth.users;
  select count(*) into v_identities from auth.identities;
  if v_users <> ${users} or v_identities <> ${identities} then
    raise exception 'MANAGED_AUTH_COUNT_MISMATCH';
  end if;
  if exists (
    select 1 from auth.users
     where coalesce((raw_user_meta_data->>'x_np_target_native_smoke')::boolean, false) is not true
       and (email !~ '^[a-z0-9-]+@users\\.invalid$'
        or phone is not null or phone_change <> ''
        or encrypted_password <> '!x-np-disabled-v1!'
        or banned_until <> 'infinity'::timestamptz)
  ) then raise exception 'MANAGED_AUTH_QUARANTINE_MISMATCH'; end if;
  if (select count(*) from auth.users
       where coalesce((raw_user_meta_data->>'x_np_target_native_smoke')::boolean, false) is true) <> ${nativeUsers}
  then raise exception 'MANAGED_NATIVE_SMOKE_USER_MISMATCH'; end if;
  if exists (
    select 1 from auth.identities i
    left join auth.users u on u.id = i.user_id
    where u.id is null or i.provider <> 'email' or i.provider_id <> u.email
       or i.identity_data->>'email' <> u.email
       or (
         coalesce((i.identity_data->>'x_np_quarantined')::boolean, false) is not true
         and coalesce((i.identity_data->>'x_np_target_native_smoke')::boolean, false) is not true
       )
  ) then raise exception 'MANAGED_AUTH_IDENTITY_MISMATCH'; end if;
  if (select count(*) from auth.identities
       where coalesce((identity_data->>'x_np_target_native_smoke')::boolean, false) is true) <> ${nativeIdentities}
  then raise exception 'MANAGED_NATIVE_SMOKE_IDENTITY_MISMATCH'; end if;
  ${ephemeraAssertions}`}
  select count(*), max(version) into v_migrations, v_tip
    from supabase_migrations.schema_migrations;
  if v_migrations <> ${migrationCount} or v_tip <> '${migrationTip}' then
    raise exception 'MANAGED_MIGRATION_LEDGER_MISMATCH';
  end if;
end
$managed_overlay_verify$;`;
}

function buildManagedOverlaySql({
  applicationResetSql,
  applicationSchemaSql,
  applicationDefaultAclPreservationSql,
  applicationPreDataSql,
  applicationDataSql,
  applicationPostDataSql,
  applicationAclConvergenceSql,
  applicationDefaultAclVerificationSql,
  authUsersSql,
  authIdentitiesSql,
  authRecoverySql,
  migrationSql,
  authEvidence,
  migration,
  authMode = 'quarantined-overlay',
  authRecoveryAuthority = null,
  nativePreservation = null
} = {}) {
  const exactRecovery = authMode === DEV_Y2_AUTH_RECOVERY_MODE;
  const preserveAuth = authMode === DEV_REMEDIATION_AUTH_PRESERVATION_MODE;
  if (![DEV_Y2_AUTH_RECOVERY_MODE, DEV_REMEDIATION_AUTH_PRESERVATION_MODE, 'quarantined-overlay'].includes(authMode)) {
    throw categoricalError('MANAGED_AUTH_MODE_INVALID');
  }
  const verifiedNativePreservation = nativePreservation
    ? verifyNativeSmokePreservation(nativePreservation)
    : null;
  if (exactRecovery && verifiedNativePreservation) {
    throw categoricalError('DEV_Y2_NATIVE_SMOKE_OVERLAY_REJECTED');
  }
  const chunks = {
    applicationResetSql: assertApplicationChunk(applicationResetSql),
    applicationSchemaSql: assertApplicationChunk(applicationSchemaSql),
    applicationDefaultAclPreservationSql: assertApplicationChunk(applicationDefaultAclPreservationSql),
    applicationPreDataSql: assertApplicationChunk(applicationPreDataSql),
    applicationDataSql: assertApplicationChunk(applicationDataSql),
    applicationPostDataSql: assertApplicationChunk(applicationPostDataSql),
    applicationAclConvergenceSql: assertApplicationChunk(applicationAclConvergenceSql),
    applicationDefaultAclVerificationSql: assertApplicationChunk(applicationDefaultAclVerificationSql),
    authUsersSql: (exactRecovery || preserveAuth) ? '' : assertAuthDataChunk(authUsersSql, 'users'),
    authIdentitiesSql: (exactRecovery || preserveAuth) ? '' : assertAuthDataChunk(authIdentitiesSql, 'identities'),
    authRecoverySql: exactRecovery ? assertExactAuthRecoveryDataChunk(authRecoverySql) : '',
    migrationSql: assertChunkBoundary(migrationSql, 'MIGRATION_CHUNK')
  };
  for (const line of chunks.migrationSql.split(/\r?\n/)) {
    const normalized = line.trim();
    if (
      /^(?:CREATE|ALTER|DROP|TRUNCATE|DELETE FROM|INSERT INTO|COPY)\b/i.test(normalized) &&
      !/\bsupabase_migrations\./i.test(normalized) &&
      !/^CREATE SCHEMA\b.*\bsupabase_migrations\b/i.test(normalized) &&
      !/^DROP SCHEMA\b.*\bsupabase_migrations\b/i.test(normalized)
    ) {
      throw categoricalError('MANAGED_RESTORE_MIGRATION_CHUNK_REJECTED');
    }
  }
  const verification = buildVerificationSql({
    authEvidence,
    migration,
    authMode,
    authRecoveryAuthority,
    nativePreservation: verifiedNativePreservation
  });
  return `\\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL statement_timeout = 0;
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_RESET
${chunks.applicationResetSql}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_SCHEMA
${chunks.applicationSchemaSql}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_DEFAULT_ACL_PRESERVATION
${chunks.applicationDefaultAclPreservationSql}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_DEFINITION
${chunks.applicationPreDataSql}
\\echo MANAGED_OVERLAY_STAGE_AUTH_PURGE
${buildAuthOverlayPurgeSql({ exactRecovery, preserveAuth })}
${preserveAuth ? '\\echo MANAGED_OVERLAY_STAGE_AUTH_PRESERVED' : exactRecovery ? `\\echo MANAGED_OVERLAY_STAGE_AUTH_EXACT_RECOVERY
${chunks.authRecoverySql}` : `\\echo MANAGED_OVERLAY_STAGE_AUTH_USERS
${chunks.authUsersSql}
\\echo MANAGED_OVERLAY_STAGE_AUTH_IDENTITIES
${chunks.authIdentitiesSql}`}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_DATA
${chunks.applicationDataSql}
${verifiedNativePreservation ? `\\echo MANAGED_OVERLAY_STAGE_NATIVE_SMOKE_PRESERVATION
${verifiedNativePreservation.sql}` : ''}
\\echo MANAGED_OVERLAY_STAGE_MIGRATION_LEDGER
${chunks.migrationSql}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_POST_DATA
${chunks.applicationPostDataSql}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_ACL_CONVERGENCE
${chunks.applicationAclConvergenceSql}
\\echo MANAGED_OVERLAY_STAGE_APPLICATION_DEFAULT_ACL_FINAL_VERIFY
${chunks.applicationDefaultAclVerificationSql}
\\echo MANAGED_OVERLAY_STAGE_VERIFY
${verification}
COMMIT;
`;
}

function privateGeneratedText(executable, args, env = {}) {
  try {
    return execFileSync(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
      maxBuffer: 256 * 1024 * 1024
    });
  } catch {
    throw categoricalError('MANAGED_RESTORE_PACKAGE_GENERATION_FAILED');
  }
}

function normalizeGeneratedSql(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw categoricalError('MANAGED_RESTORE_GENERATED_SQL_ENCODING_INVALID');
  }
  return text.replaceAll('\r\n', '\n');
}

function canonicalizePsqlRestrictionTokens(text) {
  return String(text || '').replace(
    /^(\\(?:un)?restrict)[ \t]+\S+[ \t]*$/gm,
    '$1 <private-random-token>'
  );
}

function writePrivateGeneratedFile(filePath, bytes) {
  try {
    writePrivateBytesExclusive(filePath, bytes);
    verifyPrivateArtifactProtection(filePath);
  } finally {
    bytes.fill(0);
  }
}

function generatePgRestoreChunk({ pgRestorePath, archivePath, listPath, section = '', clean = false }) {
  const args = [
    '--exit-on-error',
    '--no-owner',
    '--use-list', listPath,
    ...(section ? ['--section', section] : []),
    ...(clean ? ['--clean', '--if-exists'] : []),
    '--file=-',
    archivePath
  ];
  return privateGeneratedText(pgRestorePath, args);
}

function generateAuthDataChunk({ pgDumpPath, sourceConnectionString, tableName }) {
  return privateGeneratedText(
    pgDumpPath,
    [
      '--data-only',
      '--column-inserts',
      '--no-owner',
      '--no-privileges',
      '--table', `auth.${tableName}`
    ],
    postgresChildEnvironment(sourceConnectionString, { PGOPTIONS: '-c statement_timeout=0' })
  );
}

function generateExactAuthRecoveryDataChunk({ pgDumpPath, sourceConnectionString }) {
  return privateGeneratedText(
    pgDumpPath,
    [
      '--data-only',
      '--column-inserts',
      '--no-owner',
      '--no-privileges',
      ...CURRENT_AUTH_TABLES.flatMap((tableName) => ['--table', `auth.${tableName}`])
    ],
    postgresChildEnvironment(sourceConnectionString, { PGOPTIONS: '-c statement_timeout=0' })
  );
}

function captureManagedOverlayArtifacts(paths) {
  return Object.fromEntries(Object.entries(paths).sort(([left], [right]) => left.localeCompare(right)).map(
    ([name, artifactPath]) => {
      verifyPrivateArtifactProtection(artifactPath);
      const bytes = fs.readFileSync(artifactPath);
      try {
        return [name, { size: bytes.length, digest: sha256(bytes) }];
      } finally {
        bytes.fill(0);
      }
    }
  ));
}

function generateManagedOverlayPackage({
  pgRestorePath,
  pgDumpPath,
  archivePath,
  sourceConnectionString,
  privateDirectory,
  sourceComponent,
  authEvidence,
  migration,
  authCompatibility,
  targetCatalog,
  applicationReplacement,
  sourceAclContract,
  applicationDefaultAcl,
  authRecovery = null,
  preserveAuth = null,
  nativePreservation = null
} = {}) {
  verifyPrivateArtifactProtection(archivePath);
  verifyPrivateDirectoryProtection(privateDirectory);
  const tocBytes = privateGeneratedText(pgRestorePath, ['--list', archivePath]);
  let appSchema;
  let appPre;
  let appData;
  let appPost;
  let users;
  let identities;
  let recoveryAuth;
  let migrationSql;
  try {
    const verifiedApplicationDefaultAcl = verifyApplicationDefaultAclManifest({
      certificate: applicationDefaultAcl?.certificate,
      key: applicationDefaultAcl?.key,
      target: targetCatalog?.profileTarget,
      managedProfile: {
        profileId: targetCatalog?.profileId,
        profileDigest: targetCatalog?.profileDigest
      },
      currentEntries: targetCatalog?.applicationDefaultAclEntries
    });
    const targetCompatibility = assertManagedCompatibilityProof({
      authCompatibility,
      targetCatalog,
      applicationReplacement,
      applicationDefaultAcl: verifiedApplicationDefaultAcl
    });
    if (authRecovery && preserveAuth) throw categoricalError('MANAGED_AUTH_MODE_AMBIGUOUS');
    const authMode = preserveAuth
      ? DEV_REMEDIATION_AUTH_PRESERVATION_MODE
      : authRecovery ? DEV_Y2_AUTH_RECOVERY_MODE : 'quarantined-overlay';
    const verifiedAuthRecoveryAuthority = authRecovery
      ? verifyExactAuthRecoveryAuthority(authRecovery.authority, authRecovery.key, {
          attemptId: authRecovery.attemptId,
          target: targetCatalog.profileTarget,
          sourceComponentDigest: sourceComponent.digest,
          migration
        })
      : preserveAuth
        ? verifyAuthPreservationAuthority(preserveAuth.authority, preserveAuth.key, {
            attemptId: preserveAuth.attemptId,
            target: targetCatalog.profileTarget,
            sourceComponentDigest: sourceComponent.digest,
            migration
          })
        : null;
    const verifiedNativePreservation = nativePreservation
      ? verifyNativeSmokePreservation(nativePreservation)
      : null;
    if (verifiedAuthRecoveryAuthority && verifiedNativePreservation) {
      throw categoricalError('DEV_Y2_NATIVE_SMOKE_OVERLAY_REJECTED');
    }
    verifyApplicationAclContract(sourceAclContract);
    const tocText = tocBytes.toString('utf8');
    const manifest = buildManagedRestoreManifest({
      tocText,
      sourceComponent,
      applicationAclContract: sourceAclContract,
      applicationDefaultAclCertificate: verifiedApplicationDefaultAcl.certificate
    });
    verifyManagedRestoreManifest(manifest);
    const appSchemaListPath = privateArtifactPath(privateDirectory, 'application-schema-restore.list');
    const appListPath = privateArtifactPath(privateDirectory, 'application-content-restore.list');
    const migrationListPath = privateArtifactPath(privateDirectory, 'migration-ledger-restore.list');
    const manifestPath = privateArtifactPath(privateDirectory, 'managed-restore-manifest.json');
    const aclContractPath = privateArtifactPath(privateDirectory, 'application-acl-contract.json');
    const defaultAclContractPath = privateArtifactPath(
      privateDirectory,
      'application-default-acl-preservation.json'
    );
    const scriptPath = privateArtifactPath(privateDirectory, 'managed-overlay.sql');
    const authRecoveryAuthorityPath = verifiedAuthRecoveryAuthority
      ? privateArtifactPath(privateDirectory, preserveAuth
          ? 'dev-remediation-auth-preservation-authority.json'
          : 'dev-y2-auth-recovery-authority.json')
      : '';
    writePrivateBytesExclusive(
      appSchemaListPath,
      Buffer.from(applicationSchemaRestoreList(tocText, manifest), 'utf8')
    );
    writePrivateBytesExclusive(
      appListPath,
      Buffer.from(applicationContentRestoreList(tocText, manifest), 'utf8')
    );
    writePrivateBytesExclusive(migrationListPath, Buffer.from(migrationRestoreList(tocText, manifest), 'utf8'));
    writePrivateJsonExclusive(manifestPath, manifest);
    writePrivateJsonExclusive(aclContractPath, sourceAclContract);
    writePrivateJsonExclusive(defaultAclContractPath, applicationDefaultAcl.certificate);
    if (verifiedAuthRecoveryAuthority) {
      writePrivateJsonExclusive(authRecoveryAuthorityPath, verifiedAuthRecoveryAuthority);
    }
    appSchema = generatePgRestoreChunk({
      pgRestorePath,
      archivePath,
      listPath: appSchemaListPath,
      section: 'pre-data',
      clean: false
    });
    appPre = generatePgRestoreChunk({
      pgRestorePath,
      archivePath,
      listPath: appListPath,
      section: 'pre-data',
      clean: false
    });
    appData = generatePgRestoreChunk({
      pgRestorePath,
      archivePath,
      listPath: appListPath,
      section: 'data'
    });
    appPost = generatePgRestoreChunk({
      pgRestorePath,
      archivePath,
      listPath: appListPath,
      section: 'post-data'
    });
    if (authMode === DEV_Y2_AUTH_RECOVERY_MODE) {
      recoveryAuth = generateExactAuthRecoveryDataChunk({ pgDumpPath, sourceConnectionString });
    } else if (authMode === 'quarantined-overlay') {
      users = generateAuthDataChunk({ pgDumpPath, sourceConnectionString, tableName: 'users' });
      identities = generateAuthDataChunk({ pgDumpPath, sourceConnectionString, tableName: 'identities' });
    }
    migrationSql = generatePgRestoreChunk({
      pgRestorePath,
      archivePath,
      listPath: migrationListPath,
      clean: true
    });
    const script = Buffer.from(buildManagedOverlaySql({
      applicationResetSql: buildApplicationPlaneResetSql(manifest),
      applicationSchemaSql: normalizeGeneratedSql(appSchema),
      applicationDefaultAclPreservationSql:
        buildApplicationDefaultAclPreservationSql(verifiedApplicationDefaultAcl),
      applicationPreDataSql: normalizeGeneratedSql(appPre),
      applicationDataSql: normalizeGeneratedSql(appData),
      applicationPostDataSql: normalizeGeneratedSql(appPost),
      applicationAclConvergenceSql: buildApplicationAclConvergenceSql(sourceAclContract),
      applicationDefaultAclVerificationSql: buildApplicationDefaultAclVerificationSql(
        verifiedApplicationDefaultAcl,
        'APPLICATION_DEFAULT_ACL_FINAL_MISMATCH'
      ),
      authUsersSql: users ? normalizeGeneratedSql(users) : '',
      authIdentitiesSql: identities ? normalizeGeneratedSql(identities) : '',
      authRecoverySql: recoveryAuth ? normalizeGeneratedSql(recoveryAuth) : '',
      migrationSql: normalizeGeneratedSql(migrationSql),
      authEvidence,
      migration,
      authMode,
      authRecoveryAuthority: verifiedAuthRecoveryAuthority,
      nativePreservation: verifiedNativePreservation
    }), 'utf8');
    writePrivateGeneratedFile(scriptPath, script);
    const scriptBytes = fs.readFileSync(scriptPath);
    let scriptDigest;
    let semanticDigest;
    let authRecoveryArtifact = null;
    try {
      scriptDigest = sha256(scriptBytes);
      const semanticBytes = Buffer.from(
        canonicalizePsqlRestrictionTokens(normalizeGeneratedSql(scriptBytes)),
        'utf8'
      );
      try {
        semanticDigest = sha256(semanticBytes);
      } finally {
        semanticBytes.fill(0);
      }
    } finally {
      scriptBytes.fill(0);
    }
    if (authRecoveryAuthorityPath) {
      const authorityBytes = fs.readFileSync(authRecoveryAuthorityPath);
      try {
        authRecoveryArtifact = {
          size: authorityBytes.length,
          digest: sha256(authorityBytes)
        };
      } finally {
        authorityBytes.fill(0);
      }
    }
    const paths = {
      appSchemaListPath,
      appListPath,
      migrationListPath,
      manifestPath,
      aclContractPath,
      defaultAclContractPath,
      ...(authRecoveryAuthorityPath ? { authRecoveryAuthorityPath } : {}),
      scriptPath
    };
    return {
      manifest,
      paths,
      artifacts: captureManagedOverlayArtifacts(paths),
      script: { size: fs.statSync(scriptPath).size, digest: scriptDigest, semanticDigest },
      targetCompatibility,
      sourceAclContract,
      applicationDefaultAcl: {
        authenticated: true,
        entryCount: verifiedApplicationDefaultAcl.entryCount,
        beforeDigest: verifiedApplicationDefaultAcl.beforeDigest,
        expectedAfterDigest: verifiedApplicationDefaultAcl.expectedAfterDigest,
        planDigest: verifiedApplicationDefaultAcl.planDigest
      },
      authMode,
      authRecoveryArtifact,
      nativePreservation: verifiedNativePreservation?.evidence || null,
      atomic: true,
      sessionReplicationRoleRequired: false
    };
  } finally {
    for (const bytes of [
      tocBytes, appSchema, appPre, appData, appPost, users, identities, recoveryAuth, migrationSql
    ]) {
      if (Buffer.isBuffer(bytes)) bytes.fill(0);
    }
  }
}

function connectionProjectRef(connectionString) {
  const parsed = parseDatabaseConnection(connectionString);
  const direct = parsed.host.toLowerCase().match(/^db\.([a-z0-9]{10,40})\.supabase\.co$/);
  if (direct) return direct[1];
  const pooled = parsed.host.toLowerCase().endsWith('.pooler.supabase.com')
    ? parsed.user.toLowerCase().match(/^postgres\.([a-z0-9]{10,40})$/)
    : null;
  return pooled?.[1] || '';
}

function assertOverlayExecutionGuard(connectionString, targetGuard = {}) {
  const connection = parseDatabaseConnection(connectionString);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(connection.host.toLowerCase());
  if (targetGuard.mode === 'disposable-managed-local') {
    if (!loopback || targetGuard.loopback !== true) {
      throw categoricalError('MANAGED_OVERLAY_TARGET_GUARD_REJECTED');
    }
    return { target: 'local', projectRef: '', loopback: true };
  }
  const projectRef = connectionProjectRef(connectionString);
  if (
    targetGuard.mutationGuardPassed !== true ||
    targetGuard.projectRefMatched !== true ||
    !['dev', 'sandbox'].includes(targetGuard.target) ||
    !projectRef ||
    projectRef !== targetGuard.projectRef ||
    projectRef === PROD_PROJECT_REF ||
    loopback
  ) {
    throw categoricalError('MANAGED_OVERLAY_TARGET_GUARD_REJECTED');
  }
  return { target: targetGuard.target, projectRef, loopback: false };
}

function classifyManagedScriptFailure(scriptPath, safeDiagnostic = {}) {
  const lineNumber = Number(String(safeDiagnostic.excerpt || '').match(/:(\d+):\s+(?:ERROR|FATAL)/i)?.[1]);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return 'UNCLASSIFIED_STATEMENT';
  const bytes = fs.readFileSync(scriptPath);
  try {
    const line = normalizeGeneratedSql(bytes).split('\n')[lineNumber - 1]?.trim() || '';
    if (/^INSERT INTO auth\.users\b/i.test(line)) return 'AUTH_USERS_INSERT';
    if (/^INSERT INTO auth\.identities\b/i.test(line)) return 'AUTH_IDENTITIES_INSERT';
    if (/^(?:DELETE FROM|TRUNCATE) auth\./i.test(line)) return 'AUTH_PURGE';
    if (/^(?:SELECT|PERFORM)\b/i.test(line)) return 'READ_OR_VERIFY';
    if (/^(?:CREATE|ALTER|DROP)\b/i.test(line)) return 'DDL';
    if (/^\\/.test(line)) return 'PSQL_META_COMMAND';
    return 'OTHER_REVIEWED_SQL';
  } finally {
    bytes.fill(0);
  }
}

async function executeManagedOverlayPackage({
  psqlPath,
  connectionString,
  packageResult,
  targetGuard,
  diagnosticDirectory
} = {}) {
  const { executionTarget, scriptPath, targetBindingDigest } = verifyManagedOverlayPackageForExecution({
    connectionString,
    packageResult,
    targetGuard
  });
  let result;
  try {
    result = await runPrivateDiagnosticCommand({
      executable: psqlPath,
      args: ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--file', scriptPath],
      env: postgresChildEnvironment(connectionString, {
        PGAPPNAME: 'environment-sync-managed-overlay',
        PGOPTIONS: '-c statement_timeout=0'
      }),
      diagnosticDirectory,
      failureCode: 'MANAGED_OVERLAY_EXECUTION_FAILED'
    });
  } catch (error) {
    if (error?.safeDiagnostic) {
      error.safeDiagnostic.statementCategory = classifyManagedScriptFailure(
        scriptPath,
        error.safeDiagnostic
      );
    }
    throw error;
  }
  return {
    applied: true,
    atomic: true,
    diagnostic: result.safeDiagnostic,
    executionTarget,
    targetBindingDigest
  };
}

function verifyManagedOverlayPackageForExecution({
  connectionString,
  packageResult,
  targetGuard
} = {}) {
  const executionTarget = assertOverlayExecutionGuard(connectionString, targetGuard);
  verifyManagedRestoreManifest(packageResult?.manifest);
  verifyApplicationAclContract(packageResult?.sourceAclContract);
  if (
    packageResult.manifest?.applicationAclConvergence?.contractDigest !==
      packageResult.sourceAclContract.contractDigest
  ) {
    throw categoricalError('MANAGED_OVERLAY_ACL_CONTRACT_BINDING_REJECTED');
  }
  const targetCompatibility = packageResult?.targetCompatibility;
  let authenticatedTargetGuard;
  if (executionTarget.loopback !== true) {
    try {
      authenticatedTargetGuard = buildManagedOverlayTargetGuard({
        packageResult,
        target: executionTarget.target,
        projectRef: executionTarget.projectRef,
        mutationGuardPassed: true,
        projectRefMatched: true
      });
    } catch {
      throw categoricalError('MANAGED_OVERLAY_COMPATIBILITY_BINDING_REJECTED');
    }
  }
  if (
    !targetCompatibility ||
    (executionTarget.loopback !== true &&
      canonicalSerialize(targetGuard) !== canonicalSerialize(authenticatedTargetGuard))
  ) {
    throw categoricalError('MANAGED_OVERLAY_COMPATIBILITY_BINDING_REJECTED');
  }
  const targetBindingDigest = canonicalDigest(
    executionTarget.loopback === true
      ? { mode: 'disposable-managed-local', loopback: true }
      : authenticatedTargetGuard
  );
  const scriptPath = packageResult?.paths?.scriptPath;
  const aclContractPath = packageResult?.paths?.aclContractPath;
  const authRecoveryAuthorityPath = packageResult?.paths?.authRecoveryAuthorityPath;
  const artifactNames = Object.keys(packageResult?.paths || {}).sort();
  if (
    artifactNames.length < 7 ||
    canonicalSerialize(artifactNames) !== canonicalSerialize(Object.keys(packageResult?.artifacts || {}).sort())
  ) throw categoricalError('MANAGED_OVERLAY_ARTIFACT_INVENTORY_INVALID');
  for (const name of artifactNames) {
    const artifactPath = packageResult.paths[name];
    const descriptor = packageResult.artifacts[name];
    verifyPrivateArtifactProtection(artifactPath);
    const bytes = fs.readFileSync(artifactPath);
    try {
      if (
        !Number.isSafeInteger(descriptor?.size) || descriptor.size < 1 ||
        bytes.length !== descriptor.size || sha256(bytes) !== descriptor.digest
      ) throw categoricalError('MANAGED_OVERLAY_ARTIFACT_MISMATCH');
    } finally {
      bytes.fill(0);
    }
  }
  verifyPrivateArtifactProtection(aclContractPath);
  verifyPrivateArtifactProtection(scriptPath);
  if ([DEV_Y2_AUTH_RECOVERY_MODE, DEV_REMEDIATION_AUTH_PRESERVATION_MODE].includes(packageResult?.authMode)) {
    verifyPrivateArtifactProtection(authRecoveryAuthorityPath);
    const authorityBytes = fs.readFileSync(authRecoveryAuthorityPath);
    try {
      if (
        authorityBytes.length !== packageResult?.authRecoveryArtifact?.size ||
        sha256(authorityBytes) !== packageResult?.authRecoveryArtifact?.digest
      ) {
        throw categoricalError('DEV_Y2_AUTH_RECOVERY_ARTIFACT_MISMATCH');
      }
    } finally {
      authorityBytes.fill(0);
    }
  } else if (packageResult?.authMode !== 'quarantined-overlay') {
    throw categoricalError('MANAGED_AUTH_MODE_INVALID');
  }
  const contractBytes = fs.readFileSync(aclContractPath);
  try {
    const storedContract = JSON.parse(normalizeGeneratedSql(contractBytes));
    verifyApplicationAclContract(storedContract);
    if (canonicalSerialize(storedContract) !== canonicalSerialize(packageResult.sourceAclContract)) {
      throw categoricalError('MANAGED_OVERLAY_ACL_CONTRACT_ARTIFACT_MISMATCH');
    }
  } finally {
    contractBytes.fill(0);
  }
  const scriptBytes = fs.readFileSync(scriptPath);
  try {
    if (
      scriptBytes.length !== packageResult?.script?.size ||
      sha256(scriptBytes) !== packageResult?.script?.digest
    ) {
      throw categoricalError('MANAGED_OVERLAY_SCRIPT_ARTIFACT_MISMATCH');
    }
  } finally {
    scriptBytes.fill(0);
  }
  return {
    authenticated: true,
    executionTarget,
    scriptPath,
    artifactCount: artifactNames.length,
    targetBindingDigest
  };
}

export {
  AUTH_IDENTITIES_COPY_COLUMNS,
  AUTH_OVERLAY_TABLES,
  AUTH_PRESERVED_TABLES,
  AUTH_USERS_COPY_COLUMNS,
  DEV_Y2_AUTH_RECOVERY_FORMAT,
  DEV_Y2_AUTH_RECOVERY_MODE,
  DEV_REMEDIATION_AUTH_PRESERVATION_FORMAT,
  DEV_REMEDIATION_AUTH_PRESERVATION_MODE,
  MANAGED_RESTORE_ACTIONS,
  MANAGED_RESTORE_CANONICALIZATION,
  MANAGED_RESTORE_CATEGORIES,
  MANAGED_RESTORE_MANIFEST_FORMAT,
  MANAGED_OVERLAY_COMPATIBILITY_BINDING_FIELDS,
  REQUIRED_MANAGED_ROLES,
  TARGET_NATIVE_SCHEMAS,
  applicationContentRestoreList,
  applicationRestoreList,
  applicationSchemaRestoreList,
  assertApplicationReplacementCompatibility,
  assertAuthOverlayCompatibility,
  assertManagedCompatibilityProof,
  assertManagedTargetCatalogCompatibility,
  assertOverlayExecutionGuard,
  authTransformEntries,
  buildAuthOverlayPurgeSql,
  buildAuthPreservationAuthority,
  buildExactAuthRecoveryAuthority,
  buildApplicationPlaneResetSql,
  buildManagedOverlaySql,
  buildManagedOverlayTargetGuard,
  buildManagedRestoreManifest,
  captureAuthOverlaySourceEvidence,
  captureExactAuthRecoveryEvidence,
  captureApplicationReplacementCatalog,
  captureManagedTargetCatalog,
  canonicalizePsqlRestrictionTokens,
  classifyTocEntry,
  executeManagedOverlayPackage,
  generateManagedOverlayPackage,
  migrationRestoreList,
  normalizeGeneratedSql,
  normalizeAuthShape,
  parsePgRestoreList,
  verifyExactAuthRecoveryAuthority,
  verifyAuthPreservationAuthority,
  verifyManagedOverlayPackageForExecution,
  verifyManagedRestoreManifest
};
