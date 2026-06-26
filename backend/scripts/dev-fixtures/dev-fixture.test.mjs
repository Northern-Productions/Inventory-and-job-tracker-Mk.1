import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFixtureTag,
  normalizeFixtureTag,
  parseArgs,
} from './lib/dev-fixture-guard.mjs';
import {
  normalizeManifest,
} from './lib/dev-fixture-manifest.mjs';
import {
  assertSafeFixtureIdentity,
  normalizeFixtureIdentity,
} from './lib/dev-fixture-cleanup-safety.mjs';

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

test('manifest normalization dedupes IDs and keeps only safe local metadata', () => {
  const manifest = normalizeManifest({
    tag: 'CODEX_DEV_FIXTURE_TEST_123456',
    scenario: 'checked-out-box-job',
    ids: {
      boxIds: ['IL1-1', 'IL1-1', 'IL1-2'],
      jobNumbers: ['7001', '7001'],
    },
  });
  assert.deepEqual(manifest.ids.boxIds, ['IL1-1', 'IL1-2']);
  assert.deepEqual(manifest.ids.jobNumbers, ['7001']);
  assert.equal(manifest.tag, 'CODEX_DEV_FIXTURE_TEST_123456');
});

test('cleanup identity combines manifest and discovered IDs without wildcards', () => {
  const identity = normalizeFixtureIdentity({
    tag: 'CODEX_DEV_FIXTURE_TEST_123456',
    manifest: {
      ids: {
        jobIds: ['11111111-1111-4111-8111-111111111111'],
        boxIds: ['IL1-A'],
      },
    },
    discovered: {
      ids: {
        jobIds: ['11111111-1111-4111-8111-111111111111'],
        boxIds: ['IL1-B'],
      },
    },
  });
  assert.deepEqual(identity.ids.boxIds, ['IL1-A', 'IL1-B']);
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
