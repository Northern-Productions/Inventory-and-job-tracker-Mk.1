import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  FixtureSafetyError,
  PENDING_TRANSFER_CHECKOUT_SCENARIO,
  assertFixtureDealerAvailable,
  assertExplicitPendingTransferEnv,
  buildFixtureDealerIdentity,
  buildFixtureTag,
  normalizeFixtureTag,
  parseArgs,
  readAllocationIdFromStdin,
  requireScenario,
} from './lib/dev-fixture-guard.mjs';
import {
  V3_BASELINE_CANONICALIZATION_VERSION,
  V3_BASELINE_EVIDENCE_TYPE,
  V3_BASELINE_HASH_ALGORITHM,
  V3_BASELINE_SCOPE,
  V3_BASELINE_SERIALIZATION_POLICY,
  V3_CLEANUP_TERMINAL_STATES,
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
  normalizeManifest,
  normalizeV2Manifest,
  normalizeV3Manifest,
  publishInitialV3Manifest,
  releaseV3LifecycleLock,
  replaceV3Manifest,
  serializeManifest,
  verifyPrivateArtifactProtection,
} from './lib/dev-fixture-manifest.mjs';
import {
  PENDING_TRANSFER_INITIAL_BUDGET,
  PENDING_TRANSFER_STAGE_BUDGETS,
  assertNoDiscoveredCleanupTargets,
  assertPendingTransferManifestIdBudget,
  assertPendingTransferStageBudget,
  assertSafeFixtureIdentity,
  dealerTableIntegrityMatches,
  normalizeFixtureIdentity,
  normalizePendingTransferCleanupIdentity,
} from './lib/dev-fixture-cleanup-safety.mjs';

const FIXTURE_SOURCE_PATH = new URL('./lib/dev-fixture-scenarios.mjs', import.meta.url);
const FIXTURE_CREATE_SOURCE_PATH = new URL('./create-dev-fixture.mjs', import.meta.url);
const FIXTURE_VERIFY_SOURCE_PATH = new URL('./verify-dev-fixture.mjs', import.meta.url);
const OWNER_AUTH_SOURCE_PATH = new URL('../create-dev-owner-browser-auth-state.mjs', import.meta.url);
const FIXTURE_MANIFEST_SOURCE_PATH = new URL('./lib/dev-fixture-manifest.mjs', import.meta.url);
const FIXTURE_GUARD_SOURCE_PATH = new URL('./lib/dev-fixture-guard.mjs', import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PRIVATE_TEST_ROOT = path.resolve(REPO_ROOT, '.secrets', 'dev-fixtures');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPrivateHarness() {
  fs.mkdirSync(PRIVATE_TEST_ROOT, { recursive: true });
  const directory = path.join(PRIVATE_TEST_ROOT, `local-v3-test-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: false });
  return {
    config: { manifestDir: directory },
    directory,
  };
}

function removePrivateHarness(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== PRIVATE_TEST_ROOT || !path.basename(resolved).startsWith('local-v3-test-')) {
    throw new Error('Refusing to remove an unscoped test harness.');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function minimalChildEnvironment(profileDirectory, preloadPath = '') {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
    HOME: profileDirectory,
    USERPROFILE: profileDirectory,
    TEMP: profileDirectory,
    TMP: profileDirectory,
    NODE_NO_WARNINGS: '1',
    ...(preloadPath ? { NODE_OPTIONS: `--require=${preloadPath}` } : {}),
  };
}

function syntheticBaseline() {
  return {
    evidenceType: V3_BASELINE_EVIDENCE_TYPE,
    canonicalizationVersion: V3_BASELINE_CANONICALIZATION_VERSION,
    serializationPolicy: V3_BASELINE_SERIALIZATION_POLICY,
    hashAlgorithm: V3_BASELINE_HASH_ALGORITHM,
    projections: V3_BASELINE_SCOPE.map((name, index) => ({
      name,
      count: index,
      digest: `sha256:${index.toString(16).padStart(64, '0')}`,
    })),
  };
}

function createPrivateId() {
  return `${'1'.repeat(17)}-${'2'.repeat(3)}`;
}

function syntheticV3Manifest({
  tag = 'CODEX_DEV_FIXTURE_PENDING_TRANSFER_CHECKOUT_DENIAL_12345678901',
  state = { setup: 'prepared', runtime: 'not_started', cleanup: 'not_started' },
} = {}) {
  const ids = {
    manufacturerIds: [randomUUID()],
    productIds: [randomUUID()],
    caulkStockIds: [randomUUID(), randomUUID()],
    caulkTransactionIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    caulkTransferRowIds: [randomUUID()],
    caulkTransferIds: ['TRF-CATEGORICAL-TEST'],
    caulkRequirementIds: [randomUUID()],
    caulkAllocationRowIds: [randomUUID()],
    caulkAllocationIds: [createPrivateId()],
    dealerIds: [randomUUID()],
    filmCatalogIds: [randomUUID()],
    boxRecordIds: [randomUUID()],
    boxIds: ['IL1-CODEX-TEST'],
    jobIds: [randomUUID()],
    jobNumbers: ['70000001'],
    phaseIds: [randomUUID()],
    requirementIds: [randomUUID()],
    allocationIds: state.runtime === 'not_started' || state.runtime === 'initial'
      ? []
      : [createPrivateId()],
    auditLogIds: state.runtime === 'mixed_checkout_complete'
      ? [randomUUID(), randomUUID()]
      : [randomUUID()],
  };
  return {
    version: 3,
    tag,
    namespace: tag,
    scenario: PENDING_TRANSFER_CHECKOUT_SCENARIO,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    projectRef: 'synthetic-local-ref',
    orgId: randomUUID(),
    state,
    baseline: syntheticBaseline(),
    ids,
    fixtureDealer: {
      id: ids.dealerIds[0],
      code: `${tag}`.toLowerCase(),
      name: tag,
    },
    integrity: {
      dealerTableBefore: {
        rowCount: 0,
        fingerprint: `sha256:${'a'.repeat(64)}`,
      },
    },
    budgets: state.runtime === 'mixed_checkout_complete'
      ? PENDING_TRANSFER_STAGE_BUDGETS.mixed_checkout_complete
      : state.runtime === 'allocation_applied'
        ? PENDING_TRANSFER_STAGE_BUDGETS.allocation_applied
        : PENDING_TRANSFER_STAGE_BUDGETS.initial,
    cleanupEvidence: {},
  };
}

test('parseArgs supports PowerShell-friendly --key value and --key=value forms', () => {
  assert.deepEqual(parseArgs(['--scenario', 'checked-out-box-job', '--tag=CODEX_DEV_FIXTURE_X_1234']), {
    scenario: 'checked-out-box-job',
    tag: 'CODEX_DEV_FIXTURE_X_1234',
  });
});

test('fixture tags are normalized and guarded', () => {
  const tag = buildFixtureTag('allocation-eligibility');
  assert.match(tag, /^CODEX_DEV_FIXTURE_ALLOCATION_ELIGIBILITY_\d{11}$/);
  assert.equal(
    normalizeFixtureTag('codex dev fixture checked out box job 123456'),
    'CODEX_DEV_FIXTURE_CHECKED_OUT_BOX_JOB_123456'
  );
  assert.throws(() => normalizeFixtureTag('REAL_DATA_123'), /must start/);
});

test('atomic transfer-assisted allocation is an explicit guarded DEV scenario', () => {
  assert.equal(
    requireScenario('atomic-transfer-assisted-allocation'),
    'atomic-transfer-assisted-allocation'
  );
});

test('allocation timeout remediation is an explicit guarded DEV scenario', () => {
  assert.equal(
    requireScenario('allocation-timeout-remediation'),
    'allocation-timeout-remediation'
  );
});

test('fixture dealer identity is collision-resistant and carries the complete fixture tag', () => {
  const tag = 'CODEX_DEV_FIXTURE_ATOMIC_TRANSFER_ASSISTED_ALLOCATION_12345678901';
  const dealer = buildFixtureDealerIdentity(tag);
  assert.match(dealer.name, new RegExp(tag));
  assert.match(dealer.code, new RegExp(tag.toLowerCase()));
  assert.equal(dealer.code, dealer.name.toLowerCase());
});

test('pre-existing dealer code or name collisions fail before fixture mutation', () => {
  assert.equal(assertFixtureDealerAvailable({ codeMatches: 0, nameMatches: 0 }), true);
  assert.throws(
    () => assertFixtureDealerAvailable({ codeMatches: 1, nameMatches: 0 }),
    /fresh fixture tag/
  );
  assert.throws(
    () => assertFixtureDealerAvailable({ codeMatches: 0, nameMatches: 1 }),
    /fresh fixture tag/
  );
});

test('manifest normalization dedupes IDs and keeps only safe local metadata', () => {
  const tag = 'CODEX_DEV_FIXTURE_TEST_123456';
  const fixtureDealer = {
    id: '22222222-2222-4222-8222-222222222222',
    ...buildFixtureDealerIdentity(tag),
  };
  const manifest = normalizeManifest({
    tag,
    scenario: 'checked-out-box-job',
    ids: {
      boxIds: ['IL1-1', 'IL1-1', 'IL1-2'],
      jobNumbers: ['7001', '7001'],
    },
    fixtureDealer,
  });
  assert.deepEqual(manifest.ids.boxIds, ['IL1-1', 'IL1-2']);
  assert.deepEqual(manifest.ids.jobNumbers, ['7001']);
  assert.equal(manifest.tag, tag);
  assert.deepEqual(manifest.fixtureDealer, fixtureDealer);
});

test('dealer cleanup integrity requires the original count and fingerprint', () => {
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  assert.equal(
    dealerTableIntegrityMatches(
      { rowCount: 24, fingerprint },
      { rowCount: 24, fingerprint }
    ),
    true
  );
  assert.equal(
    dealerTableIntegrityMatches(
      { rowCount: 24, fingerprint },
      { rowCount: 25, fingerprint }
    ),
    false
  );
});

test('fixture dealer writes are insert-only and cleanup deletes the exact dealer last', () => {
  const source = fs.readFileSync(FIXTURE_SOURCE_PATH, 'utf8');
  assert.match(source, /insert into app\.box_dealers \(org_id, name, lookup_key\)/i);
  assert.doesNotMatch(source, /update app\.box_dealers/i);
  const boxDeleteIndex = source.indexOf('delete from app.boxes target');
  const dealerDeleteIndex = source.indexOf('delete from app.box_dealers target');
  assert.ok(boxDeleteIndex >= 0);
  assert.ok(dealerDeleteIndex > boxDeleteIndex);
  assert.match(
    source.slice(dealerDeleteIndex),
    /target\.id = p\.dealer_id[\s\S]*target\.lookup_key = p\.dealer_code[\s\S]*target\.name = p\.dealer_name/
  );
});

test('fixture create and verify commands support redacted safe output', () => {
  const createSource = fs.readFileSync(FIXTURE_CREATE_SOURCE_PATH, 'utf8');
  const verifySource = fs.readFileSync(FIXTURE_VERIFY_SOURCE_PATH, 'utf8');
  assert.match(createSource, /safe-output/);
  assert.match(createSource, /idCounts/);
  assert.match(verifySource, /safe-output/);
  assert.match(verifySource, /!\s*safeOutput\s*\?\s*\{\s*ids:/s);
});

test('owner browser cleanup verifies user, membership, preference, and session residue', () => {
  const source = fs.readFileSync(OWNER_AUTH_SOURCE_PATH, 'utf8');
  assert.match(source, /delete from app\.user_preferences/i);
  assert.match(source, /from auth\.users where id = \$1::uuid/i);
  assert.match(source, /from auth\.sessions where user_id = \$1::uuid/i);
  assert.match(source, /from app\.organization_members where org_id = \$2::uuid and user_id = \$1::uuid/i);
  assert.match(source, /residueVerified/);
});

test('cleanup identity combines manifest and discovered IDs without wildcards', () => {
  const tag = 'CODEX_DEV_FIXTURE_TEST_123456';
  const fixtureDealer = {
    id: '22222222-2222-4222-8222-222222222222',
    ...buildFixtureDealerIdentity(tag),
  };
  const identity = normalizeFixtureIdentity({
    tag,
    manifest: {
      fixtureDealer,
      ids: {
        jobIds: ['11111111-1111-4111-8111-111111111111'],
        boxIds: ['IL1-A'],
      },
    },
    discovered: {
      fixtureDealer,
      ids: {
        jobIds: ['11111111-1111-4111-8111-111111111111'],
        boxIds: ['IL1-B'],
      },
    },
  });
  assert.deepEqual(identity.ids.boxIds, ['IL1-A', 'IL1-B']);
  assert.deepEqual(identity.fixtureDealer, fixtureDealer);
  assert.equal(assertSafeFixtureIdentity(identity), true);
  assert.throws(
    () => assertSafeFixtureIdentity({
      tag: 'CODEX_DEV_FIXTURE_TEST_123456',
      ids: { boxIds: ['IL1-*'] },
    }),
    /wildcard/
  );
});

test('cleanup identity tolerates missing manifest during first create', () => {
  const identity = normalizeFixtureIdentity({
    tag: 'CODEX_DEV_FIXTURE_TEST_123456',
    manifest: null,
    discovered: null,
  });
  assert.equal(identity.tag, 'CODEX_DEV_FIXTURE_TEST_123456');
  assert.deepEqual(identity.ids.boxIds, []);
});

test('pending-transfer scenario requires its dedicated namespace and explicit environment', () => {
  assert.equal(requireScenario(PENDING_TRANSFER_CHECKOUT_SCENARIO), PENDING_TRANSFER_CHECKOUT_SCENARIO);
  assert.equal(
    assertExplicitPendingTransferEnv({
      scenario: PENDING_TRANSFER_CHECKOUT_SCENARIO,
      env: 'synthetic-local.env',
    }),
    true
  );
  assert.throws(
    () => assertExplicitPendingTransferEnv({ scenario: PENDING_TRANSFER_CHECKOUT_SCENARIO }),
    (error) => error instanceof FixtureSafetyError && error.code === 'EXPLICIT_ENV_REQUIRED'
  );
  assert.throws(
    () => normalizeFixtureTag('CODEX_DEV_FIXTURE_UNRELATED_12345678901', PENDING_TRANSFER_CHECKOUT_SCENARIO),
    (error) => error instanceof FixtureSafetyError && error.code === 'V3_NAMESPACE_INVALID'
  );
  const unignoredDirectory = path.join(REPO_ROOT, 'private-artifact-path-must-not-escape');
  assert.throws(
    () => getManifestPath(
      { manifestDir: unignoredDirectory },
      'CODEX_DEV_FIXTURE_PENDING_TRANSFER_CHECKOUT_DENIAL_12345678901'
    ),
    (error) => {
      assert.equal(error.code, 'V3_ARTIFACT_SCOPE_INVALID');
      assert.doesNotMatch(error.message, /private-artifact-path-must-not-escape/i);
      return true;
    }
  );
});

test('entry preparse rejects before repository imports and preserves help', () => {
  const source = fs.readFileSync(FIXTURE_CREATE_SOURCE_PATH, 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.ok(source.indexOf('assertPreparseSafety(preparsed)') < source.indexOf("await import('./lib/dev-fixture-guard.mjs')"));
  assert.match(source, /if \(preparsed\.help\)[\s\S]*printUsage\(preparsed\.scenario\);[\s\S]*return;/);
  const guardSource = fs.readFileSync(FIXTURE_GUARD_SOURCE_PATH, 'utf8');
  const assertions = [...guardSource.matchAll(/assertExplicitPendingTransferEnv\(options\)/g)];
  assert.equal(assertions.length, 2);
  assert.ok(assertions[1].index < guardSource.indexOf('const loaded = loadEnvFile(envPath)'));
});

test('isolated CLI children are network-tripped and do not load shared configuration', () => {
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-cli-isolation-'));
  const preloadPath = path.join(profileDirectory, 'network-tripwire.cjs');
  const tripwire = Buffer.from(`
    'use strict';
    const blocked = () => { const error = new Error('NETWORK_TRIPWIRE'); error.code = 'NETWORK_TRIPWIRE'; throw error; };
    globalThis.fetch = blocked;
    for (const name of ['node:http', 'node:https', 'node:net', 'node:tls']) {
      const moduleValue = require(name);
      for (const key of ['request', 'get', 'connect', 'createConnection']) {
        if (typeof moduleValue[key] === 'function') moduleValue[key] = blocked;
      }
    }
    const dns = require('node:dns');
    for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
      if (typeof dns[key] === 'function') dns[key] = blocked;
      if (dns.promises && typeof dns.promises[key] === 'function') dns.promises[key] = blocked;
    }
  `, 'utf8');
  try {
    createProtectedArtifactExclusive(preloadPath, tripwire);
    tripwire.fill(0);
    const env = minimalChildEnvironment(profileDirectory, preloadPath);
    const controlled = spawnSync(
      process.execPath,
      ['-e', "fetch('http://127.0.0.1')"],
      { cwd: profileDirectory, env, encoding: 'utf8', shell: false, timeout: 10_000 }
    );
    assert.notEqual(controlled.status, 0);
    assert.match(controlled.stderr, /NETWORK_TRIPWIRE/);

    const cliPath = fileURLToPath(FIXTURE_CREATE_SOURCE_PATH);
    const help = spawnSync(process.execPath, [cliPath, '--help'], {
      cwd: profileDirectory,
      env,
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
    });
    assert.equal(help.status, 0);
    assert.equal(
      help.stdout.trim(),
      'Usage: node backend/scripts/dev-fixtures/create-dev-fixture.mjs --scenario <checked-out-box-job|allocation-eligibility|atomic-transfer-assisted-allocation|allocation-timeout-remediation> [--tag CODEX_DEV_FIXTURE_...] [--safe-output]'
    );
    assert.doesNotMatch(`${help.stdout}${help.stderr}`, /NETWORK_TRIPWIRE/);

    const pendingHelp = spawnSync(
      process.execPath,
      [cliPath, '--scenario', PENDING_TRANSFER_CHECKOUT_SCENARIO, '--help'],
      { cwd: profileDirectory, env, encoding: 'utf8', shell: false, timeout: 10_000 }
    );
    assert.equal(pendingHelp.status, 0);
    assert.match(pendingHelp.stdout, /--env <synthetic-local-env>/);
    assert.doesNotMatch(`${pendingHelp.stdout}${pendingHelp.stderr}`, /NETWORK_TRIPWIRE/);

    const rejected = spawnSync(
      process.execPath,
      [cliPath, '--scenario', PENDING_TRANSFER_CHECKOUT_SCENARIO],
      { cwd: profileDirectory, env, encoding: 'utf8', shell: false, timeout: 10_000 }
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /"code":"EXPLICIT_ENV_REQUIRED"/);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, /NETWORK_TRIPWIRE|\.env\.dev/i);
    assert.doesNotMatch(`${help.stdout}${help.stderr}${pendingHelp.stdout}${pendingHelp.stderr}${rejected.stdout}${rejected.stderr}`, new RegExp(profileDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  } finally {
    tripwire.fill(0);
    const resolved = path.resolve(profileDirectory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir())) {
      throw new Error('Refusing to remove an unscoped child profile.');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

async function readPrivateInput(value, options = {}) {
  const input = new PassThrough();
  const pending = readAllocationIdFromStdin({ input, ...options });
  input.end(value);
  return pending;
}

test('private allocation stdin accepts only the canonical bounded value', async () => {
  const privateValue = createPrivateId();
  assert.equal(await readPrivateInput(Buffer.from(privateValue, 'utf8')), privateValue);
  assert.equal(await readPrivateInput(Buffer.from(`${privateValue}\n`, 'utf8')), privateValue);
  assert.equal(await readPrivateInput(Buffer.from(`${privateValue}\r\n`, 'utf8')), privateValue);
  for (const payload of [
    '',
    ` ${privateValue}`,
    `${privateValue} `,
    `${privateValue}\r`,
    `${privateValue}\n${privateValue}`,
    `${privateValue}\ntrailing`,
    'not-canonical',
  ]) {
    await assert.rejects(
      readPrivateInput(Buffer.from(payload, 'utf8')),
      (error) => error instanceof FixtureSafetyError && error.code === 'PRIVATE_INPUT_INVALID'
    );
  }
  await assert.rejects(
    readPrivateInput(Buffer.from([0xc3, 0x28])),
    (error) => error instanceof FixtureSafetyError && error.code === 'PRIVATE_INPUT_INVALID_UTF8'
  );
  await assert.rejects(
    readPrivateInput(Buffer.alloc(65, 0x31)),
    (error) => error instanceof FixtureSafetyError && error.code === 'PRIVATE_INPUT_TOO_LARGE'
  );
});

test('private allocation stdin refuses TTY, times out, cleans listeners, and redacts values', async () => {
  const tty = new PassThrough();
  Object.defineProperty(tty, 'isTTY', { value: true });
  assert.throws(
    () => readAllocationIdFromStdin({ input: tty }),
    (error) => error instanceof FixtureSafetyError && error.code === 'PRIVATE_INPUT_TTY_REFUSED'
  );

  const waiting = new PassThrough();
  const timeout = readAllocationIdFromStdin({ input: waiting, timeoutMs: 10 });
  await assert.rejects(
    timeout,
    (error) => error instanceof FixtureSafetyError && error.code === 'PRIVATE_INPUT_TIMEOUT'
  );
  assert.equal(waiting.listenerCount('data'), 0);
  assert.equal(waiting.listenerCount('end'), 0);
  assert.equal(waiting.listenerCount('error'), 0);

  const privateValue = createPrivateId();
  await assert.rejects(
    readPrivateInput(Buffer.from(`${privateValue}\ninvalid`, 'utf8')),
    (error) => {
      assert.doesNotMatch(`${error.code}:${error.message}`, new RegExp(privateValue));
      return error instanceof FixtureSafetyError;
    }
  );
});

test('baseline evidence is ordered, versioned, deterministic, and immutable', () => {
  const baseline = syntheticBaseline();
  const normalized = normalizeBaselineEvidence(baseline);
  assert.deepEqual(normalized, baseline);
  assert.equal(baselineEvidenceDigest(baseline), baselineEvidenceDigest(clone(baseline)));
  assert.equal(assertBaselineEvidenceEqual(baseline, clone(baseline)), true);

  const drifted = clone(baseline);
  drifted.projections[0].count += 1;
  assert.throws(() => assertBaselineEvidenceEqual(baseline, drifted), /baseline evidence changed/i);
  for (const invalid of [
    { ...clone(baseline), extra: true },
    { ...clone(baseline), canonicalizationVersion: 'unsupported' },
    { ...clone(baseline), hashAlgorithm: 'sha512' },
  ]) {
    assert.throws(() => normalizeBaselineEvidence(invalid));
  }
  const reordered = clone(baseline);
  [reordered.projections[0], reordered.projections[1]] = [reordered.projections[1], reordered.projections[0]];
  assert.throws(() => normalizeBaselineEvidence(reordered), /projection order/i);
  const malformed = clone(baseline);
  malformed.projections[0].digest = `sha256:${'A'.repeat(64)}`;
  assert.throws(() => normalizeBaselineEvidence(malformed), /digest/i);
});

test('manifest v3 allows only the explicit state matrix and adjacent transitions', () => {
  const committedRuntime = ['initial', 'allocation_applied', 'mixed_checkout_complete'];
  assert.deepEqual(V3_CLEANUP_TERMINAL_STATES, ['succeeded', 'failed', 'recovery_required']);
  assert.equal(assertAllowedV3State({ setup: 'prepared', runtime: 'not_started', cleanup: 'not_started' }), true);
  assert.equal(assertAllowedV3State({ setup: 'recovery_required', runtime: 'not_started', cleanup: 'not_started' }), true);
  for (const runtime of committedRuntime) {
    for (const cleanup of ['not_started', 'attempt_started', ...V3_CLEANUP_TERMINAL_STATES]) {
      assert.equal(assertAllowedV3State({ setup: 'ready', runtime, cleanup }), true);
    }
  }
  for (const invalid of [
    { setup: 'ready', runtime: 'not_started', cleanup: 'not_started' },
    { setup: 'prepared', runtime: 'initial', cleanup: 'not_started' },
    { setup: 'ready', runtime: 'initial', cleanup: 'unknown' },
    { setup: 'unknown', runtime: 'initial', cleanup: 'not_started' },
  ]) {
    assert.throws(() => assertAllowedV3State(invalid));
  }
  assert.equal(
    assertAdjacentV3Transition(
      { setup: 'prepared', runtime: 'not_started', cleanup: 'not_started' },
      { setup: 'ready', runtime: 'initial', cleanup: 'not_started' }
    ),
    true
  );
  assert.equal(
    assertAdjacentV3Transition(
      { setup: 'ready', runtime: 'allocation_applied', cleanup: 'attempt_started' },
      { setup: 'ready', runtime: 'allocation_applied', cleanup: 'failed' }
    ),
    true
  );
  assert.throws(() => assertAdjacentV3Transition(
    { setup: 'ready', runtime: 'initial', cleanup: 'not_started' },
    { setup: 'ready', runtime: 'mixed_checkout_complete', cleanup: 'not_started' }
  ));
  assert.throws(() => assertAdjacentV3Transition(
    { setup: 'ready', runtime: 'initial', cleanup: 'not_started' },
    { setup: 'ready', runtime: 'initial', cleanup: 'not_started' }
  ));

  const initial = syntheticV3Manifest({
    state: { setup: 'ready', runtime: 'initial', cleanup: 'not_started' },
  });
  const allocated = buildV3Transition(
    initial,
    { setup: 'ready', runtime: 'allocation_applied', cleanup: 'not_started' },
    {
      ids: { ...initial.ids, allocationIds: [createPrivateId()] },
      budgets: PENDING_TRANSFER_STAGE_BUDGETS.allocation_applied,
    }
  );
  assert.equal(allocated.ids.allocationIds.length, 1);
  assert.throws(
    () => buildV3Transition(
      initial,
      { setup: 'ready', runtime: 'allocation_applied', cleanup: 'not_started' },
      {
        ids: {
          ...initial.ids,
          manufacturerIds: [randomUUID()],
          allocationIds: [createPrivateId()],
        },
        budgets: PENDING_TRANSFER_STAGE_BUDGETS.allocation_applied,
      }
    ),
    /identifiers cannot change/i
  );
});

test('manifest v3 enforces exact identifier and stage budgets including early cleanup', () => {
  const initial = syntheticV3Manifest({
    state: { setup: 'ready', runtime: 'initial', cleanup: 'not_started' },
  });
  const allocated = syntheticV3Manifest({
    state: { setup: 'ready', runtime: 'allocation_applied', cleanup: 'not_started' },
  });
  const completed = syntheticV3Manifest({
    state: { setup: 'ready', runtime: 'mixed_checkout_complete', cleanup: 'not_started' },
  });
  for (const manifest of [initial, allocated, completed]) {
    assert.equal(assertPendingTransferManifestIdBudget(manifest), true);
    const identity = normalizePendingTransferCleanupIdentity(manifest);
    assert.equal(identity.runtimeStage, manifest.state.runtime);
    assert.equal(assertNoDiscoveredCleanupTargets(identity, { ids: identity.ids }), true);
  }
  assert.deepEqual(PENDING_TRANSFER_STAGE_BUDGETS.initial, PENDING_TRANSFER_INITIAL_BUDGET);
  assert.equal(assertPendingTransferStageBudget(clone(PENDING_TRANSFER_STAGE_BUDGETS.initial), 'initial'), true);
  assert.equal(assertPendingTransferStageBudget(clone(PENDING_TRANSFER_STAGE_BUDGETS.allocation_applied), 'allocation_applied'), true);
  assert.equal(assertPendingTransferStageBudget(clone(PENDING_TRANSFER_STAGE_BUDGETS.mixed_checkout_complete), 'mixed_checkout_complete'), true);

  const badManifest = clone(initial);
  badManifest.ids.caulkTransactionIds.pop();
  const privateValue = badManifest.ids.caulkAllocationIds[0];
  assert.throws(
    () => assertPendingTransferManifestIdBudget(badManifest),
    (error) => {
      assert.match(error.message, /identifier budget/i);
      assert.doesNotMatch(error.message, new RegExp(privateValue));
      return true;
    }
  );
  const badManifestBudget = clone(initial);
  badManifestBudget.budgets.manufacturers = 2;
  assert.throws(() => assertPendingTransferManifestIdBudget(badManifestBudget), /row budget/i);
  const badCounts = clone(PENDING_TRANSFER_STAGE_BUDGETS.initial);
  badCounts.caulkCheckouts = 1;
  assert.throws(() => assertPendingTransferStageBudget(badCounts, 'initial'), /row budget/i);
  const identity = normalizePendingTransferCleanupIdentity(initial);
  const discovered = { ids: { ...identity.ids, boxIds: [...identity.ids.boxIds, 'UNLISTED'] } };
  assert.throws(() => assertNoDiscoveredCleanupTargets(identity, discovered), /outside the private manifest/i);
});

test('prepared-manifest publication is exclusive, protected, exact, and CAS transitioned', () => {
  const harness = createPrivateHarness();
  const manifest = syntheticV3Manifest();
  try {
    const lock = acquireV3LifecycleLock(harness.config, manifest.tag, 'create');
    const published = publishInitialV3Manifest(harness.config, manifest);
    assert.equal(published.manifestPath, '<private-v3-artifact>');
    assert.equal(published.durability.fileFsync, 'succeeded');
    assert.equal(published.durability.hardLinkPublication, 'succeeded');
    assert.equal(published.durability.finalTargetBytes, 'verified');
    assert.equal(published.durability.temporaryRemoval, 'succeeded');
    assert.ok(['succeeded', 'unsupported'].includes(published.durability.directoryFsync));
    const paths = getV3ArtifactPaths(harness.config, manifest.tag);
    assert.deepEqual(fs.readFileSync(paths.manifestPath), serializeManifest(manifest));
    assert.equal(verifyPrivateArtifactProtection(paths.manifestPath).ownerOnly, true);
    assert.deepEqual(inspectV3Artifacts(harness.config, manifest.tag, { allowLifecycleLock: true }).manifest.state, manifest.state);

    const ready = buildV3Transition(
      manifest,
      { setup: 'ready', runtime: 'initial', cleanup: 'not_started' },
      { budgets: PENDING_TRANSFER_STAGE_BUDGETS.initial }
    );
    const replaced = replaceV3Manifest(harness.config, manifest, ready);
    assert.deepEqual(replaced.manifest.state, ready.state);
    releaseV3LifecycleLock(lock);
    assert.throws(
      () => acquireV3LifecycleLock(harness.config, manifest.tag, 'create'),
      (error) => error instanceof FixtureSafetyError && error.code === 'V3_NAMESPACE_FROZEN'
    );
  } finally {
    removePrivateHarness(harness.directory);
  }
});

test('post-publication failure retains prepared manifest and freezes the namespace', () => {
  const harness = createPrivateHarness();
  const manifest = syntheticV3Manifest();
  const lock = acquireV3LifecycleLock(harness.config, manifest.tag, 'create');
  const paths = getV3ArtifactPaths(harness.config, manifest.tag);
  const originalUnlink = fs.unlinkSync;
  try {
    fs.unlinkSync = (target) => {
      if (String(target).includes('.v3-publication-')) {
        throw new Error('synthetic unlink failure');
      }
      return originalUnlink(target);
    };
    assert.throws(() => publishInitialV3Manifest(harness.config, manifest));
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  try {
    assert.equal(fs.existsSync(paths.manifestPath), true);
    assert.equal(fs.existsSync(paths.recoveryMarkerPath), true);
    assert.equal(verifyPrivateArtifactProtection(paths.manifestPath).ownerOnly, true);
    assert.equal(lock.released, false);
    assert.throws(() => inspectV3Artifacts(harness.config, manifest.tag), /reviewed recovery/i);
  } finally {
    removePrivateHarness(harness.directory);
  }
});

test('cleanup marker is permanent one-shot freeze evidence', () => {
  const harness = createPrivateHarness();
  const prepared = syntheticV3Manifest();
  try {
    assert.throws(
      () => createCleanupAttemptMarker(harness.config, prepared.tag),
      (error) => error instanceof FixtureSafetyError && error.code === 'V3_LIFECYCLE_LOCK_REQUIRED'
    );
    const createLock = acquireV3LifecycleLock(harness.config, prepared.tag, 'create');
    publishInitialV3Manifest(harness.config, prepared);
    const ready = buildV3Transition(
      prepared,
      { setup: 'ready', runtime: 'initial', cleanup: 'not_started' },
      { budgets: PENDING_TRANSFER_STAGE_BUDGETS.initial }
    );
    replaceV3Manifest(harness.config, prepared, ready);
    releaseV3LifecycleLock(createLock);
    const cleanupLock = acquireV3LifecycleLock(harness.config, ready.tag, 'cleanup');
    const marker = createCleanupAttemptMarker(harness.config, ready.tag);
    assert.equal(marker.fileFsync, 'succeeded');
    releaseV3LifecycleLock(cleanupLock);
    assert.throws(
      () => acquireV3LifecycleLock(harness.config, ready.tag, 'cleanup'),
      (error) => error instanceof FixtureSafetyError && error.code === 'V3_NAMESPACE_FROZEN'
    );
  } finally {
    removePrivateHarness(harness.directory);
  }
});

test('recovery and ambiguity sidecars are exclusive protected freeze evidence', () => {
  const harness = createPrivateHarness();
  const prepared = syntheticV3Manifest();
  try {
    acquireV3LifecycleLock(harness.config, prepared.tag, 'create');
    publishInitialV3Manifest(harness.config, prepared);
    const ambiguity = createCommitAmbiguityMarker(harness.config, prepared.tag);
    const recovery = createRecoveryMarker(harness.config, prepared.tag);
    assert.equal(ambiguity.fileFsync, 'succeeded');
    assert.equal(recovery.fileFsync, 'succeeded');
    assert.throws(
      () => createCommitAmbiguityMarker(harness.config, prepared.tag),
      (error) => error instanceof FixtureSafetyError && error.code === 'PRIVATE_ARTIFACT_CREATE_FAILED'
    );
    assert.throws(() => inspectV3Artifacts(harness.config, prepared.tag), /reviewed recovery/i);
  } finally {
    removePrivateHarness(harness.directory);
  }
});

test('manifest v2 normalization and serialized bytes remain deterministic', () => {
  const input = {
    tag: 'CODEX_DEV_FIXTURE_COMPATIBILITY_123456',
    scenario: 'checked-out-box-job',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:01:00.000Z',
    cleanedAt: '',
    projectRef: 'synthetic-local-ref',
    orgId: '11111111-1111-4111-8111-111111111111',
    ids: {
      jobIds: ['b', 'a', 'a'],
      jobNumbers: ['2', '1'],
      phaseIds: [],
      requirementIds: [],
      allocationIds: [],
      boxIds: ['BOX-B', 'BOX-A'],
      filmOrderIds: [],
    },
    fixtureDealer: { id: '', code: '', name: '' },
    integrity: { dealerTableBefore: { rowCount: 0, fingerprint: `sha256:${'a'.repeat(64)}` } },
    routes: { jobDetails: ['b', 'a'], boxDetails: [], qrPayloads: [] },
    summary: { category: 'synthetic' },
    cleanup: {},
  };
  const normalized = normalizeV2Manifest(input);
  assert.deepEqual(normalizeManifest(input), normalized);
  assert.deepEqual(normalized.ids.jobIds, ['a', 'b']);
  assert.deepEqual(normalized.ids.boxIds, ['BOX-A', 'BOX-B']);
  assert.deepEqual(normalized.routes.jobDetails, ['a', 'b']);
  assert.deepEqual(serializeManifest(input), Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8'));
  assert.equal(normalized.version, 2);
});

test('pending-transfer tooling keeps setup, runtime behavior, and cleanup authority separate', () => {
  const source = fs.readFileSync(FIXTURE_SOURCE_PATH, 'utf8');
  assert.doesNotMatch(source, /\/jobs\/checkout-all|\/jobs\/set-staged-pickup|\/allocations\/apply/);
  assert.match(source, /mutateCaulkStock[\s\S]*action:\s*'RECEIVE'/);
  assert.match(source, /addCaulkAllocation[\s\S]*allocatedTubes:\s*2[\s\S]*transferFromWarehouse/);
  assert.match(source, /widthIn:\s*60[\s\S]*initialFeet:\s*80/);
  assert.match(source, /begin transaction isolation level repeatable read read only/i);
  assert.match(source, /requireExactRows\(rows, 1, 'SET_STATUS audit'\)/);
  assert.match(source, /integer\(row\.allocated_feet\) !== 40/);
  assert.match(source, /'REQUIREMENT'[\s\S]*'MANUAL'[\s\S]*'ACTIVE'/);
  const createBody = source.slice(source.indexOf('async function createPendingTransferCheckoutDenial'));
  assert.ok(
    createBody.indexOf('assertPendingFixtureRootsAvailable(client, config') <
      createBody.indexOf('const fixtureDealer = await createFixtureDealer')
  );
  assert.match(source, /if \(!commitKnown && transactionBodyComplete\)[\s\S]*createCommitAmbiguityMarker/);
  assert.match(source, /postCommitVerification:\s*'failed'[\s\S]*createRecoveryMarker/);

  const orderedDeletes = [
    "'caulkTransfers'",
    "'caulkAllocations'",
    "'filmAllocations'",
    "'caulkTransactions'",
    "'caulkStock'",
    "'caulkRequirements'",
    "'filmRequirements'",
    "'phases'",
    "'auditRows'",
    "'boxes'",
    "'jobs'",
    "'filmCatalog'",
    "'dealer'",
    "'product'",
    "'manufacturer'",
  ];
  let prior = -1;
  for (const marker of orderedDeletes) {
    const next = source.indexOf(marker, prior + 1);
    assert.ok(next > prior, `cleanup category ${marker} is ordered`);
    prior = next;
  }
  const createSource = fs.readFileSync(FIXTURE_CREATE_SOURCE_PATH, 'utf8');
  assert.match(createSource, /--allocation-id-stdin/);
  assert.doesNotMatch(createSource, /--allocation-id(?:\s|=)(?!stdin)/);
  const manifestSource = fs.readFileSync(FIXTURE_MANIFEST_SOURCE_PATH, 'utf8');
  assert.match(manifestSource, /fs\.linkSync\(temporaryPath, paths\.manifestPath\)/);
  assert.doesNotMatch(manifestSource, /copyFileSync\(temporaryPath, paths\.manifestPath\)/);
  assert.match(manifestSource, /stdio:\s*'ignore'/);
});
