import crypto from 'node:crypto';

import { canonicalSerialize } from '../readonly-diagnostics.mjs';
import {
  BASELINE_MANIFEST_FORMAT,
  CANONICALIZATION_VERSION,
  DERIVED_MANIFEST_FORMAT,
  MANIFEST_AUTHENTICATION
} from './constants.mjs';

function asText(value) {
  return String(value ?? '').trim();
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizeDigest(value, label = 'digest') {
  const digest = asText(value).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${label} is invalid.`);
  }
  return digest;
}

function normalizeComponent(component = {}) {
  const name = asText(component.name);
  if (!/^[a-z][a-z0-9._-]{0,79}$/.test(name)) {
    throw new Error('Baseline component name is invalid.');
  }
  const size = Number(component.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Baseline component ${name} has an invalid size.`);
  }
  return { name, size, digest: normalizeDigest(component.digest, `${name} digest`) };
}

function normalizeSourceIdentity({ baselineId, sourceSnapshotTimestamp, sourceCommit, edgeIdentity } = {}) {
  const normalizedBaselineId = asText(baselineId);
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(normalizedBaselineId)) {
    throw new Error('Golden baseline ID is invalid.');
  }
  const normalizedTimestamp = asText(sourceSnapshotTimestamp);
  if (!normalizedTimestamp || new Date(normalizedTimestamp).toISOString() !== normalizedTimestamp) {
    throw new Error('Golden baseline snapshot timestamp is invalid.');
  }
  const normalizedCommit = asText(sourceCommit).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalizedCommit)) {
    throw new Error('Golden baseline source commit is invalid.');
  }
  const edgeSource = asText(edgeIdentity?.source);
  if (!edgeSource) throw new Error('Golden baseline Edge source is required.');
  return {
    baselineId: normalizedBaselineId,
    sourceSnapshotTimestamp: normalizedTimestamp,
    sourceCommit: normalizedCommit,
    edgeIdentity: {
      ...edgeIdentity,
      source: edgeSource,
      graphDigest: normalizeDigest(edgeIdentity?.graphDigest, 'Edge graph digest'),
      lockDigest: normalizeDigest(edgeIdentity?.lockDigest, 'Edge lock digest')
    }
  };
}

function unsignedManifest(manifest) {
  const { authentication: _authentication, ...unsigned } = manifest || {};
  return unsigned;
}

function authenticateManifest(manifest, key) {
  const keyBytes = Buffer.isBuffer(key) ? key : Buffer.from(key || '');
  if (keyBytes.length < 32) {
    throw new Error('Manifest authentication key must contain at least 32 bytes.');
  }
  const payload = Buffer.from(canonicalSerialize(unsignedManifest(manifest)), 'utf8');
  try {
    const digest = `sha256:${crypto.createHmac('sha256', keyBytes).update(payload).digest('hex')}`;
    return {
      ...unsignedManifest(manifest),
      authentication: { algorithm: MANIFEST_AUTHENTICATION, digest }
    };
  } finally {
    payload.fill(0);
  }
}

function verifyAuthenticatedManifest(manifest, key) {
  if (manifest?.authentication?.algorithm !== MANIFEST_AUTHENTICATION) {
    throw new Error('Manifest authentication algorithm is incompatible.');
  }
  const expected = authenticateManifest(manifest, key).authentication.digest;
  const actual = normalizeDigest(manifest.authentication.digest, 'manifest authentication digest');
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  const ok = expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
  expectedBytes.fill(0);
  actualBytes.fill(0);
  if (!ok) {
    throw new Error('Manifest authentication failed.');
  }
  return true;
}

function normalizeExceptionList(exceptions = []) {
  const normalized = Array.from(new Set((exceptions || []).map(asText).filter(Boolean))).sort();
  for (const entry of normalized) {
    if (!/^\/(?:[A-Za-z0-9._-]+\/?)+$/.test(entry)) {
      throw new Error(`Manifest exception path is invalid: ${entry}`);
    }
  }
  return normalized;
}

function buildBaselineManifest({
  baselineId,
  sourceEnvironment = 'prod',
  sourceSnapshotTimestamp,
  sourceCommit,
  inventory,
  components = [],
  edgeIdentity,
  platformClassifications = {},
  sideEffectInventory = {},
  allowedExceptions = []
} = {}) {
  if (asText(sourceEnvironment) !== 'prod') {
    throw new Error('Golden baseline source environment must be prod.');
  }
  const sourceIdentity = normalizeSourceIdentity({
    baselineId,
    sourceSnapshotTimestamp,
    sourceCommit,
    edgeIdentity
  });
  const normalizedComponents = components.map(normalizeComponent).sort((a, b) => a.name.localeCompare(b.name));
  if (normalizedComponents.length === 0) {
    throw new Error('Golden baseline requires at least one authenticated component.');
  }
  if (new Set(normalizedComponents.map((entry) => entry.name)).size !== normalizedComponents.length) {
    throw new Error('Baseline component names must be unique.');
  }
  if (!inventory || inventory.format !== 'environment-inventory-v1') {
    throw new Error('A compatible environment inventory is required.');
  }
  return {
    format: BASELINE_MANIFEST_FORMAT,
    version: 1,
    canonicalization: CANONICALIZATION_VERSION,
    baselineId: sourceIdentity.baselineId,
    sourceEnvironment: 'prod',
    sourceSnapshotTimestamp: sourceIdentity.sourceSnapshotTimestamp,
    sourceCommit: sourceIdentity.sourceCommit,
    migration: inventory.migration,
    catalog: inventory.catalog,
    protectedData: inventory.protectedData,
    authTopology: inventory.authTopology,
    components: normalizedComponents,
    edgeIdentity: sourceIdentity.edgeIdentity,
    platformClassifications,
    sideEffectInventory,
    allowedExceptions: normalizeExceptionList(allowedExceptions)
  };
}

function buildDerivedManifest({ baselineManifest, target, transform, inventory, allowedExceptions = [] } = {}) {
  if (baselineManifest?.format !== BASELINE_MANIFEST_FORMAT) {
    throw new Error('A compatible golden baseline manifest is required.');
  }
  if (!['dev', 'sandbox'].includes(asText(target?.environment))) {
    throw new Error('Derived baseline target must be dev or sandbox.');
  }
  if (!asText(target?.projectRef)) {
    throw new Error('Derived baseline target project ref is required.');
  }
  if (!asText(transform?.id) || !asText(transform?.version)) {
    throw new Error('Derived baseline transform identity is required.');
  }
  return {
    format: DERIVED_MANIFEST_FORMAT,
    version: 1,
    canonicalization: CANONICALIZATION_VERSION,
    baselineId: baselineManifest.baselineId,
    sourceManifestDigest: sha256Bytes(Buffer.from(canonicalSerialize(baselineManifest), 'utf8')),
    target: { environment: target.environment, projectRef: target.projectRef },
    transform: { id: transform.id, version: transform.version },
    inventory,
    allowedExceptions: normalizeExceptionList(allowedExceptions)
  };
}

function flatten(value, prefix = '', output = new Map()) {
  if (value === null || typeof value !== 'object') {
    output.set(prefix || '/', canonicalSerialize(value));
    return output;
  }
  if (Array.isArray(value)) {
    output.set(prefix || '/', canonicalSerialize(value));
    return output;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    output.set(prefix || '/', '{}');
    return output;
  }
  for (const key of keys) {
    flatten(value[key], `${prefix}/${key}`, output);
  }
  return output;
}

function compareInventoriesWithExceptions(left, right, allowedExceptions = []) {
  const allowed = new Set(normalizeExceptionList(allowedExceptions));
  const leftPaths = flatten(left);
  const rightPaths = flatten(right);
  const allPaths = Array.from(new Set([...leftPaths.keys(), ...rightPaths.keys()])).sort();
  const changed = allPaths.filter((entry) => leftPaths.get(entry) !== rightPaths.get(entry));
  const unexpected = changed.filter((entry) => !allowed.has(entry));
  const missing = Array.from(allowed).filter((entry) => !changed.includes(entry));
  return { ok: unexpected.length === 0 && missing.length === 0, changed, unexpected, missing };
}

function verifyComponentBytes(component, bytes) {
  const normalized = normalizeComponent(component);
  const actualSize = Buffer.byteLength(bytes);
  const actualDigest = sha256Bytes(bytes);
  if (actualSize !== normalized.size || actualDigest !== normalized.digest) {
    throw new Error(`Baseline component ${normalized.name} failed integrity verification.`);
  }
  return true;
}

export {
  authenticateManifest,
  buildBaselineManifest,
  buildDerivedManifest,
  compareInventoriesWithExceptions,
  normalizeDigest,
  sha256Bytes,
  unsignedManifest,
  verifyAuthenticatedManifest,
  verifyComponentBytes
};
