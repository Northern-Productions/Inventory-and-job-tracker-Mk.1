import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readCompatibleJson,
  writeJsonAtomic
} from './release-integrity-artifacts.mjs';
import {
  AUTH_FINGERPRINT_POLICY_VERSION,
  AUTH_USER_COLUMN_POLICY,
  PROTECTED_PROFILE_VERSION,
  ROW_FINGERPRINT_ALGORITHM,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  assertAuthUserColumnPolicy,
  assertProtectedColumnPolicy,
  buildCanonicalRowExpression,
  buildTableAggregateSql,
  findSensitiveColumns,
  normalizeAggregateResult,
  resolveDigestFunction,
  validateSnapshot
} from './release-integrity.mjs';

const AUTH_COLUMNS = Object.freeze([
  'instance_id',
  'id',
  'aud',
  'role',
  'email',
  'encrypted_password',
  'email_confirmed_at',
  'invited_at',
  'confirmation_token',
  'confirmation_sent_at',
  'recovery_token',
  'recovery_sent_at',
  'email_change_token_new',
  'email_change',
  'email_change_sent_at',
  'last_sign_in_at',
  'raw_app_meta_data',
  'raw_user_meta_data',
  'is_super_admin',
  'created_at',
  'updated_at',
  'phone',
  'phone_confirmed_at',
  'phone_change',
  'phone_change_token',
  'phone_change_sent_at',
  'confirmed_at',
  'email_change_token_current',
  'email_change_confirm_status',
  'banned_until',
  'reauthentication_token',
  'reauthentication_sent_at',
  'is_sso_user',
  'deleted_at',
  'is_anonymous'
]);

const INCLUDED_AUTH_COLUMNS = Object.freeze([
  'instance_id',
  'id',
  'aud',
  'role',
  'email_confirmed_at',
  'invited_at',
  'is_super_admin',
  'created_at',
  'phone_confirmed_at',
  'confirmed_at',
  'email_change_confirm_status',
  'banned_until',
  'is_sso_user',
  'deleted_at',
  'is_anonymous'
]);

const EXCLUDED_AUTH_COLUMNS = AUTH_COLUMNS.filter(
  (columnName) => !INCLUDED_AUTH_COLUMNS.includes(columnName)
);

function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-integrity-security-'));
  try {
    return callback(directory);
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(resolved.startsWith(path.resolve(os.tmpdir())), true);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test('every guarded DEV auth.users column has an explicit reviewed classification', () => {
  assert.deepEqual(Object.keys(AUTH_USER_COLUMN_POLICY), [...AUTH_COLUMNS]);
  assert.deepEqual(assertAuthUserColumnPolicy(AUTH_COLUMNS), [...INCLUDED_AUTH_COLUMNS]);

  const classifications = new Set(
    Object.values(AUTH_USER_COLUMN_POLICY).map((entry) => entry.classification)
  );
  assert.equal(
    Object.values(AUTH_USER_COLUMN_POLICY).every((entry) => String(entry.reason).trim().length > 0),
    true
  );
  assert.deepEqual(classifications, new Set([
    'included_structural',
    'excluded_credential',
    'excluded_token',
    'excluded_volatile',
    'excluded_personal_data',
    'excluded_metadata'
  ]));
});

test('unknown auth.users columns fail closed by column name only', () => {
  assert.throws(
    () => assertAuthUserColumnPolicy([...AUTH_COLUMNS, 'new_auth_state']),
    /Unclassified auth\.users columns: new_auth_state/
  );
});

test('Auth canonicalization includes stable structure and excludes credentials, tokens, PII, metadata, and login activity', () => {
  const expression = buildCanonicalRowExpression(
    { schema: 'auth', table: 'users' },
    AUTH_COLUMNS
  );

  for (const columnName of INCLUDED_AUTH_COLUMNS) {
    assert.match(expression, new RegExp(`"${columnName}"`));
  }
  for (const columnName of EXCLUDED_AUTH_COLUMNS) {
    assert.equal(expression.includes(`"${columnName}"`), false);
  }
  assert.doesNotMatch(expression, /to_jsonb\s*\(\s*source_row\s*\)/i);
  assert.doesNotMatch(expression, /row_to_json\s*\(\s*source_row\s*\)/i);
});

test('ordinary sign-in and Auth delivery timestamps cannot influence the Auth fingerprint', () => {
  for (const columnName of [
    'last_sign_in_at',
    'updated_at',
    'confirmation_sent_at',
    'recovery_sent_at',
    'email_change_sent_at',
    'phone_change_sent_at',
    'reauthentication_sent_at'
  ]) {
    assert.equal(AUTH_USER_COLUMN_POLICY[columnName].classification, 'excluded_volatile');
  }
});

test('credential and token Auth columns are always excluded', () => {
  assert.equal(AUTH_USER_COLUMN_POLICY.encrypted_password.classification, 'excluded_credential');
  for (const columnName of [
    'confirmation_token',
    'recovery_token',
    'email_change_token_new',
    'phone_change_token',
    'email_change_token_current',
    'reauthentication_token'
  ]) {
    assert.equal(AUTH_USER_COLUMN_POLICY[columnName].classification, 'excluded_token');
  }
});

test('sensitive-looking app columns fail closed without broad substring matches', () => {
  assert.deepEqual(
    findSensitiveColumns([
      'id',
      'api_key',
      'session_token',
      'credentials',
      'confirmation_code',
      'tokenized_label'
    ]),
    ['api_key', 'session_token', 'credentials', 'confirmation_code']
  );
  assert.throws(
    () =>
      assertProtectedColumnPolicy(
        { schema: 'app', table: 'example' },
        ['id', 'private_key']
      ),
    /app\.example.*private_key/
  );
});

test('Auth aggregate SQL is database-only SHA-256 and returns no per-row result', () => {
  const sql = buildTableAggregateSql(
    { schema: 'auth', table: 'users' },
    AUTH_COLUMNS,
    'extensions.digest'
  );

  assert.match(sql, /jsonb_build_object/i);
  assert.match(sql, /string_agg\(row_digest, '' order by row_digest\)/i);
  assert.match(sql, /extensions\.digest/i);
  assert.match(sql, /select\s+row_count,/i);
  assert.doesNotMatch(
    sql,
    /\b(?:declare|fetch|insert|update|delete|merge|truncate|call)\b|row_hash/i
  );
  assert.doesNotMatch(sql, /to_jsonb\s*\(\s*source_row\s*\)/i);
  for (const columnName of EXCLUDED_AUTH_COLUMNS) {
    assert.equal(sql.includes(`"${columnName}"`), false);
  }
});

test('database aggregate result shape permits only count and final digest', () => {
  const table = { schema: 'auth', table: 'users' };
  const normalized = normalizeAggregateResult(
    { rows: [{ row_count: '2', fingerprint: 'a'.repeat(64) }] },
    table
  );
  assert.deepEqual(normalized, {
    name: 'auth.users',
    rowCount: 2,
    fingerprint: `sha256:${'a'.repeat(64)}`
  });

  assert.throws(
    () =>
      normalizeAggregateResult(
        { rows: [{ row_count: '2', fingerprint: 'a'.repeat(64), raw_value: 'blocked' }] },
        table
      ),
    /contains unsupported fields/
  );
  assert.throws(
    () => normalizeAggregateResult({ rows: [] }, table),
    /exactly one aggregate row/
  );
});

test('SHA-256 support is required and never installed by the tool', async () => {
  assert.equal(
    await resolveDigestFunction({
      query: async () => ({ rows: [{ digest_function: 'extensions.digest' }] })
    }),
    'extensions.digest'
  );
  await assert.rejects(
    resolveDigestFunction({ query: async () => ({ rows: [{ digest_function: null }] }) }),
    /unavailable.*without creating an extension/
  );
});

test('snapshot and protected profiles are versioned beyond the unsafe implementation', () => {
  assert.equal(SNAPSHOT_VERSION, 2);
  assert.equal(PROTECTED_PROFILE_VERSION, 2);
  assert.equal(AUTH_FINGERPRINT_POLICY_VERSION, 1);
  assert.equal(ROW_FINGERPRINT_ALGORITHM, 'sha256-over-sorted-sha256-jsonb-v2');
});

test('old snapshots are rejected as incompatible before comparison', () => {
  assert.throws(
    () => validateSnapshot({ format: SNAPSHOT_FORMAT, version: 1 }, 'old snapshot'),
    /fingerprint profile is incompatible/
  );

  withTempDir((directory) => {
    const oldPath = path.join(directory, 'old.json');
    fs.writeFileSync(
      oldPath,
      `${JSON.stringify({ format: SNAPSHOT_FORMAT, version: 1, legacy_payload: 'not-read' })}\n`,
      'utf8'
    );
    assert.throws(
      () =>
        readCompatibleJson(oldPath, {
          format: SNAPSHOT_FORMAT,
          version: SNAPSHOT_VERSION,
          label: 'old snapshot'
        }),
      /fingerprint profile is incompatible/
    );
  });
});

test('atomic snapshot publication creates one complete final file and no temporary file', () => {
  withTempDir((directory) => {
    const finalPath = path.join(directory, 'snapshot.json');
    writeJsonAtomic(finalPath, { format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION }, {
      allowedRoot: directory,
      uniqueId: () => 'success'
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(finalPath, 'utf8')), {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION
    });
    assert.deepEqual(fs.readdirSync(directory), ['snapshot.json']);
  });
});

test('atomic snapshot publication refuses overwrite and preserves the existing file', () => {
  withTempDir((directory) => {
    const finalPath = path.join(directory, 'snapshot.json');
    fs.writeFileSync(finalPath, 'existing\n', 'utf8');

    assert.throws(
      () => writeJsonAtomic(finalPath, { replacement: true }, { allowedRoot: directory }),
      /Refusing to overwrite/
    );
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'existing\n');
  });
});

test('simulated atomic write failure leaves no final or temporary snapshot', () => {
  withTempDir((directory) => {
    const finalPath = path.join(directory, 'snapshot.json');
    const fsApi = {
      ...fs,
      writeFileSync() {
        throw new Error('simulated write failure');
      }
    };

    assert.throws(
      () =>
        writeJsonAtomic(finalPath, { value: true }, {
          allowedRoot: directory,
          fsApi,
          uniqueId: () => 'failure'
        }),
      /simulated write failure/
    );
    assert.equal(fs.existsSync(finalPath), false);
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

test('simulated atomic publication failure cleans the complete temporary snapshot', () => {
  withTempDir((directory) => {
    const finalPath = path.join(directory, 'snapshot.json');
    const fsApi = {
      ...fs,
      linkSync() {
        throw new Error('simulated publication failure');
      }
    };

    assert.throws(
      () =>
        writeJsonAtomic(finalPath, { value: true }, {
          allowedRoot: directory,
          fsApi,
          uniqueId: () => 'publish-failure'
        }),
      /simulated publication failure/
    );
    assert.equal(fs.existsSync(finalPath), false);
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

test('atomic writer rejects destinations outside the approved directory', () => {
  withTempDir((directory) => {
    const outsidePath = path.join(path.dirname(directory), 'outside-snapshot.json');
    assert.throws(
      () => writeJsonAtomic(outsidePath, {}, { allowedRoot: directory }),
      /approved artifact directory/
    );
    assert.equal(fs.existsSync(outsidePath), false);
  });
});
