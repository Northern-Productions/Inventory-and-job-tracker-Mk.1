import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertFixtureDealerAvailable,
  buildFixtureDealerIdentity,
  buildFixtureTag,
  normalizeFixtureTag,
  parseArgs,
  requireScenario,
} from './lib/dev-fixture-guard.mjs';
import {
  normalizeManifest,
} from './lib/dev-fixture-manifest.mjs';
import {
  assertSafeFixtureIdentity,
  dealerTableIntegrityMatches,
  normalizeFixtureIdentity,
} from './lib/dev-fixture-cleanup-safety.mjs';

const FIXTURE_SOURCE_PATH = new URL('./lib/dev-fixture-scenarios.mjs', import.meta.url);
const OWNER_AUTH_SOURCE_PATH = new URL('../create-dev-owner-browser-auth-state.mjs', import.meta.url);

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
