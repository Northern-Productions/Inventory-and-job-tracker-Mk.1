import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import {
  fsyncDirectory,
  openPrivateFileExclusive,
  verifyPrivateArtifactProtection
} from './private-artifacts.mjs';

const FIXTURE_LEDGER_FORMAT = 'dev-certified-fixture-ledger-v1';
const FIXTURE_LEDGER_HEADER_FORMAT = 'dev-certified-fixture-ledger-header-v1';
const FIXTURE_LEDGER_ENTRY_FORMAT = 'dev-certified-fixture-ledger-entry-v1';
const FIXTURE_LEDGER_BATCH_FORMAT = 'dev-certified-fixture-ledger-batch-v1';
const FIXTURE_LEDGER_TERMINAL_FORMAT = 'dev-certified-fixture-ledger-terminal-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_NAME = /^[a-z][a-z0-9_]{1,63}$/;

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_KEY_INVALID');
  }
}

function sign(payload, key) {
  assertKey(key);
  const bytes = Buffer.from(canonicalSerialize(payload), 'utf8');
  try {
    return `sha256:${crypto.createHmac('sha256', key).update(bytes).digest('hex')}`;
  } finally {
    bytes.fill(0);
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  try {
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } finally {
    a.fill(0);
    b.fill(0);
  }
}

function normalizeAuthority(authority = {}) {
  const workflows = Array.isArray(authority.workflows)
    ? authority.workflows.map((value) => String(value))
    : [];
  const entityLimits = Object.fromEntries(
    Object.entries(authority.entityLimits || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => {
        const limit = Number(value);
        if (!SAFE_NAME.test(name) || !Number.isSafeInteger(limit) || limit < 0 || limit > 512) {
          throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_AUTHORITY_INVALID');
        }
        return [name, limit];
      })
  );
  if (
    workflows.length !== 20 ||
    new Set(workflows).size !== workflows.length ||
    workflows.some((name) => !SAFE_NAME.test(name)) ||
    !SAFE_ID.test(String(authority.smokeActorId || '')) ||
    !SAFE_ID.test(String(authority.primaryOrganizationId || '')) ||
    Object.keys(entityLimits).length === 0
  ) {
    throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_AUTHORITY_INVALID');
  }
  return {
    target: 'dev',
    projectRef: String(authority.projectRef || ''),
    attemptId: String(authority.attemptId || ''),
    smokeActorId: String(authority.smokeActorId),
    primaryOrganizationId: String(authority.primaryOrganizationId),
    temporaryCrossOrganizationAllowed: authority.temporaryCrossOrganizationAllowed === true,
    workflows,
    entityLimits,
    cleanupAuthority: 'exact-authenticated-ledger-only',
    discoveryAddedTargets: false
  };
}

function parseRecords(bytes) {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_TRUNCATED');
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => !line)) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_RECORD_INVALID');
  try {
    return lines.map((line) => JSON.parse(line));
  } catch {
    throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_RECORD_INVALID');
  }
}

function verifyRecord(record, key) {
  if (
    record?.authentication?.algorithm !== 'hmac-sha256-v1' ||
    !safeEqual(record.authentication.digest, sign(record.payload, key))
  ) {
    throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_AUTHENTICATION_FAILED');
  }
  return record.payload;
}

function normalizePreferenceRestore(value) {
  if (
    value?.existed !== true ||
    !/^(?:|[A-Z]{2}[1-9][0-9]{0,6})$/.test(String(value.defaultWarehouse ?? '')) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(value.updatedAt || '')) ||
    typeof value.updatedBy !== 'string' || value.updatedBy.length > 256
  ) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_RESTORE_INVALID');
  return {
    existed: true,
    defaultWarehouse: String(value.defaultWarehouse),
    updatedAt: String(value.updatedAt),
    updatedBy: value.updatedBy
  };
}

function normalizeOrganizationPreferenceRestore(value) {
  if (value?.existed === false) return { existed: false };
  if (
    value?.existed !== true ||
    !SAFE_ID.test(String(value.selectedOrganizationId || '')) ||
    !SAFE_ID.test(String(value.updatedByUserId || '')) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(value.updatedAt || ''))
  ) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_ORGANIZATION_RESTORE_INVALID');
  return {
    existed: true,
    selectedOrganizationId: String(value.selectedOrganizationId),
    updatedAt: String(value.updatedAt),
    updatedByUserId: String(value.updatedByUserId)
  };
}

function normalizeOwnerNotificationPreferenceRestore(value) {
  if (value?.existed === false) return { existed: false };
  if (
    value?.existed !== true ||
    typeof value.inAppOptIn !== 'boolean' ||
    typeof value.emailOptIn !== 'boolean' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(value.updatedAt || '')) ||
    typeof value.updatedBy !== 'string' || value.updatedBy.length > 256
  ) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_OWNER_NOTIFICATION_RESTORE_INVALID');
  return {
    existed: true,
    inAppOptIn: value.inAppOptIn,
    emailOptIn: value.emailOptIn,
    updatedAt: String(value.updatedAt),
    updatedBy: value.updatedBy
  };
}

function entryIdentity(entityType, organizationId, stableId) {
  return `${entityType}\u0000${organizationId}\u0000${stableId}`;
}

function normalizeEntry(entry, authority, counts, ids, recordedAt) {
  const normalized = {
    workflow: String(entry?.workflow || ''),
    entityType: String(entry?.entityType || ''),
    stableId: String(entry?.stableId || ''),
    organizationId: String(entry?.organizationId || ''),
    primaryOrganization: String(entry?.organizationId || '') === authority.primaryOrganizationId,
    actorId: String(entry?.actorId || ''),
    recordedAt: String(recordedAt || entry?.recordedAt || '')
  };
  if (
    !authority.workflows.includes(normalized.workflow) ||
    !Object.hasOwn(authority.entityLimits, normalized.entityType) ||
    !SAFE_ID.test(normalized.stableId) ||
    !SAFE_ID.test(normalized.organizationId) ||
    normalized.actorId !== authority.smokeActorId ||
    (!normalized.primaryOrganization && !authority.temporaryCrossOrganizationAllowed) ||
    ids.has(entryIdentity(normalized.entityType, normalized.organizationId, normalized.stableId))
  ) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_ENTRY_INVALID');
  if (normalized.entityType === 'preference_restore') {
    normalized.restore = normalizePreferenceRestore(entry?.restore);
  } else if (normalized.entityType === 'organization_preference_restore') {
    normalized.restore = normalizeOrganizationPreferenceRestore(entry?.restore);
  } else if (normalized.entityType === 'owner_notification_preference_restore') {
    normalized.restore = normalizeOwnerNotificationPreferenceRestore(entry?.restore);
  } else if (Object.hasOwn(entry || {}, 'restore')) {
    throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_RESTORE_INVALID');
  }
  counts[normalized.entityType] += 1;
  if (counts[normalized.entityType] > authority.entityLimits[normalized.entityType]) {
    const category = normalized.entityType.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    throw categoricalError(`DEV_REFRESH_FIXTURE_LEDGER_LIMIT_EXCEEDED_${category}`);
  }
  ids.add(entryIdentity(normalized.entityType, normalized.organizationId, normalized.stableId));
  return normalized;
}

function readFixtureLedger(filePath, key, expected = {}) {
  assertKey(key);
  verifyPrivateArtifactProtection(filePath);
  const bytes = fs.readFileSync(filePath);
  try {
    const records = parseRecords(bytes);
    const header = verifyRecord(records[0], key);
    if (
      header?.format !== FIXTURE_LEDGER_HEADER_FORMAT ||
      header?.ledgerFormat !== FIXTURE_LEDGER_FORMAT ||
      header?.sequence !== 0 ||
      header?.previousDigest !== ''
    ) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_HEADER_INVALID');
    const authority = normalizeAuthority(header.authority);
    if (
      (expected.attemptId && authority.attemptId !== expected.attemptId) ||
      (expected.projectRef && authority.projectRef !== expected.projectRef) ||
      (expected.authorityDigest && header.authorityDigest !== expected.authorityDigest) ||
      header.authorityDigest !== canonicalDigest(authority)
    ) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_SCOPE_MISMATCH');

    const counts = Object.fromEntries(Object.keys(authority.entityLimits).map((name) => [name, 0]));
    const entries = [];
    const ids = new Set();
    let previousDigest = canonicalDigest(header);
    let terminal = null;
    for (let index = 1; index < records.length; index += 1) {
      const payload = verifyRecord(records[index], key);
      if (payload.sequence !== index || payload.previousDigest !== previousDigest) {
        throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_CHAIN_INVALID');
      }
      if (payload.attemptId !== authority.attemptId || payload.projectRef !== authority.projectRef) {
        throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_SCOPE_MISMATCH');
      }
      if (payload.format === FIXTURE_LEDGER_TERMINAL_FORMAT) {
        if (index !== records.length - 1 || terminal || payload.status !== 'cleanup_verified') {
          throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_TERMINAL_INVALID');
        }
        terminal = payload;
      } else if (payload.format === FIXTURE_LEDGER_ENTRY_FORMAT) {
        if (terminal || payload.primaryOrganization !== (payload.organizationId === authority.primaryOrganizationId)) {
          throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_ENTRY_INVALID');
        }
        entries.push(normalizeEntry(payload, authority, counts, ids, payload.recordedAt));
      } else if (payload.format === FIXTURE_LEDGER_BATCH_FORMAT) {
        if (
          terminal || !Array.isArray(payload.entries) || payload.entries.length < 1 ||
          payload.entries.length > 256
        ) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_ENTRY_INVALID');
        for (const entry of payload.entries) {
          entries.push(normalizeEntry(entry, authority, counts, ids, payload.recordedAt));
        }
      } else {
        throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_ENTRY_INVALID');
      }
      previousDigest = canonicalDigest(payload);
    }
    return {
      authority,
      authorityDigest: header.authorityDigest,
      records: records.length,
      entries,
      counts,
      terminal,
      chainDigest: previousDigest,
      byteDigest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
    };
  } finally {
    bytes.fill(0);
  }
}

function appendRecord(filePath, record) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
    bytes.fill(0);
  }
  verifyPrivateArtifactProtection(filePath);
  if (fsyncDirectory(path.dirname(filePath)) === 'failed') {
    throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_DIRECTORY_FSYNC_FAILED');
  }
}

function createFixtureLedger(filePath, key, authority, createdAt = new Date().toISOString()) {
  assertKey(key);
  const normalized = normalizeAuthority(authority);
  if (!/^[a-z0-9][a-z0-9-]{15,95}$/.test(normalized.attemptId)) {
    throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_ATTEMPT_INVALID');
  }
  const payload = {
    format: FIXTURE_LEDGER_HEADER_FORMAT,
    ledgerFormat: FIXTURE_LEDGER_FORMAT,
    sequence: 0,
    previousDigest: '',
    authority: normalized,
    authorityDigest: canonicalDigest(normalized),
    createdAt
  };
  const { descriptor } = openPrivateFileExclusive(filePath);
  const bytes = Buffer.from(`${JSON.stringify({
    payload,
    authentication: { algorithm: 'hmac-sha256-v1', digest: sign(payload, key) }
  })}\n`, 'utf8');
  try {
    fs.writeSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
    bytes.fill(0);
  }
  if (fsyncDirectory(path.dirname(filePath)) === 'failed') {
    throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_DIRECTORY_FSYNC_FAILED');
  }
  return readFixtureLedger(filePath, key, {
    attemptId: normalized.attemptId,
    projectRef: normalized.projectRef,
    authorityDigest: payload.authorityDigest
  });
}

function appendFixtureIds(filePath, key, entries, recordedAt = new Date().toISOString()) {
  const ledger = readFixtureLedger(filePath, key);
  if (ledger.terminal) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_CLOSED');
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 256) {
    throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_ENTRY_INVALID');
  }
  const counts = { ...ledger.counts };
  const ids = new Set(ledger.entries.map((entry) =>
    entryIdentity(entry.entityType, entry.organizationId, entry.stableId)));
  const normalizedEntries = entries.map((entry) =>
    normalizeEntry(entry, ledger.authority, counts, ids, recordedAt));
  const payload = {
    format: FIXTURE_LEDGER_BATCH_FORMAT,
    sequence: ledger.records,
    previousDigest: ledger.chainDigest,
    attemptId: ledger.authority.attemptId,
    projectRef: ledger.authority.projectRef,
    entries: normalizedEntries.map((entry) => ({
      workflow: entry.workflow,
      entityType: entry.entityType,
      stableId: entry.stableId,
      organizationId: entry.organizationId,
      actorId: entry.actorId,
      ...(entry.restore ? { restore: entry.restore } : {})
    })),
    recordedAt
  };
  appendRecord(filePath, {
    payload,
    authentication: { algorithm: 'hmac-sha256-v1', digest: sign(payload, key) }
  });
  return readFixtureLedger(filePath, key);
}

function appendFixtureId(filePath, key, entry = {}) {
  return appendFixtureIds(filePath, key, [entry], entry.recordedAt || new Date().toISOString());
}

function closeFixtureLedger(filePath, key, {
  removedCount,
  residueCount,
  parityDigest,
  recordedAt = new Date().toISOString()
} = {}) {
  const ledger = readFixtureLedger(filePath, key);
  if (
    ledger.terminal || !Number.isSafeInteger(removedCount) || removedCount < 0 ||
    residueCount !== 0 || !/^sha256:[0-9a-f]{64}$/.test(String(parityDigest || ''))
  ) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_CLOSE_INVALID');
  const payload = {
    format: FIXTURE_LEDGER_TERMINAL_FORMAT,
    sequence: ledger.records,
    previousDigest: ledger.chainDigest,
    attemptId: ledger.authority.attemptId,
    projectRef: ledger.authority.projectRef,
    status: 'cleanup_verified',
    removedCount,
    residueCount,
    parityDigest,
    recordedAt
  };
  appendRecord(filePath, {
    payload,
    authentication: { algorithm: 'hmac-sha256-v1', digest: sign(payload, key) }
  });
  return readFixtureLedger(filePath, key);
}

function cleanupTargetsFromLedger(filePath, key) {
  const ledger = readFixtureLedger(filePath, key);
  if (ledger.terminal) throw categoricalError('DEV_REFRESH_FIXTURE_LEDGER_CLOSED');
  return ledger.entries.map(({ entityType, stableId, organizationId, workflow, restore }) => ({
    entityType,
    stableId,
    organizationId,
    workflow,
    ...(restore ? { restore } : {})
  }));
}

export {
  FIXTURE_LEDGER_ENTRY_FORMAT,
  FIXTURE_LEDGER_BATCH_FORMAT,
  FIXTURE_LEDGER_FORMAT,
  FIXTURE_LEDGER_HEADER_FORMAT,
  FIXTURE_LEDGER_TERMINAL_FORMAT,
  appendFixtureId,
  appendFixtureIds,
  cleanupTargetsFromLedger,
  closeFixtureLedger,
  createFixtureLedger,
  readFixtureLedger
};
