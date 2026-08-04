import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  FixtureSafetyError,
  PENDING_TRANSFER_CHECKOUT_SCENARIO,
  PRIVATE_ALLOCATION_ID_PATTERN,
  assertIgnoredPath,
  assertNotRunlogPath,
  asText,
  isPendingTransferCheckoutScenario,
  isUuidLike,
  normalizeFixtureTag,
} from './dev-fixture-guard.mjs';

const V3_MANIFEST_VERSION = 3;
const V3_BASELINE_EVIDENCE_TYPE = 'pending-transfer-checkout-denial-baseline';
const V3_BASELINE_CANONICALIZATION_VERSION = 'dev-fixture-baseline-v1';
const V3_BASELINE_SERIALIZATION_POLICY = 'ordered-json-utf8-lf-v1';
const V3_BASELINE_HASH_ALGORITHM = 'sha256';
const V3_REDACTED_PATH = '<private-v3-artifact>';
const V3_BASELINE_SCOPE = Object.freeze([
  'nonfixture.app.caulk_manufacturers',
  'nonfixture.app.caulk_products',
  'nonfixture.app.caulk_stock',
  'nonfixture.app.caulk_transactions',
  'nonfixture.app.caulk_transfers',
  'nonfixture.app.job_caulk_requirements',
  'nonfixture.app.caulk_job_allocations',
  'nonfixture.app.caulk_job_checkouts',
  'nonfixture.app.box_dealers',
  'nonfixture.app.film_catalog',
  'nonfixture.app.boxes',
  'nonfixture.app.jobs',
  'nonfixture.app.job_phases',
  'nonfixture.app.job_requirements',
  'nonfixture.app.allocations',
  'nonfixture.app.audit_log',
  'nonfixture.app.allocation_planner_suppressions',
  'nonfixture.app.roll_weight_log',
  'nonfixture.app.box_id_aliases',
  'nonfixture.app.box_transfers',
  'nonfixture.app.film_orders',
  'nonfixture.app.film_order_box_links',
  'nonfixture.app.film_order_events',
  'reference.app.warehouses',
  'reference.app.owner_companies',
  'state.schema',
  'state.migrations',
  'state.dev_target',
  'state.dev_edge',
  'risk.atomic_transfer_quarantine',
]);

const V3_ID_GROUPS = Object.freeze([
  'manufacturerIds',
  'productIds',
  'caulkStockIds',
  'caulkTransactionIds',
  'caulkTransferRowIds',
  'caulkTransferIds',
  'caulkRequirementIds',
  'caulkAllocationRowIds',
  'caulkAllocationIds',
  'dealerIds',
  'filmCatalogIds',
  'boxRecordIds',
  'boxIds',
  'jobIds',
  'jobNumbers',
  'phaseIds',
  'requirementIds',
  'allocationIds',
  'auditLogIds',
]);

const UUID_ID_GROUPS = new Set([
  'manufacturerIds',
  'productIds',
  'caulkStockIds',
  'caulkTransactionIds',
  'caulkTransferRowIds',
  'caulkRequirementIds',
  'caulkAllocationRowIds',
  'dealerIds',
  'filmCatalogIds',
  'boxRecordIds',
  'jobIds',
  'phaseIds',
  'requirementIds',
  'auditLogIds',
]);

const V3_RUNTIME_STATES = Object.freeze([
  'initial',
  'allocation_applied',
  'mixed_checkout_complete',
]);
const V3_CLEANUP_STATES = Object.freeze([
  'not_started',
  'attempt_started',
  'succeeded',
  'failed',
  'recovery_required',
]);
const V3_CLEANUP_TERMINAL_STATES = Object.freeze([
  'succeeded',
  'failed',
  'recovery_required',
]);

function sanitizeFileTag(tag) {
  const normalized = normalizeFixtureTag(tag);
  if (isPendingTransferCheckoutScenario(normalized)) {
    return `pending-transfer-${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
  }
  return normalized.toLowerCase();
}

function getManifestPath(config, tag) {
  const manifestPath = path.resolve(config.manifestDir, `${sanitizeFileTag(tag)}.json`);
  try {
    assertNotRunlogPath(manifestPath);
    assertIgnoredPath(manifestPath);
  } catch (error) {
    if (isPendingTransferCheckoutScenario(tag)) {
      throw new FixtureSafetyError(
        'V3_ARTIFACT_SCOPE_INVALID',
        'Private fixture artifact scope is invalid.'
      );
    }
    throw error;
  }
  return manifestPath;
}

function normalizeIdList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => asText(value))
        .filter(Boolean)
    )
  ).sort();
}

function normalizeFixtureDealer(value = {}) {
  return {
    id: asText(value.id),
    code: asText(value.code),
    name: asText(value.name),
  };
}

function normalizeDealerTableIntegrity(value = {}) {
  const rowCount = Number(value.rowCount);
  const fingerprint = asText(value.fingerprint);
  return {
    rowCount: Number.isSafeInteger(rowCount) && rowCount >= 0 ? rowCount : null,
    fingerprint: /^sha256:[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : '',
  };
}

// Keep this object and property order byte-compatible with manifest v2.
function normalizeV2Manifest(manifest = {}) {
  const tag = normalizeFixtureTag(manifest.tag);
  return {
    version: 2,
    tag,
    scenario: asText(manifest.scenario),
    createdAt: asText(manifest.createdAt),
    updatedAt: asText(manifest.updatedAt || new Date().toISOString()),
    cleanedAt: asText(manifest.cleanedAt),
    projectRef: asText(manifest.projectRef),
    orgId: asText(manifest.orgId),
    ids: {
      jobIds: normalizeIdList(manifest.ids?.jobIds),
      jobNumbers: normalizeIdList(manifest.ids?.jobNumbers),
      phaseIds: normalizeIdList(manifest.ids?.phaseIds),
      requirementIds: normalizeIdList(manifest.ids?.requirementIds),
      allocationIds: normalizeIdList(manifest.ids?.allocationIds),
      boxIds: normalizeIdList(manifest.ids?.boxIds),
      filmOrderIds: normalizeIdList(manifest.ids?.filmOrderIds),
    },
    fixtureDealer: normalizeFixtureDealer(manifest.fixtureDealer),
    integrity: {
      dealerTableBefore: normalizeDealerTableIntegrity(manifest.integrity?.dealerTableBefore),
    },
    routes: {
      jobDetails: normalizeIdList(manifest.routes?.jobDetails),
      boxDetails: normalizeIdList(manifest.routes?.boxDetails),
      qrPayloads: normalizeIdList(manifest.routes?.qrPayloads),
    },
    summary: manifest.summary && typeof manifest.summary === 'object' ? manifest.summary : {},
    cleanup: manifest.cleanup && typeof manifest.cleanup === 'object' ? manifest.cleanup : {},
  };
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FixtureSafetyError('V3_STRUCTURE_INVALID', `${label} is invalid.`);
  }
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expected)) {
    throw new FixtureSafetyError('V3_STRUCTURE_INVALID', `${label} has incompatible fields.`);
  }
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeBaselineEvidence(value = {}) {
  assertExactKeys(
    value,
    [
      'evidenceType',
      'canonicalizationVersion',
      'serializationPolicy',
      'hashAlgorithm',
      'projections',
    ],
    'Baseline evidence'
  );
  if (
    value.evidenceType !== V3_BASELINE_EVIDENCE_TYPE ||
    value.canonicalizationVersion !== V3_BASELINE_CANONICALIZATION_VERSION ||
    value.serializationPolicy !== V3_BASELINE_SERIALIZATION_POLICY ||
    value.hashAlgorithm !== V3_BASELINE_HASH_ALGORITHM ||
    !Array.isArray(value.projections)
  ) {
    throw new FixtureSafetyError('BASELINE_INCOMPATIBLE', 'Baseline evidence is incompatible.');
  }
  if (value.projections.length !== V3_BASELINE_SCOPE.length) {
    throw new FixtureSafetyError('BASELINE_SCOPE_INVALID', 'Baseline projection scope is incomplete.');
  }

  const names = new Set();
  const projections = value.projections.map((entry, index) => {
    assertExactKeys(entry, ['name', 'count', 'digest'], 'Baseline projection');
    const expectedName = V3_BASELINE_SCOPE[index];
    if (entry.name !== expectedName || names.has(entry.name)) {
      throw new FixtureSafetyError('BASELINE_SCOPE_INVALID', 'Baseline projection order is invalid.');
    }
    names.add(entry.name);
    if (!Number.isSafeInteger(entry.count) || entry.count < 0) {
      throw new FixtureSafetyError('BASELINE_COUNT_INVALID', 'Baseline projection count is invalid.');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(entry.digest)) {
      throw new FixtureSafetyError('BASELINE_DIGEST_INVALID', 'Baseline projection digest is invalid.');
    }
    return {
      name: entry.name,
      count: entry.count,
      digest: entry.digest,
    };
  });

  return {
    evidenceType: V3_BASELINE_EVIDENCE_TYPE,
    canonicalizationVersion: V3_BASELINE_CANONICALIZATION_VERSION,
    serializationPolicy: V3_BASELINE_SERIALIZATION_POLICY,
    hashAlgorithm: V3_BASELINE_HASH_ALGORITHM,
    projections,
  };
}

function serializeBaselineEvidence(value) {
  const normalized = normalizeBaselineEvidence(value);
  return Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8');
}

function baselineEvidenceDigest(value) {
  return `sha256:${sha256Bytes(serializeBaselineEvidence(value))}`;
}

function assertBaselineEvidenceEqual(expected, actual) {
  const expectedBytes = serializeBaselineEvidence(expected);
  const actualBytes = serializeBaselineEvidence(actual);
  const equal = expectedBytes.equals(actualBytes);
  expectedBytes.fill(0);
  actualBytes.fill(0);
  if (!equal) {
    throw new FixtureSafetyError('BASELINE_DRIFT', 'Protected baseline evidence changed.');
  }
  return true;
}

function normalizeV3State(value = {}) {
  assertExactKeys(value, ['setup', 'runtime', 'cleanup'], 'Manifest lifecycle state');
  const state = {
    setup: asText(value.setup),
    runtime: asText(value.runtime),
    cleanup: asText(value.cleanup),
  };
  assertAllowedV3State(state);
  return state;
}

function assertAllowedV3State(state = {}) {
  const setup = asText(state.setup);
  const runtime = asText(state.runtime);
  const cleanup = asText(state.cleanup);
  let permitted = false;
  if (setup === 'prepared' || setup === 'recovery_required') {
    permitted = runtime === 'not_started' && cleanup === 'not_started';
  } else if (setup === 'ready' && V3_RUNTIME_STATES.includes(runtime)) {
    permitted = V3_CLEANUP_STATES.includes(cleanup);
  }
  if (!permitted) {
    throw new FixtureSafetyError('V3_STATE_INVALID', 'Manifest lifecycle state is invalid.');
  }
  if (
    cleanup !== 'not_started' &&
    cleanup !== 'attempt_started' &&
    !V3_CLEANUP_TERMINAL_STATES.includes(cleanup)
  ) {
    throw new FixtureSafetyError('V3_CLEANUP_STATE_INVALID', 'Manifest cleanup state is invalid.');
  }
  return true;
}

function v3StateKey(state) {
  return `${state.setup}/${state.runtime}/${state.cleanup}`;
}

function assertAdjacentV3Transition(previous, next) {
  assertAllowedV3State(previous);
  assertAllowedV3State(next);
  const before = v3StateKey(previous);
  const after = v3StateKey(next);
  const allowed = new Set([
    'prepared/not_started/not_started>ready/initial/not_started',
    'prepared/not_started/not_started>recovery_required/not_started/not_started',
    'ready/initial/not_started>ready/allocation_applied/not_started',
    'ready/allocation_applied/not_started>ready/mixed_checkout_complete/not_started',
  ]);
  for (const runtime of V3_RUNTIME_STATES) {
    allowed.add(`ready/${runtime}/not_started>ready/${runtime}/attempt_started`);
    for (const terminal of V3_CLEANUP_TERMINAL_STATES) {
      allowed.add(`ready/${runtime}/attempt_started>ready/${runtime}/${terminal}`);
    }
  }
  if (!allowed.has(`${before}>${after}`)) {
    throw new FixtureSafetyError('V3_TRANSITION_INVALID', 'Manifest lifecycle transition is invalid.');
  }
  return true;
}

function normalizeV3Ids(value = {}) {
  assertExactKeys(value, V3_ID_GROUPS, 'Manifest identifier groups');
  const ids = {};
  for (const group of V3_ID_GROUPS) {
    const values = normalizeIdList(value[group]);
    if (UUID_ID_GROUPS.has(group) && values.some((entry) => !isUuidLike(entry))) {
      throw new FixtureSafetyError('V3_IDENTIFIER_INVALID', 'Manifest identifiers are invalid.');
    }
    if (
      (group === 'allocationIds' || group === 'caulkAllocationIds') &&
      values.some((entry) => !PRIVATE_ALLOCATION_ID_PATTERN.test(entry))
    ) {
      throw new FixtureSafetyError('V3_IDENTIFIER_INVALID', 'Manifest identifiers are invalid.');
    }
    if (values.some((entry) => /[%*\r\n\0]/.test(entry))) {
      throw new FixtureSafetyError('V3_IDENTIFIER_INVALID', 'Manifest identifiers are invalid.');
    }
    ids[group] = values;
  }
  return ids;
}

function normalizeV3Manifest(manifest = {}) {
  if (Number(manifest.version) !== V3_MANIFEST_VERSION) {
    throw new FixtureSafetyError('V3_VERSION_INVALID', 'Manifest version is invalid.');
  }
  const tag = normalizeFixtureTag(manifest.tag, PENDING_TRANSFER_CHECKOUT_SCENARIO);
  if (
    manifest.scenario !== PENDING_TRANSFER_CHECKOUT_SCENARIO ||
    asText(manifest.namespace) !== tag ||
    !isUuidLike(manifest.orgId)
  ) {
    throw new FixtureSafetyError('V3_IDENTITY_INVALID', 'Manifest identity is invalid.');
  }
  const baseline = normalizeBaselineEvidence(manifest.baseline);
  const digest = baselineEvidenceDigest(baseline);
  if (manifest.baselineDigest && manifest.baselineDigest !== digest) {
    throw new FixtureSafetyError('BASELINE_DIGEST_MISMATCH', 'Manifest baseline digest is invalid.');
  }
  return {
    version: V3_MANIFEST_VERSION,
    tag,
    namespace: tag,
    scenario: PENDING_TRANSFER_CHECKOUT_SCENARIO,
    createdAt: asText(manifest.createdAt),
    updatedAt: asText(manifest.updatedAt || new Date().toISOString()),
    projectRef: asText(manifest.projectRef),
    orgId: asText(manifest.orgId),
    state: normalizeV3State(manifest.state),
    baseline,
    baselineDigest: digest,
    ids: normalizeV3Ids(manifest.ids),
    fixtureDealer: normalizeFixtureDealer(manifest.fixtureDealer),
    integrity: {
      dealerTableBefore: normalizeDealerTableIntegrity(manifest.integrity?.dealerTableBefore),
    },
    budgets: manifest.budgets && typeof manifest.budgets === 'object' ? manifest.budgets : {},
    cleanupEvidence:
      manifest.cleanupEvidence && typeof manifest.cleanupEvidence === 'object'
        ? manifest.cleanupEvidence
        : {},
  };
}

function normalizeManifest(manifest = {}) {
  return Number(manifest?.version) === V3_MANIFEST_VERSION
    ? normalizeV3Manifest(manifest)
    : normalizeV2Manifest(manifest);
}

function serializeManifest(manifest) {
  return Buffer.from(`${JSON.stringify(normalizeManifest(manifest), null, 2)}\n`, 'utf8');
}

function windowsAclScript(mode) {
  if (mode === 'protect') {
    return `$ErrorActionPreference='Stop';$p=[Environment]::GetEnvironmentVariable('CODEX_PRIVATE_ARTIFACT_TARGET','Process');if([string]::IsNullOrWhiteSpace($p)){exit 20};$id=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $p;$acl.SetAccessRuleProtection($true,$false);foreach($existing in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($existing)};$acl.SetOwner($id);$rule=[Security.AccessControl.FileSystemAccessRule]::new($id,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow);[void]$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl`;
  }
  return `$ErrorActionPreference='Stop';$p=[Environment]::GetEnvironmentVariable('CODEX_PRIVATE_ARTIFACT_TARGET','Process');if([string]::IsNullOrWhiteSpace($p)){exit 20};$id=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $p;if(-not $acl.AreAccessRulesProtected){exit 21};$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if($rules.Count -ne 1){exit 22};$r=$rules[0];if($r.IdentityReference.Value -ne $id.Value -or $r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)){exit 23}`;
}

function invokeWindowsAcl(mode, filePath) {
  try {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const executable = path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const encodedCommand = Buffer.from(windowsAclScript(mode), 'utf16le').toString('base64');
    execFileSync(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
      {
        windowsHide: true,
        stdio: 'ignore',
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          CODEX_PRIVATE_ARTIFACT_TARGET: filePath,
        },
      }
    );
  } catch (_error) {
    throw new FixtureSafetyError(
      mode === 'protect' ? 'PRIVATE_PROTECTION_FAILED' : 'PRIVATE_PROTECTION_UNPROVEN',
      'Private artifact protection could not be proven.'
    );
  }
}

function protectPrivateArtifact(filePath) {
  fs.chmodSync(filePath, 0o600);
  if (process.platform === 'win32') {
    invokeWindowsAcl('protect', filePath);
  }
  return verifyPrivateArtifactProtection(filePath);
}

function verifyPrivateArtifactProtection(filePath) {
  if (process.platform === 'win32') {
    invokeWindowsAcl('verify', filePath);
    return { mechanism: 'ntfs-protected-dacl', ownerOnly: true };
  }
  const mode = fs.statSync(filePath).mode & 0o777;
  if (mode !== 0o600) {
    throw new FixtureSafetyError(
      'PRIVATE_PROTECTION_UNPROVEN',
      'Private artifact protection could not be proven.'
    );
  }
  return { mechanism: 'posix-0600', ownerOnly: true };
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
  }
}

function createProtectedArtifactExclusive(filePath, bytes) {
  let fd;
  let protection;
  try {
    fd = fs.openSync(filePath, 'wx', 0o600);
    protection = protectPrivateArtifact(filePath);
    writeAll(fd, bytes);
    fs.fsyncSync(fd);
    verifyPrivateArtifactProtection(filePath);
  } catch (_error) {
    throw new FixtureSafetyError('PRIVATE_ARTIFACT_CREATE_FAILED', 'Private artifact creation failed.');
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  return {
    fileFsync: 'succeeded',
    protection,
    digest: `sha256:${sha256Bytes(bytes)}`,
  };
}

function fsyncDirectory(directoryPath) {
  if (process.platform === 'win32') {
    return 'unsupported';
  }
  let fd;
  try {
    fd = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(fd);
    return 'succeeded';
  } catch (_error) {
    return 'failed';
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function getV3ArtifactPaths(config, tag) {
  const safeTag = sanitizeFileTag(tag);
  const directory = path.resolve(config.manifestDir);
  return {
    directory,
    safeTag,
    manifestPath: getManifestPath(config, tag),
    lifecycleLockPath: path.join(directory, `${safeTag}.v3-lifecycle.lock`),
    cleanupMarkerPath: path.join(directory, `${safeTag}.v3-cleanup-attempt.marker`),
    recoveryMarkerPath: path.join(directory, `${safeTag}.v3-recovery.marker`),
    ambiguityMarkerPath: path.join(directory, `${safeTag}.v3-commit-ambiguity.marker`),
    publicationPrefix: `${safeTag}.v3-publication-`,
    replacementPrefix: `${safeTag}.v3-replacement-`,
  };
}

function listV3TemporaryArtifacts(paths) {
  if (!fs.existsSync(paths.directory)) {
    return [];
  }
  return fs.readdirSync(paths.directory).filter((name) => (
    name.startsWith(paths.publicationPrefix) || name.startsWith(paths.replacementPrefix)
  ));
}

function inspectV3Artifacts(config, tag, { allowLifecycleLock = false, allowCleanupMarker = false } = {}) {
  const paths = getV3ArtifactPaths(config, tag);
  const freezes = [];
  if (!allowLifecycleLock && fs.existsSync(paths.lifecycleLockPath)) {
    freezes.push('lifecycle_lock');
  }
  if (!allowCleanupMarker && fs.existsSync(paths.cleanupMarkerPath)) {
    freezes.push('cleanup_attempt');
  }
  if (fs.existsSync(paths.recoveryMarkerPath)) {
    freezes.push('recovery_required');
  }
  if (fs.existsSync(paths.ambiguityMarkerPath)) {
    freezes.push('commit_ambiguity');
  }
  if (listV3TemporaryArtifacts(paths).length > 0) {
    freezes.push('temporary_artifact');
  }
  let manifest = null;
  if (fs.existsSync(paths.manifestPath)) {
    try {
      verifyPrivateArtifactProtection(paths.manifestPath);
      manifest = readV3ManifestInternal(config, tag);
    } catch (_error) {
      freezes.push('unusable_manifest');
    }
  }
  if (freezes.length > 0) {
    throw new FixtureSafetyError('V3_NAMESPACE_FROZEN', 'The fixture namespace requires reviewed recovery.');
  }
  return { ...paths, manifest };
}

function createPrivateMarker(config, tag, kind) {
  const paths = getV3ArtifactPaths(config, tag);
  const target = {
    lifecycle_lock: paths.lifecycleLockPath,
    cleanup_attempt: paths.cleanupMarkerPath,
    recovery_required: paths.recoveryMarkerPath,
    commit_ambiguity: paths.ambiguityMarkerPath,
  }[kind];
  if (!target) {
    throw new FixtureSafetyError('V3_MARKER_INVALID', 'Private marker category is invalid.');
  }
  if (kind !== 'lifecycle_lock') {
    if (!fs.existsSync(paths.lifecycleLockPath)) {
      throw new FixtureSafetyError(
        'V3_LIFECYCLE_LOCK_REQUIRED',
        'Private fixture state changes require the lifecycle lock.'
      );
    }
    verifyPrivateArtifactProtection(paths.lifecycleLockPath);
  }
  const bytes = Buffer.from(`${JSON.stringify({ kind, createdAt: new Date().toISOString() })}\n`, 'utf8');
  try {
    const evidence = createProtectedArtifactExclusive(target, bytes);
    const directoryFsync = fsyncDirectory(paths.directory);
    if (directoryFsync === 'failed') {
      throw new FixtureSafetyError(
        'V3_DIRECTORY_FSYNC_FAILED',
        'Private marker durability could not be proven.'
      );
    }
    return { kind, ...evidence, directoryFsync };
  } finally {
    bytes.fill(0);
  }
}

function acquireV3LifecycleLock(config, tag, operation) {
  const paths = inspectV3Artifacts(config, tag);
  const normalizedOperation = asText(operation);
  if (!['create', 'record_runtime_stage', 'verify', 'cleanup'].includes(normalizedOperation)) {
    throw new FixtureSafetyError('V3_OPERATION_INVALID', 'Fixture lifecycle operation is invalid.');
  }
  if (normalizedOperation === 'create' && paths.manifest) {
    throw new FixtureSafetyError('V3_NAMESPACE_FROZEN', 'The fixture namespace requires reviewed recovery.');
  }
  if (normalizedOperation !== 'create') {
    if (
      !paths.manifest ||
      paths.manifest.state.setup !== 'ready' ||
      paths.manifest.state.cleanup !== 'not_started'
    ) {
      throw new FixtureSafetyError('V3_NAMESPACE_FROZEN', 'The fixture namespace requires reviewed recovery.');
    }
  }
  fs.mkdirSync(paths.directory, { recursive: true });
  const evidence = createPrivateMarker(config, tag, 'lifecycle_lock');
  return { operation: normalizedOperation, paths, evidence, released: false };
}

function releaseV3LifecycleLock(lock) {
  if (!lock || lock.released) {
    throw new FixtureSafetyError('V3_LOCK_INVALID', 'Fixture lifecycle lock is invalid.');
  }
  try {
    fs.unlinkSync(lock.paths.lifecycleLockPath);
    if (fs.existsSync(lock.paths.lifecycleLockPath)) {
      throw new Error('lock remained');
    }
    lock.released = true;
    return { removed: true, directoryFsync: fsyncDirectory(lock.paths.directory) };
  } catch (_error) {
    throw new FixtureSafetyError('V3_LOCK_RELEASE_FAILED', 'Fixture lifecycle lock release failed.');
  }
}

function createCleanupAttemptMarker(config, tag) {
  return createPrivateMarker(config, tag, 'cleanup_attempt');
}

function createRecoveryMarker(config, tag) {
  return createPrivateMarker(config, tag, 'recovery_required');
}

function createCommitAmbiguityMarker(config, tag) {
  return createPrivateMarker(config, tag, 'commit_ambiguity');
}

function readV3ManifestInternal(config, tag) {
  const manifestPath = getManifestPath(config, tag);
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (Number(parsed.version) !== V3_MANIFEST_VERSION) {
    throw new FixtureSafetyError('V3_VERSION_INVALID', 'Manifest version is invalid.');
  }
  return normalizeV3Manifest(parsed);
}

function publishInitialV3Manifest(config, manifest) {
  const normalized = normalizeV3Manifest(manifest);
  if (v3StateKey(normalized.state) !== 'prepared/not_started/not_started') {
    throw new FixtureSafetyError('V3_PUBLICATION_STATE_INVALID', 'Prepared manifest state is invalid.');
  }
  const paths = inspectV3Artifacts(config, normalized.tag, { allowLifecycleLock: true });
  if (!fs.existsSync(paths.lifecycleLockPath)) {
    throw new FixtureSafetyError(
      'V3_LIFECYCLE_LOCK_REQUIRED',
      'Prepared manifest publication requires the lifecycle lock.'
    );
  }
  verifyPrivateArtifactProtection(paths.lifecycleLockPath);
  if (fs.existsSync(paths.manifestPath)) {
    throw new FixtureSafetyError('V3_MANIFEST_EXISTS', 'The fixture namespace is already in use.');
  }
  fs.mkdirSync(paths.directory, { recursive: true });
  const token = randomBytes(12).toString('hex');
  const temporaryPath = path.join(paths.directory, `${paths.publicationPrefix}${token}.tmp`);
  const bytes = serializeManifest(normalized);
  const expectedDigest = `sha256:${sha256Bytes(bytes)}`;
  let published = false;
  try {
    const temporary = createProtectedArtifactExclusive(temporaryPath, bytes);
    fs.linkSync(temporaryPath, paths.manifestPath);
    published = true;
    const finalBytes = fs.readFileSync(paths.manifestPath);
    const finalDigest = `sha256:${sha256Bytes(finalBytes)}`;
    const finalMatches = finalBytes.equals(bytes) && finalDigest === expectedDigest;
    finalBytes.fill(0);
    if (!finalMatches) {
      throw new FixtureSafetyError('V3_PUBLICATION_VERIFY_FAILED', 'Prepared manifest verification failed.');
    }
    const protection = verifyPrivateArtifactProtection(paths.manifestPath);
    fs.unlinkSync(temporaryPath);
    if (fs.existsSync(temporaryPath)) {
      throw new FixtureSafetyError('V3_TEMP_REMOVE_FAILED', 'Prepared manifest finalization failed.');
    }
    const survivingBytes = fs.readFileSync(paths.manifestPath);
    const survivingMatches = (
      survivingBytes.equals(bytes) &&
      `sha256:${sha256Bytes(survivingBytes)}` === expectedDigest
    );
    survivingBytes.fill(0);
    if (!survivingMatches) {
      throw new FixtureSafetyError('V3_SURVIVING_TARGET_INVALID', 'Prepared manifest finalization failed.');
    }
    verifyPrivateArtifactProtection(paths.manifestPath);
    const directoryFsync = fsyncDirectory(paths.directory);
    if (directoryFsync === 'failed') {
      throw new FixtureSafetyError(
        'V3_DIRECTORY_FSYNC_FAILED',
        'Prepared manifest directory durability could not be proven.'
      );
    }
    return {
      manifest: normalized,
      manifestPath: V3_REDACTED_PATH,
      durability: {
        fileFsync: temporary.fileFsync,
        hardLinkPublication: 'succeeded',
        finalTargetDigest: expectedDigest,
        finalTargetBytes: 'verified',
        temporaryRemoval: 'succeeded',
        protection: protection.mechanism,
        directoryFsync,
      },
    };
  } catch (error) {
    if (published) {
      try {
        createRecoveryMarker(config, normalized.tag);
      } catch (_markerError) {
        // The published prepared manifest and lifecycle lock remain authoritative.
      }
    }
    if (error instanceof FixtureSafetyError) {
      throw error;
    }
    throw new FixtureSafetyError('V3_PUBLICATION_FAILED', 'Prepared manifest publication failed.');
  } finally {
    bytes.fill(0);
  }
}

function assertSameV3Predecessor(expected, actual) {
  for (const key of [
    'version',
    'tag',
    'namespace',
    'scenario',
    'createdAt',
    'projectRef',
    'orgId',
    'baselineDigest',
  ]) {
    if (expected[key] !== actual[key]) {
      throw new FixtureSafetyError('V3_PREDECESSOR_MISMATCH', 'Manifest predecessor changed.');
    }
  }
  if (v3StateKey(expected.state) !== v3StateKey(actual.state)) {
    throw new FixtureSafetyError('V3_PREDECESSOR_MISMATCH', 'Manifest predecessor changed.');
  }
  const expectedBytes = serializeManifest(expected);
  const actualBytes = serializeManifest(actual);
  const equal = expectedBytes.equals(actualBytes);
  expectedBytes.fill(0);
  actualBytes.fill(0);
  if (!equal) {
    throw new FixtureSafetyError('V3_PREDECESSOR_MISMATCH', 'Manifest predecessor changed.');
  }
}

function assertSameV3Identity(expected, next) {
  for (const key of [
    'version',
    'tag',
    'namespace',
    'scenario',
    'createdAt',
    'projectRef',
    'orgId',
    'baselineDigest',
  ]) {
    if (expected[key] !== next[key]) {
      throw new FixtureSafetyError('V3_IDENTITY_CHANGED', 'Manifest identity cannot change.');
    }
  }
  if (
    JSON.stringify(expected.baseline) !== JSON.stringify(next.baseline) ||
    JSON.stringify(expected.fixtureDealer) !== JSON.stringify(next.fixtureDealer) ||
    JSON.stringify(expected.integrity) !== JSON.stringify(next.integrity)
  ) {
    throw new FixtureSafetyError('V3_IDENTITY_CHANGED', 'Manifest identity cannot change.');
  }
}

function assertSameValue(previous, next, label) {
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new FixtureSafetyError('V3_TRANSITION_PAYLOAD_INVALID', `${label} cannot change.`);
  }
}

function assertSingleIdAppend(previousIds, nextIds, label) {
  if (
    nextIds.length !== previousIds.length + 1 ||
    previousIds.some((entry) => !nextIds.includes(entry))
  ) {
    throw new FixtureSafetyError(
      'V3_TRANSITION_PAYLOAD_INVALID',
      `${label} transition is invalid.`
    );
  }
}

function assertV3TransitionPayload(previous, next) {
  const before = v3StateKey(previous.state);
  const after = v3StateKey(next.state);
  const runtimeAllocation = (
    before === 'ready/initial/not_started' &&
    after === 'ready/allocation_applied/not_started'
  );
  const mixedCheckout = (
    before === 'ready/allocation_applied/not_started' &&
    after === 'ready/mixed_checkout_complete/not_started'
  );

  for (const group of V3_ID_GROUPS) {
    if (runtimeAllocation && group === 'allocationIds') {
      assertSingleIdAppend(previous.ids[group], next.ids[group], 'Runtime allocation');
      continue;
    }
    if (mixedCheckout && group === 'auditLogIds') {
      assertSingleIdAppend(previous.ids[group], next.ids[group], 'Runtime audit');
      continue;
    }
    assertSameValue(previous.ids[group], next.ids[group], 'Manifest identifiers');
  }

  if (!runtimeAllocation && !mixedCheckout) {
    assertSameValue(previous.budgets, next.budgets, 'Manifest budgets');
  }
  if (next.state.cleanup === 'not_started') {
    assertSameValue(previous.cleanupEvidence, next.cleanupEvidence, 'Cleanup evidence');
  }
  return true;
}

function replaceV3Manifest(config, expectedManifest, nextManifest, options = {}) {
  const expected = normalizeV3Manifest(expectedManifest);
  const next = normalizeV3Manifest(nextManifest);
  assertSameV3Identity(expected, next);
  assertAdjacentV3Transition(expected.state, next.state);
  assertV3TransitionPayload(expected, next);
  const paths = inspectV3Artifacts(config, expected.tag, {
    allowLifecycleLock: true,
    allowCleanupMarker: options.allowCleanupMarker === true,
  });
  const current = readV3ManifestInternal(config, expected.tag);
  assertSameV3Predecessor(expected, current);
  const currentBytes = serializeManifest(current);
  const currentDigest = sha256Bytes(currentBytes);
  const token = randomBytes(12).toString('hex');
  const temporaryPath = path.join(paths.directory, `${paths.replacementPrefix}${token}.tmp`);
  const nextBytes = serializeManifest(next);
  let replaced = false;
  try {
    createProtectedArtifactExclusive(temporaryPath, nextBytes);
    const predecessorBytes = fs.readFileSync(paths.manifestPath);
    const predecessorMatches = sha256Bytes(predecessorBytes) === currentDigest;
    predecessorBytes.fill(0);
    if (!predecessorMatches) {
      throw new FixtureSafetyError('V3_PREDECESSOR_MISMATCH', 'Manifest predecessor changed.');
    }
    fs.renameSync(temporaryPath, paths.manifestPath);
    replaced = true;
    const finalBytes = fs.readFileSync(paths.manifestPath);
    const finalMatches = finalBytes.equals(nextBytes);
    finalBytes.fill(0);
    if (!finalMatches) {
      throw new FixtureSafetyError('V3_REPLACEMENT_VERIFY_FAILED', 'Manifest replacement failed.');
    }
    verifyPrivateArtifactProtection(paths.manifestPath);
    const directoryFsync = fsyncDirectory(paths.directory);
    if (directoryFsync === 'failed') {
      throw new FixtureSafetyError(
        'V3_DIRECTORY_FSYNC_FAILED',
        'Manifest replacement durability could not be proven.'
      );
    }
    return {
      manifest: next,
      manifestPath: V3_REDACTED_PATH,
      durability: { directoryFsync },
    };
  } catch (error) {
    if (replaced) {
      try {
        createRecoveryMarker(config, expected.tag);
      } catch (_markerError) {
        // The lifecycle lock remains authoritative if recovery marking fails.
      }
    }
    if (error instanceof FixtureSafetyError) {
      throw error;
    }
    throw new FixtureSafetyError('V3_REPLACEMENT_FAILED', 'Manifest replacement failed.');
  } finally {
    currentBytes.fill(0);
    nextBytes.fill(0);
  }
}

function buildV3Transition(manifest, state, patch = {}) {
  const current = normalizeV3Manifest(manifest);
  assertAdjacentV3Transition(current.state, state);
  const next = normalizeV3Manifest({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    state,
    baseline: current.baseline,
    baselineDigest: current.baselineDigest,
  });
  assertSameV3Identity(current, next);
  assertV3TransitionPayload(current, next);
  return next;
}

function writeManifest(config, manifest) {
  const normalized = normalizeManifest(manifest);
  const manifestPath = getManifestPath(config, normalized.tag);
  if (normalized.version === V3_MANIFEST_VERSION) {
    if (!fs.existsSync(manifestPath)) {
      throw new FixtureSafetyError(
        'V3_PUBLICATION_REQUIRED',
        'Manifest v3 requires guarded exclusive publication.'
      );
    }
    return {
      manifest: readV3ManifestInternal(config, normalized.tag),
      manifestPath: V3_REDACTED_PATH,
    };
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return {
    manifest: normalized,
    manifestPath,
  };
}

function readManifest(config, tag) {
  const normalizedTag = normalizeFixtureTag(tag);
  const manifestPath = getManifestPath(config, normalizedTag);
  if (!fs.existsSync(manifestPath)) {
    if (isPendingTransferCheckoutScenario(normalizedTag)) {
      throw new FixtureSafetyError(
        'V3_MANIFEST_REQUIRED',
        'The pending-transfer fixture requires its private manifest.'
      );
    }
    return {
      manifest: null,
      manifestPath,
    };
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (Number(parsed.version) === V3_MANIFEST_VERSION) {
    inspectV3Artifacts(config, normalizedTag);
    verifyPrivateArtifactProtection(manifestPath);
    const manifest = normalizeV3Manifest(parsed);
    if (manifest.state.setup !== 'ready' || manifest.state.cleanup !== 'not_started') {
      throw new FixtureSafetyError(
        'V3_NAMESPACE_FROZEN',
        'The fixture namespace requires reviewed recovery.'
      );
    }
    return {
      manifest,
      manifestPath: V3_REDACTED_PATH,
    };
  }
  if (parsed.scenario === PENDING_TRANSFER_CHECKOUT_SCENARIO) {
    throw new FixtureSafetyError('V3_VERSION_INVALID', 'Manifest version is invalid.');
  }
  return {
    manifest: normalizeV2Manifest(parsed),
    manifestPath,
  };
}

export {
  V3_BASELINE_CANONICALIZATION_VERSION,
  V3_BASELINE_EVIDENCE_TYPE,
  V3_BASELINE_HASH_ALGORITHM,
  V3_BASELINE_SCOPE,
  V3_BASELINE_SERIALIZATION_POLICY,
  V3_CLEANUP_TERMINAL_STATES,
  V3_ID_GROUPS,
  V3_MANIFEST_VERSION,
  V3_RUNTIME_STATES,
  acquireV3LifecycleLock,
  assertAdjacentV3Transition,
  assertAllowedV3State,
  assertBaselineEvidenceEqual,
  baselineEvidenceDigest,
  buildV3Transition,
  createCleanupAttemptMarker,
  createCommitAmbiguityMarker,
  createProtectedArtifactExclusive,
  createRecoveryMarker,
  getManifestPath,
  getV3ArtifactPaths,
  inspectV3Artifacts,
  normalizeBaselineEvidence,
  normalizeDealerTableIntegrity,
  normalizeFixtureDealer,
  normalizeIdList,
  normalizeManifest,
  normalizeV2Manifest,
  normalizeV3Manifest,
  protectPrivateArtifact,
  publishInitialV3Manifest,
  readManifest,
  readV3ManifestInternal,
  releaseV3LifecycleLock,
  replaceV3Manifest,
  serializeBaselineEvidence,
  serializeManifest,
  verifyPrivateArtifactProtection,
  writeManifest,
};
