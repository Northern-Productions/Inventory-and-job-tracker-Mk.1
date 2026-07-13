import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ROW_FINGERPRINT_ALGORITHM,
  SCHEMA_FINGERPRINT_ALGORITHM,
  SNAPSHOT_FORMAT,
  buildSnapshot,
  compareSnapshots,
  quoteIdentifier,
  sha256,
  validateSnapshot
} from './release-integrity.mjs';

const DEV_REF = 'uxiltcpbhthhinonttrc';
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(TEST_DIR, '..', '..');
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');

function databaseState({
  jobsRows = 3,
  jobsFingerprint = sha256('jobs-v1'),
  jobsSchemaFingerprint = sha256('jobs-schema-v1'),
  authRows = 2,
  authFingerprint = sha256('auth-users-v1'),
  migrationVersions = ['20260101000000']
} = {}) {
  const jobsSchema = {
    name: 'app.jobs',
    columnCount: 8,
    fingerprint: jobsSchemaFingerprint
  };
  const usersSchema = {
    name: 'auth.users',
    columnCount: 20,
    fingerprint: sha256('auth-users-schema-v1')
  };
  return {
    migrationState: {
      versions: migrationVersions,
      fingerprint: sha256(migrationVersions.join('\n'))
    },
    schemaState: {
      algorithm: SCHEMA_FINGERPRINT_ALGORITHM,
      fingerprint: sha256(
        [jobsSchema, usersSchema].map((table) => `${table.name}:${table.fingerprint}`).join('\n')
      ),
      tables: [jobsSchema, usersSchema]
    },
    protectedData: {
      tables: [
        {
          name: 'app.jobs',
          rowCount: jobsRows,
          fingerprint: jobsFingerprint
        },
        {
          name: 'auth.users',
          rowCount: authRows,
          fingerprint: authFingerprint
        }
      ]
    }
  };
}

function snapshot(phase, overrides = {}) {
  return buildSnapshot({
    phase,
    capturedAt: phase === 'pre' ? '2026-07-12T12:00:00.000Z' : '2026-07-12T12:05:00.000Z',
    target: {
      environment: overrides.environment || 'dev',
      projectRef: overrides.projectRef || DEV_REF
    },
    source: {
      gitCommit: 'd4c2a204c80bbee764e4d12e72247d44eaca0a1e',
      gitBranch: 'release/example',
      workingTreeClean: true
    },
    databaseState: databaseState(overrides)
  });
}

test('buildSnapshot emits only the supported aggregate contract', () => {
  const value = snapshot('pre');

  assert.equal(value.format, SNAPSHOT_FORMAT);
  assert.equal(value.coverage.rowFingerprintAlgorithm, ROW_FINGERPRINT_ALGORITHM);
  assert.equal(value.protectedData.tables[0].rowCount, 3);
  assert.deepEqual(Object.keys(value.protectedData.tables[0]).sort(), [
    'fingerprint',
    'name',
    'rowCount'
  ]);
  assert.equal(JSON.stringify(value).includes('rowContents'), false);
});

test('strict comparison passes identical protected state', () => {
  const result = compareSnapshots(snapshot('pre'), snapshot('post'), { policy: 'strict' });

  assert.equal(result.status, 'pass');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.changes.data, []);
});

test('strict comparison fails protected changes unless the exact table is approved', () => {
  const before = snapshot('pre');
  const after = snapshot('post', { jobsRows: 4, jobsFingerprint: sha256('jobs-v2') });

  const blocked = compareSnapshots(before, after, { policy: 'strict' });
  assert.equal(blocked.status, 'failed');
  assert.deepEqual(blocked.unapproved.data, ['app.jobs']);

  const approved = compareSnapshots(before, after, {
    policy: 'strict',
    allowedTables: ['app.jobs']
  });
  assert.equal(approved.status, 'pass');
  assert.deepEqual(approved.unapproved.data, []);
});

test('strict comparison requires exact migration and schema approvals', () => {
  const before = snapshot('pre');
  const after = snapshot('post', {
    jobsSchemaFingerprint: sha256('jobs-schema-v2'),
    migrationVersions: ['20260101000000', '20260102000000']
  });

  const blocked = compareSnapshots(before, after, { policy: 'strict' });
  assert.equal(blocked.status, 'failed');
  assert.deepEqual(blocked.unapproved.schema, ['app.jobs']);
  assert.deepEqual(blocked.unapproved.migrations, ['20260102000000']);

  const approved = compareSnapshots(before, after, {
    policy: 'strict',
    allowedSchemaTables: ['app.jobs'],
    allowedMigrations: ['20260102000000']
  });
  assert.equal(approved.status, 'pass');
});

test('Auth structural changes are detected even when account count is unchanged', () => {
  const result = compareSnapshots(
    snapshot('pre'),
    snapshot('post', { authFingerprint: sha256('auth-role-or-disable-change') }),
    { policy: 'strict' }
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.unapproved.data, ['auth.users']);
  assert.equal(result.changes.data[0].beforeCount, 2);
  assert.equal(result.changes.data[0].afterCount, 2);
});

test('Auth account insert or delete is detected through aggregate count and fingerprint', () => {
  const result = compareSnapshots(
    snapshot('pre'),
    snapshot('post', { authRows: 3, authFingerprint: sha256('auth-account-added') }),
    { policy: 'observe' }
  );

  assert.equal(result.status, 'review-required');
  assert.equal(result.changes.data[0].name, 'auth.users');
  assert.equal(result.changes.data[0].beforeCount, 2);
  assert.equal(result.changes.data[0].afterCount, 3);
});

test('observe comparison returns review-required without claiming failure', () => {
  const result = compareSnapshots(
    snapshot('pre'),
    snapshot('post', { jobsFingerprint: sha256('legitimate-live-change') }),
    { policy: 'observe' }
  );

  assert.equal(result.status, 'review-required');
  assert.equal(result.exitCode, 2);
  assert.equal(result.hardFailures.length, 0);
});

test('target mismatch is a hard failure in observe mode', () => {
  const result = compareSnapshots(
    snapshot('pre'),
    snapshot('post', { environment: 'prod', projectRef: 'tiwpulgvxtwlmqdnyuzd' }),
    { policy: 'observe' }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.match(result.hardFailures.join(' '), /Target environment mismatch/);
  assert.match(result.hardFailures.join(' '), /Target project ref mismatch/);
});

test('snapshot validation rejects malformed fingerprints and phase ordering', () => {
  const malformed = snapshot('pre');
  malformed.protectedData.tables[0].fingerprint = 'not-a-fingerprint';
  assert.throws(() => validateSnapshot(malformed), /valid SHA-256 fingerprint/);

  const extraData = snapshot('pre');
  extraData.protectedData.tables[0].rows = [{ email: 'must-not-be-stored' }];
  assert.throws(() => validateSnapshot(extraData), /contains unsupported fields/);

  assert.throws(
    () => compareSnapshots(snapshot('post'), snapshot('pre'), { policy: 'strict' }),
    /pre snapshot followed by a post snapshot/
  );

  const earlyPost = snapshot('post');
  earlyPost.capturedAt = '2026-07-12T11:59:00.000Z';
  assert.throws(
    () => compareSnapshots(snapshot('pre'), earlyPost, { policy: 'strict' }),
    /pre snapshot to be captured before the post snapshot/
  );
});

test('SQL identifiers are quoted rather than interpolated raw', () => {
  assert.equal(quoteIdentifier('jobs'), '"jobs"');
  assert.equal(quoteIdentifier('odd"name'), '"odd""name"');
  assert.throws(() => quoteIdentifier(''), /Invalid SQL identifier/);
});

test('compare CLI returns distinct strict-failure and observe-review exit codes', () => {
  const artifactRoot = path.join(REPO_ROOT, '.codex-runlogs', 'release-integrity');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(artifactRoot, 'cli-test-'));
  const beforePath = path.join(runDir, 'pre.json');
  const afterPath = path.join(runDir, 'post.json');
  const oldPath = path.join(runDir, 'old.json');
  fs.writeFileSync(beforePath, `${JSON.stringify(snapshot('pre'))}\n`, 'utf8');
  fs.writeFileSync(
    afterPath,
    `${JSON.stringify(snapshot('post', { jobsFingerprint: sha256('changed') }))}\n`,
    'utf8'
  );
  fs.writeFileSync(
    oldPath,
    `${JSON.stringify({ format: SNAPSHOT_FORMAT, version: 1, legacy_payload: 'must-not-display' })}\n`,
    'utf8'
  );

  try {
    const runCompare = (policy, selectedBeforePath = beforePath) =>
      spawnSync(
        process.execPath,
        [
          path.join(BACKEND_DIR, 'scripts', 'release-integrity.mjs'),
          '--mode',
          'compare',
          '--before',
          selectedBeforePath,
          '--after',
          afterPath,
          '--policy',
          policy
        ],
        { cwd: BACKEND_DIR, encoding: 'utf8' }
      );

    const strict = runCompare('strict');
    assert.equal(strict.status, 1);
    assert.match(strict.stdout, /result: FAILED/);
    assert.equal(strict.stderr, '');

    const observe = runCompare('observe');
    assert.equal(observe.status, 2);
    assert.match(observe.stdout, /result: REVIEW_REQUIRED/);
    assert.match(observe.stdout, /does not claim corruption/);
    assert.equal(observe.stderr, '');

    const incompatible = runCompare('strict', oldPath);
    assert.equal(incompatible.status, 1);
    assert.match(incompatible.stderr, /fingerprint profile is incompatible/);
    assert.equal(incompatible.stderr.includes('must-not-display'), false);
    assert.equal(incompatible.stdout.includes('must-not-display'), false);
  } finally {
    const relative = path.relative(artifactRoot, runDir);
    assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
