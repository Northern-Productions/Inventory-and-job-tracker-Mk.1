import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOperationFailure,
  verifyOperationFailure
} from './dev-certified-operation-failure.mjs';

const expected = Object.freeze({
  stage: 'RECOVERY_DATABASE',
  attemptId: 'dev-refresh-synthetic',
  target: 'dev',
  projectRef: 'abcdefghijklmnopqrst',
  contractDigest: `sha256:${'a'.repeat(64)}`
});

test('operation failure preserves only authenticated-safe causal metadata', () => {
  const error = new Error('MANAGED_OVERLAY_EXECUTION_FAILED');
  error.code = 'MANAGED_OVERLAY_EXECUTION_FAILED';
  error.failureSubstep = 'MANAGED_OVERLAY_EXECUTION';
  error.safeDiagnostic = {
    classification: 'POSTGRES_MANAGED_OWNERSHIP_REJECTED',
    sqlState: '42501',
    statementCategory: 'DDL',
    exitCode: 3,
    signal: '',
    overflow: false,
    excerpt: 'psql:C:/private/recovery.sql:25: ERROR: must be owner of table users password=private'
  };
  const failure = buildOperationFailure({ ...expected, error });
  assert.equal(failure.category, 'DEV_REFRESH_REAL_STAGE_MANAGED_OVERLAY_EXECUTION_FAILED');
  assert.equal(failure.cause.substep, 'MANAGED_OVERLAY_EXECUTION');
  assert.equal(failure.cause.diagnostic.exitCode, 3);
  assert.equal(failure.cause.diagnostic.sqlState, '42501');
  assert.equal(verifyOperationFailure(failure, expected), failure);
  assert.doesNotMatch(JSON.stringify(failure), /C:\/private|password=private/i);
});

test('operation failure verification rejects cause tampering and accepts legacy categorical records', () => {
  const legacy = {
    format: 'dev-certified-operation-failure-v1',
    ...expected,
    category: 'DEV_REFRESH_REAL_STAGE_FAILED'
  };
  assert.equal(verifyOperationFailure(legacy, expected), legacy);

  const error = new Error('MANAGED_OVERLAY_EXECUTION_FAILED');
  error.code = 'MANAGED_OVERLAY_EXECUTION_FAILED';
  const failure = buildOperationFailure({ ...expected, error });
  const tampered = structuredClone(failure);
  tampered.cause.diagnostic = {
    classification: 'POSTGRES_CHILD_FAILED',
    sqlState: '',
    statementCategory: 'UNCLASSIFIED_STATEMENT',
    exitCode: null,
    signal: '',
    overflow: false,
    excerpt: 'password=private'
  };
  assert.equal(verifyOperationFailure(tampered, expected), null);
});
