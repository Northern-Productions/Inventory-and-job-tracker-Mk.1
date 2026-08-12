import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATION_REGISTRY_COHERENT = 'MIGRATION_REGISTRY_COHERENT';
export const MIGRATION_REGISTRY_COHERENT_WITH_LEGACY_WARNINGS =
  'MIGRATION_REGISTRY_COHERENT_WITH_LEGACY_WARNINGS';
export const MIGRATION_REGISTRY_INCOHERENT = 'MIGRATION_REGISTRY_INCOHERENT';

export const DEFAULT_MIGRATION_POLICY = Object.freeze({
  schemaVersion: 1,
  strictMirrorLogicalStart: 85,
  strictMirrorSupabaseVersionStart: '20260425113000'
});

const BACKEND_PREFIX = 'backend/migrations/';
const SUPABASE_PREFIX = 'supabase/migrations/';
const BACKEND_PATTERN = /^backend\/migrations\/(\d{4})_([a-z0-9_]+)\.sql$/;
const SUPABASE_PATTERN = /^supabase\/migrations\/(\d{14})_([a-z0-9_]+)\.sql$/;
const MODULE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function runGit(repoRoot, args, { input, encoding = 'utf8', timeout = 30_000 } = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    input,
    encoding,
    shell: false,
    windowsHide: true,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1'
    }
  });
  if (result.error || result.status !== 0) {
    const error = new Error('canonical Git migration bytes are unavailable');
    error.code = 'MIGRATION_GIT_READ_FAILED';
    throw error;
  }
  return result.stdout;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
    .join(',')}}`;
}

function parseIndexEntries(repoRoot) {
  const unstaged = String(
    runGit(repoRoot, ['diff', '--name-only', '--', `${BACKEND_PREFIX}*`, `${SUPABASE_PREFIX}*`])
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const untracked = String(
    runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '--', `${BACKEND_PREFIX}*`, `${SUPABASE_PREFIX}*`])
  )
    .split(/\r?\n/)
    .filter(Boolean);
  if (unstaged.length || untracked.length) {
    const error = new Error('migration worktree bytes are not represented in the Git index');
    error.code = 'MIGRATION_BYTES_NOT_STAGED';
    error.metrics = { unstaged: unstaged.length, untracked: untracked.length };
    throw error;
  }

  const output = String(
    runGit(repoRoot, [
      'ls-files',
      '--stage',
      '-z',
      '--',
      `${BACKEND_PREFIX}*`,
      `${SUPABASE_PREFIX}*`
    ])
  );
  const entries = [];
  for (const record of output.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t(.+)$/.exec(record);
    if (!match || match[3] !== '0') {
      const error = new Error('migration index contains an unresolved or malformed entry');
      error.code = 'MIGRATION_INDEX_UNMERGED';
      throw error;
    }
    entries.push({ mode: match[1], oid: match[2], path: match[4] });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function readIndexBlobs(repoRoot, entries) {
  const objectIds = [...new Set(entries.map((entry) => entry.oid))];
  if (!objectIds.length) return new Map();
  const input = Buffer.from(`${objectIds.join('\n')}\n`, 'utf8');
  const output = runGit(repoRoot, ['cat-file', '--batch'], { input, encoding: null, timeout: 120_000 });
  const blobs = new Map();
  let offset = 0;
  for (const requestedOid of objectIds) {
    const lineEnd = output.indexOf(0x0a, offset);
    if (lineEnd < 0) throw new Error('Git batch output ended before its object header');
    const header = output.subarray(offset, lineEnd).toString('ascii');
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== requestedOid) {
      const error = new Error('Git index entry does not resolve to a blob');
      error.code = 'MIGRATION_INDEX_OBJECT_INVALID';
      throw error;
    }
    const size = Number(match[2]);
    const start = lineEnd + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || size < 0 || end >= output.length || output[end] !== 0x0a) {
      const error = new Error('Git batch output contains an invalid blob boundary');
      error.code = 'MIGRATION_INDEX_OBJECT_INVALID';
      throw error;
    }
    blobs.set(requestedOid, Buffer.from(output.subarray(start, end)));
    offset = end + 1;
  }
  if (offset !== output.length) {
    const error = new Error('Git batch output contains unexpected trailing bytes');
    error.code = 'MIGRATION_INDEX_OBJECT_INVALID';
    throw error;
  }
  return blobs;
}

export function readCanonicalMigrationSource(repoRoot = MODULE_REPO_ROOT) {
  const root = path.resolve(repoRoot);
  const entries = parseIndexEntries(root);
  const blobs = readIndexBlobs(root, entries);
  return entries.map((entry) => {
    const bytes = blobs.get(entry.oid);
    return {
      path: entry.path.replace(/\\/g, '/'),
      bytes,
      byteLength: bytes.length,
      contentIdentity: sha256(bytes),
      gitBlobIdentity: entry.oid
    };
  });
}

function addIssue(issues, severity, code, metrics = undefined) {
  const issue = { severity, code };
  if (metrics) issue.metrics = metrics;
  issues.push(issue);
}

function duplicateGroups(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function sanitizeEntry(entry) {
  const result = { ...entry };
  delete result.bytes;
  delete result.gitBlobIdentity;
  return result;
}

export function buildMigrationRegistry({
  repoRoot = MODULE_REPO_ROOT,
  source,
  policy = DEFAULT_MIGRATION_POLICY
} = {}) {
  const files = source || readCanonicalMigrationSource(repoRoot);
  const issues = [];
  const malformed = [];
  const backend = [];
  const supabase = [];

  for (const file of files) {
    const normalizedPath = String(file.path || '').replace(/\\/g, '/');
    if (normalizedPath.startsWith(BACKEND_PREFIX)) {
      const match = BACKEND_PATTERN.exec(normalizedPath);
      if (!match) {
        malformed.push(normalizedPath);
        continue;
      }
      backend.push({
        category: 'backend',
        path: normalizedPath,
        logicalId: match[1],
        logicalNumber: Number(match[1]),
        name: match[2],
        byteLength: file.byteLength ?? file.bytes?.length ?? 0,
        contentIdentity: file.contentIdentity || sha256(file.bytes)
      });
    } else if (normalizedPath.startsWith(SUPABASE_PREFIX)) {
      const match = SUPABASE_PATTERN.exec(normalizedPath);
      if (!match) {
        malformed.push(normalizedPath);
        continue;
      }
      supabase.push({
        category: 'supabase',
        path: normalizedPath,
        supabaseVersion: match[1],
        name: match[2],
        byteLength: file.byteLength ?? file.bytes?.length ?? 0,
        contentIdentity: file.contentIdentity || sha256(file.bytes)
      });
    }
  }

  backend.sort((left, right) => left.path.localeCompare(right.path));
  supabase.sort((left, right) => left.path.localeCompare(right.path));
  if (malformed.length) addIssue(issues, 'FAIL', 'MALFORMED_MIGRATION_NAME', { count: malformed.length });

  const duplicateBackendNames = duplicateGroups(backend, 'name');
  const duplicateSupabaseNames = duplicateGroups(supabase, 'name');
  const duplicateVersions = duplicateGroups(supabase, 'supabaseVersion');
  if (duplicateBackendNames.length || duplicateSupabaseNames.length) {
    addIssue(issues, 'FAIL', 'DUPLICATE_MIGRATION_MAPPING_NAME', {
      backendGroups: duplicateBackendNames.length,
      supabaseGroups: duplicateSupabaseNames.length
    });
  }
  if (duplicateVersions.length) {
    addIssue(issues, 'FAIL', 'DUPLICATE_SUPABASE_VERSION', { groups: duplicateVersions.length });
  }

  const logicalGroups = duplicateGroups(backend, 'logicalId');
  const strictLogicalDuplicates = logicalGroups.filter((group) =>
    group.some((entry) => entry.logicalNumber >= policy.strictMirrorLogicalStart)
  );
  const legacyLogicalDuplicates = logicalGroups.length - strictLogicalDuplicates.length;
  if (strictLogicalDuplicates.length) {
    addIssue(issues, 'FAIL', 'DUPLICATE_LOGICAL_MIGRATION', { groups: strictLogicalDuplicates.length });
  }
  if (legacyLogicalDuplicates) {
    addIssue(issues, 'WARNING', 'LEGACY_DUPLICATE_LOGICAL_MIGRATION', { groups: legacyLogicalDuplicates });
  }

  const backendNames = new Map(backend.map((entry) => [entry.name, entry]));
  const supabaseNames = new Map(supabase.map((entry) => [entry.name, entry]));
  const entries = [];
  let strictMissing = 0;
  let legacyMissing = 0;
  let strictMismatch = 0;
  let legacyMismatch = 0;

  for (const backendEntry of backend) {
    const supabaseEntry = supabaseNames.get(backendEntry.name) || null;
    const mirrorRequired = backendEntry.logicalNumber >= policy.strictMirrorLogicalStart;
    const exactMirror = Boolean(
      supabaseEntry &&
        backendEntry.byteLength === supabaseEntry.byteLength &&
        backendEntry.contentIdentity === supabaseEntry.contentIdentity
    );
    if (!supabaseEntry) {
      if (mirrorRequired) strictMissing += 1;
      else legacyMissing += 1;
    } else if (!exactMirror) {
      if (mirrorRequired) strictMismatch += 1;
      else legacyMismatch += 1;
    }
    entries.push({
      logicalId: backendEntry.logicalId,
      name: backendEntry.name,
      backendPath: backendEntry.path,
      supabasePath: supabaseEntry?.path || null,
      supabaseVersion: supabaseEntry?.supabaseVersion || null,
      mirrorRequired,
      exactMirror,
      byteLength: backendEntry.byteLength,
      contentIdentity: backendEntry.contentIdentity,
      supabaseContentIdentity: supabaseEntry?.contentIdentity || null
    });
  }

  const supabaseOnly = supabase.filter((entry) => !backendNames.has(entry.name));
  const strictSupabaseOnly = supabaseOnly.filter(
    (entry) => entry.supabaseVersion >= policy.strictMirrorSupabaseVersionStart
  );
  strictMissing += strictSupabaseOnly.length;
  legacyMissing += supabaseOnly.length - strictSupabaseOnly.length;
  for (const entry of supabaseOnly) {
    entries.push({
      logicalId: null,
      name: entry.name,
      backendPath: null,
      supabasePath: entry.path,
      supabaseVersion: entry.supabaseVersion,
      mirrorRequired: entry.supabaseVersion >= policy.strictMirrorSupabaseVersionStart,
      exactMirror: false,
      byteLength: entry.byteLength,
      contentIdentity: null,
      supabaseContentIdentity: entry.contentIdentity
    });
  }

  if (strictMissing) addIssue(issues, 'FAIL', 'REQUIRED_MIGRATION_MIRROR_MISSING', { count: strictMissing });
  if (strictMismatch) addIssue(issues, 'FAIL', 'REQUIRED_MIGRATION_MIRROR_MISMATCH', { count: strictMismatch });
  if (legacyMissing) addIssue(issues, 'WARNING', 'LEGACY_MIGRATION_WITHOUT_MIRROR', { count: legacyMissing });
  if (legacyMismatch) addIssue(issues, 'WARNING', 'LEGACY_MIGRATION_MIRROR_BYTE_DIFFERENCE', { count: legacyMismatch });

  const logicalNumbers = [...new Set(backend.map((entry) => entry.logicalNumber))].sort((a, b) => a - b);
  let gapCount = 0;
  for (let index = 1; index < logicalNumbers.length; index += 1) {
    gapCount += Math.max(0, logicalNumbers[index] - logicalNumbers[index - 1] - 1);
  }
  if (gapCount) addIssue(issues, 'FAIL', 'LOGICAL_MIGRATION_SEQUENCE_GAP', { count: gapCount });

  const strictPairs = entries
    .filter((entry) => entry.logicalId && Number(entry.logicalId) >= policy.strictMirrorLogicalStart && entry.supabaseVersion)
    .sort((left, right) => Number(left.logicalId) - Number(right.logicalId));
  let orderingViolations = 0;
  for (let index = 1; index < strictPairs.length; index += 1) {
    if (strictPairs[index].supabaseVersion <= strictPairs[index - 1].supabaseVersion) orderingViolations += 1;
  }
  if (orderingViolations) {
    addIssue(issues, 'FAIL', 'MIGRATION_ORDERING_VIOLATION', { count: orderingViolations });
  }

  entries.sort((left, right) => {
    if (left.logicalId && right.logicalId) {
      return Number(left.logicalId) - Number(right.logicalId) || left.name.localeCompare(right.name);
    }
    if (left.logicalId) return -1;
    if (right.logicalId) return 1;
    return left.supabaseVersion.localeCompare(right.supabaseVersion);
  });

  const latestNumber = logicalNumbers.at(-1);
  const latestCandidates = entries.filter((entry) => Number(entry.logicalId) === latestNumber);
  if (latestCandidates.length !== 1) {
    addIssue(issues, 'FAIL', 'LATEST_MIGRATION_AMBIGUOUS', { count: latestCandidates.length });
  }
  const latest = latestCandidates.length === 1 ? latestCandidates[0] : null;
  if (!latest?.supabaseVersion || !latest.exactMirror) {
    addIssue(issues, 'FAIL', 'LATEST_MIGRATION_NOT_EXACTLY_MIRRORED');
  }

  issues.sort((left, right) => left.severity.localeCompare(right.severity) || left.code.localeCompare(right.code));
  const failures = issues.filter((issue) => issue.severity === 'FAIL').length;
  const warnings = issues.filter((issue) => issue.severity === 'WARNING').length;
  const publicEntries = entries.map(sanitizeEntry);
  const identityPayload = {
    schemaVersion: 1,
    byteSource: 'git-index-blob-v1',
    policy,
    entries: publicEntries
  };
  return {
    schemaVersion: 1,
    byteSource: 'git-index-blob-v1',
    overall: failures
      ? MIGRATION_REGISTRY_INCOHERENT
      : warnings
        ? MIGRATION_REGISTRY_COHERENT_WITH_LEGACY_WARNINGS
        : MIGRATION_REGISTRY_COHERENT,
    policy: { ...policy },
    latest: latest ? sanitizeEntry(latest) : null,
    entries: publicEntries,
    issues,
    summary: {
      backendMigrations: backend.length,
      supabaseMigrations: supabase.length,
      mappedEntries: entries.filter((entry) => entry.backendPath && entry.supabasePath).length,
      requiredExactMirrors: entries.filter((entry) => entry.mirrorRequired).length,
      failures,
      warnings
    },
    registryIdentity: sha256(Buffer.from(canonicalStringify(identityPayload), 'utf8'))
  };
}

export function getLatestMigration(registry) {
  if (!registry?.latest) throw new Error('migration registry has no unambiguous latest migration');
  return registry.latest;
}

export function findMigration(registry, logicalId, { name } = {}) {
  const normalized = String(logicalId).padStart(4, '0');
  const matches = registry.entries.filter(
    (entry) => entry.logicalId === normalized && (!name || entry.name === name)
  );
  if (matches.length !== 1) {
    const error = new Error('migration lookup is missing or ambiguous');
    error.code = matches.length ? 'MIGRATION_LOOKUP_AMBIGUOUS' : 'MIGRATION_LOOKUP_MISSING';
    throw error;
  }
  return matches[0];
}

export function migrationExistsExactlyOnce(registry, logicalId, options = {}) {
  try {
    findMigration(registry, logicalId, options);
    return true;
  } catch {
    return false;
  }
}

export function formatMigrationRegistryReport(registry) {
  const latest = registry.latest
    ? `${registry.latest.logicalId} / ${registry.latest.supabaseVersion}`
    : 'unavailable';
  const lines = [
    '[migration-registry]',
    `overall: ${registry.overall}`,
    `byteSource: ${registry.byteSource}`,
    `latest: ${latest}`,
    `registryIdentity: ${registry.registryIdentity}`,
    `counts: backend=${registry.summary.backendMigrations}, supabase=${registry.summary.supabaseMigrations}, mapped=${registry.summary.mappedEntries}, requiredExact=${registry.summary.requiredExactMirrors}`,
    'issues:'
  ];
  if (!registry.issues.length) lines.push('  <none>');
  for (const issue of registry.issues) {
    const metrics = issue.metrics
      ? ` (${Object.entries(issue.metrics).map(([key, value]) => `${key}=${value}`).join(', ')})`
      : '';
    lines.push(`  ${issue.severity} ${issue.code}${metrics}`);
  }
  return lines.join('\n');
}

export function serializeMigrationRegistry(registry) {
  return `${JSON.stringify(registry, null, 2)}\n`;
}
