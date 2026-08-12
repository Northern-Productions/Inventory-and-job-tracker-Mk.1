import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalDigest,
  canonicalSerialize,
  categoricalDistribution,
  compareDisjoint,
  compareMultisets,
  compareNullSafe,
  compareOrderedProjection,
  compareSets,
  compareSubset,
  READONLY_DIAGNOSTIC_EXECUTION_FAILED,
  READONLY_DIAGNOSTIC_LOGICAL_MISMATCH,
  READONLY_DIAGNOSTIC_PASSED,
  READONLY_DIAGNOSTIC_REJECTED_UNSAFE,
  READONLY_DIAGNOSTIC_ROLLBACK_FAILED,
  READONLY_DIAGNOSTIC_TARGET_MISMATCH,
  runReadonlyDiagnostic,
  sealDiagnosticInventory,
  serializeDiagnosticReport,
  validateDiagnosticInventory
} from './readonly-diagnostics.mjs';
import { validateReadonlySql } from './readonly-diagnostics-sql.mjs';
import { REPOSITORY_READONLY_CHARACTERIZATION } from './readonly-diagnostics-characterizations.mjs';

function statement(overrides = {}) {
  return {
    id: 'scalar_check',
    sql: 'SELECT 1::integer AS value',
    parameters: [],
    expectedShape: 'scalar',
    assertions: [{ id: 'value_matches', kind: 'scalar_equals', column: 'value', expected: 1 }],
    dependsOn: [],
    output: { mode: 'categorical', metrics: ['row_count', 'assertion_counts'] },
    maximumExecutions: 1,
    ...overrides
  };
}

function inventory(statements = [statement()], overrides = {}) {
  return sealDiagnosticInventory({
    schemaVersion: 1,
    name: 'unit-diagnostic',
    version: 1,
    target: { category: 'local' },
    bounds: {
      maxStatements: 64,
      statementTimeoutMs: 1000,
      totalTimeoutMs: 5000,
      maxRows: 100,
      maxPayloadBytes: 65_536
    },
    statements,
    ...overrides
  });
}

class FakeClient {
  constructor({ rows = new Map(), failSql = '', beginFailure = null, rollbackFailure = false, readOnly = 'on' } = {}) {
    this.rows = rows;
    this.failSql = failSql;
    this.beginFailure = beginFailure;
    this.rollbackFailure = rollbackFailure;
    this.readOnly = readOnly;
    this.calls = [];
    this.connected = false;
    this.closed = false;
  }

  async connect() {
    this.connected = true;
  }

  async query(input) {
    const text = typeof input === 'string' ? input : input.text;
    this.calls.push({ text, values: typeof input === 'string' ? [] : input.values });
    if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
      if (this.beginFailure) throw this.beginFailure;
      return { command: 'BEGIN', rows: [] };
    }
    if (text === 'SHOW transaction_read_only') return { command: 'SHOW', rows: [{ transaction_read_only: this.readOnly }] };
    if (text === 'SET LOCAL search_path TO pg_catalog') return { command: 'SET', rows: [] };
    if (text === 'ROLLBACK') {
      if (this.rollbackFailure) throw new Error('synthetic rollback failure');
      return { command: 'ROLLBACK', rows: [] };
    }
    if (text.includes('txid_current_if_assigned')) return { command: 'SELECT', rows: [{ transaction_inactive: true }] };
    if (text === this.failSql) throw new Error('private database detail must not escape');
    const value = this.rows.get(text);
    if (value instanceof Error) throw value;
    return { command: 'SELECT', rows: value || [{ value: 1 }] };
  }

  async end() {
    this.closed = true;
  }
}

const LOCAL_TARGET = Object.freeze({ category: 'local', host: '127.0.0.1' });

test('safe scalar SELECT passes in a proven read-only transaction with explicit rollback', async () => {
  const client = new FakeClient();
  const report = await runReadonlyDiagnostic({ inventory: inventory(), client, target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_PASSED);
  assert.equal(report.transaction.readOnlyProven, true);
  assert.equal(report.transaction.searchPathGuarded, true);
  assert.equal(report.transaction.rollback, 'SUCCEEDED');
  assert.equal(report.transaction.rollbackProven, true);
  assert.equal(client.calls.filter((call) => call.text === 'ROLLBACK').length, 1);
  assert.equal(client.closed, true);
});

test('safe multi-statement inventory executes every statement exactly once', async () => {
  const statements = [
    statement(),
    statement({ id: 'second_check', sql: 'SELECT 2::integer AS value', assertions: [{ id: 'second_matches', kind: 'scalar_equals', column: 'value', expected: 2 }] })
  ];
  const client = new FakeClient({ rows: new Map([['SELECT 2::integer AS value', [{ value: 2 }]]]) });
  const report = await runReadonlyDiagnostic({ inventory: inventory(statements), client, target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_PASSED);
  assert.equal(report.statements.length, 2);
  assert.equal(client.calls.filter((call) => call.text.startsWith('SELECT ') && !call.text.includes('txid_')).length, 2);
});

test('logical mismatch retains the snapshot and later evidence', async () => {
  const statements = [
    statement({ assertions: [{ id: 'mismatch', kind: 'scalar_equals', column: 'value', expected: 4 }] }),
    statement({ id: 'later_evidence', sql: 'SELECT 2::integer AS value', assertions: [{ id: 'later_passes', kind: 'scalar_equals', column: 'value', expected: 2 }] })
  ];
  const client = new FakeClient({ rows: new Map([['SELECT 2::integer AS value', [{ value: 2 }]]]) });
  const report = await runReadonlyDiagnostic({ inventory: inventory(statements), client, target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_LOGICAL_MISMATCH);
  assert.deepEqual(report.statements.map((entry) => entry.result), ['LOGICAL_MISMATCH', 'PASS']);
  assert.equal(report.transaction.rollbackProven, true);
});

test('hard dependency blocks only the dependent evidence after a mismatch', async () => {
  const statements = [
    statement({ assertions: [{ id: 'mismatch', kind: 'scalar_equals', column: 'value', expected: 4 }] }),
    statement({ id: 'dependent', sql: 'SELECT 2::integer AS value', dependsOn: ['scalar_check'], assertions: [{ id: 'dependent_passes', kind: 'scalar_equals', column: 'value', expected: 2 }] }),
    statement({ id: 'independent', sql: 'SELECT 3::integer AS value', assertions: [{ id: 'independent_passes', kind: 'scalar_equals', column: 'value', expected: 3 }] })
  ];
  const client = new FakeClient({ rows: new Map([
    ['SELECT 2::integer AS value', [{ value: 2 }]],
    ['SELECT 3::integer AS value', [{ value: 3 }]]
  ]) });
  const report = await runReadonlyDiagnostic({ inventory: inventory(statements), client, target: LOCAL_TARGET });
  assert.deepEqual(report.statements.map((entry) => entry.result), ['LOGICAL_MISMATCH', 'DEPENDENCY_BLOCKED', 'PASS']);
});

test('SQL execution failure is classified and rolled back', async () => {
  const client = new FakeClient({ failSql: 'SELECT 1::integer AS value' });
  const report = await runReadonlyDiagnostic({ inventory: inventory(), client, target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_EXECUTION_FAILED);
  assert.equal(report.failure.code, 'SQL_EXECUTION_FAILED');
  assert.equal(report.transaction.rollbackProven, true);
});

test('ambiguous BEGIN failure is redacted and explicitly rolled back', async () => {
  const error = new Error('private begin detail must not escape');
  error.code = 'private_identifier_must_not_escape';
  const client = new FakeClient({ beginFailure: error });
  const report = await runReadonlyDiagnostic({ inventory: inventory(), client, target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_EXECUTION_FAILED);
  assert.equal(report.failure.code, 'SQL_EXECUTION_FAILED');
  assert.equal(report.transaction.begun, false);
  assert.equal(report.transaction.rollbackProven, true);
  assert.equal(client.calls.filter((call) => call.text === 'ROLLBACK').length, 1);
  assert.equal(serializeDiagnosticReport(report).includes('private'), false);
});

const unsafeSqlCases = [
  ['INSERT rejection', 'WITH incoming AS (SELECT 1) INSERT INTO app.items SELECT * FROM incoming'],
  ['UPDATE rejection', 'WITH rows AS (SELECT 1) UPDATE app.items SET value = 1'],
  ['DELETE rejection', 'WITH rows AS (SELECT 1) DELETE FROM app.items'],
  ['DDL rejection', 'CREATE TABLE unsafe(value integer)'],
  ['temporary object rejection', 'CREATE TEMP TABLE unsafe(value integer)'],
  ['advisory lock rejection', 'SELECT pg_advisory_lock(1)'],
  ['CTE-hidden write rejection', 'WITH changed AS (DELETE FROM app.items RETURNING *) SELECT * FROM changed'],
  ['transaction control rejection', 'COMMIT'],
  ['MERGE rejection', 'MERGE INTO app.items USING app.other ON true WHEN MATCHED THEN DELETE'],
  ['TRUNCATE rejection', 'TRUNCATE app.items'],
  ['GRANT rejection', 'GRANT SELECT ON app.items TO public'],
  ['REVOKE rejection', 'REVOKE SELECT ON app.items FROM public'],
  ['COPY rejection', "COPY app.items TO 'private-path'"],
  ['session role rejection', 'SET ROLE service_role'],
  ['maintenance rejection', 'VACUUM app.items'],
  ['multiple statement rejection', 'SELECT 1; SELECT 2'],
  ['unknown function rejection', 'SELECT app.unknown_business_function()'],
  ['SELECT INTO rejection', 'SELECT 1 INTO unsafe_table'],
  ['row lock rejection', 'SELECT value FROM app.items FOR UPDATE'],
  ['dollar-quoted body rejection', 'SELECT $tag$DELETE FROM app.items$tag$']
];

for (const [name, sql] of unsafeSqlCases) {
  test(name, async () => {
    const client = new FakeClient();
    const report = await runReadonlyDiagnostic({ inventory: inventory([statement({ sql })]), client, target: LOCAL_TARGET });
    assert.equal(report.classification, READONLY_DIAGNOSTIC_REJECTED_UNSAFE);
    assert.equal(client.connected, false);
    assert.equal(client.calls.length, 0);
  });
}

test('approved pg_catalog stable read-only function is accepted', () => {
  const result = validateReadonlySql('SELECT pg_catalog.current_database() AS database_category');
  assert.deepEqual(result.functionNames, ['pg_catalog.current_database']);
});

test('comments and string literals cannot smuggle forbidden operations', () => {
  assert.doesNotThrow(() => validateReadonlySql("SELECT '-- DELETE'::text AS safe_value /* UPDATE */"));
});

test('typed parameters bind in declared order without appearing in output', async () => {
  const sql = 'SELECT $1::uuid AS private_value, $2::boolean AS enabled';
  const privateValue = '01890f3a-49d2-7e01-9123-123456789abc';
  const item = statement({
    sql,
    parameters: [
      { name: 'private_value', type: 'uuid', nullable: false },
      { name: 'enabled', type: 'boolean', nullable: false }
    ],
    assertions: [{ id: 'one_row', kind: 'row_count_equals', expected: 1 }]
  });
  const client = new FakeClient({ rows: new Map([[sql, [{ private_value: privateValue, enabled: true }]]]) });
  const report = await runReadonlyDiagnostic({
    inventory: inventory([item]), client, target: LOCAL_TARGET,
    parameters: { scalar_check: { private_value: privateValue, enabled: true } }
  });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_PASSED);
  assert.deepEqual(client.calls.find((call) => call.text === sql).values, [privateValue, true]);
  assert.equal(JSON.stringify(report).includes(privateValue), false);
});

test('array, bigint, date, and timestamp parameters retain explicit typed order', async () => {
  const sql = 'SELECT $1::text[] AS labels, $2::bigint AS amount, $3::date AS day, $4::timestamptz AS instant';
  const item = statement({
    sql,
    parameters: [
      { name: 'labels', type: 'text[]', nullable: false, maxItems: 4, maxLength: 16 },
      { name: 'amount', type: 'bigint', nullable: false },
      { name: 'day', type: 'date', nullable: false },
      { name: 'instant', type: 'timestamp', nullable: false }
    ],
    assertions: [{ id: 'one_row', kind: 'row_count_equals', expected: 1 }]
  });
  const supplied = { labels: ['safe', 'category'], amount: '9007199254740993', day: '2026-08-11', instant: '2026-08-11T12:00:00Z' };
  const client = new FakeClient({ rows: new Map([[sql, [{ labels: supplied.labels, amount: supplied.amount, day: supplied.day, instant: supplied.instant }]]]) });
  const report = await runReadonlyDiagnostic({ inventory: inventory([item]), client, target: LOCAL_TARGET, parameters: { scalar_check: supplied } });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_PASSED);
  assert.deepEqual(client.calls.find((call) => call.text === sql).values, Object.values(supplied));
});

const invalidParameterCases = [
  ['count', {}],
  ['type', { amount: '1' }],
  ['nullability', { amount: null }]
];
for (const [name, supplied] of invalidParameterCases) {
  test(`parameter ${name} failure occurs before client construction`, async () => {
    const item = statement({
      sql: 'SELECT $1::integer AS value',
      parameters: [{ name: 'amount', type: 'integer', nullable: false }]
    });
    const client = new FakeClient();
    const report = await runReadonlyDiagnostic({ inventory: inventory([item]), client, target: LOCAL_TARGET, parameters: { scalar_check: supplied } });
    assert.equal(report.classification, READONLY_DIAGNOSTIC_REJECTED_UNSAFE);
    assert.equal(client.connected, false);
  });
}

test('statement-count bound is enforced before execution', async () => {
  const constrained = inventory([
    statement(),
    statement({ id: 'second_check', sql: 'SELECT 2::integer AS value' })
  ], { bounds: { maxStatements: 1, statementTimeoutMs: 1000, totalTimeoutMs: 5000, maxRows: 100, maxPayloadBytes: 65_536 } });
  const client = new FakeClient();
  const report = await runReadonlyDiagnostic({ inventory: constrained, client, target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_REJECTED_UNSAFE);
  assert.equal(client.calls.length, 0);
});

test('per-statement timeout is classified and rolled back', async () => {
  const timeout = new Error('private timeout detail');
  timeout.name = 'QueryTimeoutError';
  const client = new FakeClient({ rows: new Map([['SELECT 1::integer AS value', timeout]]) });
  const report = await runReadonlyDiagnostic({ inventory: inventory(), client, target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_EXECUTION_FAILED);
  assert.equal(report.failure.code, 'STATEMENT_TIMEOUT');
  assert.equal(report.transaction.rollbackProven, true);
});

test('total timeout is enforced before the next statement and rolled back', async () => {
  const ticks = [0, 5001];
  const report = await runReadonlyDiagnostic({
    inventory: inventory(),
    client: new FakeClient(),
    target: LOCAL_TARGET,
    now: () => ticks.shift() ?? 5001
  });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_EXECUTION_FAILED);
  assert.equal(report.failure.code, 'TOTAL_TIMEOUT_EXCEEDED');
  assert.equal(report.transaction.rollbackProven, true);
});

test('row bound and payload bound fail closed', async (t) => {
  await t.test('row bound', async () => {
    const bounded = inventory([statement({ expectedShape: 'rows', assertions: [{ id: 'rows', kind: 'row_count_equals', expected: 2 }] })], {
      bounds: { maxStatements: 1, statementTimeoutMs: 1000, totalTimeoutMs: 5000, maxRows: 1, maxPayloadBytes: 65_536 }
    });
    const client = new FakeClient({ rows: new Map([['SELECT 1::integer AS value', [{ value: 1 }, { value: 1 }]]]) });
    const report = await runReadonlyDiagnostic({ inventory: bounded, client, target: LOCAL_TARGET });
    assert.equal(report.failure.code, 'ROW_BOUND_EXCEEDED');
  });
  await t.test('payload bound', async () => {
    const bounded = inventory([statement()], {
      bounds: { maxStatements: 1, statementTimeoutMs: 1000, totalTimeoutMs: 5000, maxRows: 10, maxPayloadBytes: 32 }
    });
    const client = new FakeClient({ rows: new Map([['SELECT 1::integer AS value', [{ value: 'private'.repeat(20) }]]]) });
    const report = await runReadonlyDiagnostic({ inventory: bounded, client, target: LOCAL_TARGET });
    assert.equal(report.failure.code, 'PAYLOAD_BOUND_EXCEEDED');
  });
});

test('target category mismatch fails before client construction', async () => {
  const client = new FakeClient();
  const report = await runReadonlyDiagnostic({ inventory: inventory(), client, target: { category: 'dev', expectedIdentity: 'a', actualIdentity: 'a' } });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_TARGET_MISMATCH);
  assert.equal(client.connected, false);
});

test('DEV and PROD target ambiguity or identity mismatch fails closed', async (t) => {
  for (const category of ['dev', 'prod']) {
    await t.test(category, async () => {
      const client = new FakeClient();
      const scoped = inventory([statement()], { target: { category } });
      const report = await runReadonlyDiagnostic({ inventory: scoped, client, target: { category, expectedIdentity: 'expected', actualIdentity: 'different' } });
      assert.equal(report.classification, READONLY_DIAGNOSTIC_TARGET_MISMATCH);
      assert.equal(client.connected, false);
    });
  }
});

test('explicit matching DEV identity passes the target guard without exposing identity', async () => {
  const scoped = inventory([statement()], { target: { category: 'dev' } });
  const report = await runReadonlyDiagnostic({
    inventory: scoped,
    client: new FakeClient(),
    target: { category: 'dev', expectedIdentity: 'synthetic-target', actualIdentity: 'synthetic-target' }
  });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_PASSED);
  assert.equal(JSON.stringify(report).includes('synthetic-target'), false);
});

test('reports redact raw rows, parameter values, and database errors', async () => {
  const secret = 'private-row-content-must-not-appear';
  const client = new FakeClient({ rows: new Map([['SELECT 1::integer AS value', [{ value: secret }]]]) });
  const report = await runReadonlyDiagnostic({ inventory: inventory(), client, target: LOCAL_TARGET });
  const serialized = serializeDiagnosticReport(report);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('private database detail'), false);
});

test('malformed inventory metadata is never reflected in rejection output', async () => {
  const privateValue = 'private-inventory-value-must-not-escape';
  const malformed = inventory();
  malformed.name = privateValue;
  malformed.target = { category: privateValue };
  malformed.inventoryIdentity = privateValue;
  const report = await runReadonlyDiagnostic({ inventory: malformed, client: new FakeClient(), target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_REJECTED_UNSAFE);
  assert.deepEqual(report.inventory, { name: '<invalid>', version: null, identity: null });
  assert.equal(report.target.category, '<invalid>');
  assert.equal(serializeDiagnosticReport(report).includes(privateValue), false);
});

test('JSON report output is deterministic', async () => {
  const first = await runReadonlyDiagnostic({ inventory: inventory(), client: new FakeClient(), target: LOCAL_TARGET });
  const second = await runReadonlyDiagnostic({ inventory: inventory(), client: new FakeClient(), target: LOCAL_TARGET });
  assert.equal(serializeDiagnosticReport(first), serializeDiagnosticReport(second));
});

test('canonical digest is stable across object-key order and distinguishes duplicate rows', () => {
  assert.equal(canonicalDigest({ b: 2, a: null }), canonicalDigest({ a: null, b: 2 }));
  assert.notEqual(canonicalDigest([{ a: 1 }]), canonicalDigest([{ a: 1 }, { a: 1 }]));
  assert.match(canonicalDigest({ ok: true }), /^sha256:[0-9a-f]{64}$/);
});

test('null-safe equality distinguishes null from missing and equates null with null', () => {
  assert.equal(compareNullSafe(null, null), true);
  assert.equal(compareNullSafe({ value: null }, {}), false);
  assert.equal(compareNullSafe(false, 0), false);
});

test('set equality supports composite keys', () => {
  const actual = [{ org: 'a', allocation: '1' }, { org: 'b', allocation: '1' }];
  const expected = [...actual].reverse();
  assert.equal(compareSets(actual, expected, ['org', 'allocation']).equal, true);
  assert.equal(compareSets(actual, expected, ['allocation']).equal, false);
});

test('multiset comparison detects incidence differences', () => {
  const actual = [{ category: 'a' }, { category: 'a' }];
  const expected = [{ category: 'a' }];
  assert.deepEqual(compareMultisets(actual, expected, ['category']), {
    equal: false, actualCount: 2, expectedCount: 1, differences: 1
  });
});

test('duplicate-key detection is explicit', () => {
  const result = compareSets([{ org: 'a', id: 1 }, { org: 'a', id: 1 }], [{ org: 'a', id: 1 }], ['org', 'id']);
  assert.equal(result.equal, false);
  assert.equal(result.duplicateActual, 1);
});

test('subset and disjointness comparisons are categorical', () => {
  assert.equal(compareSubset([{ id: 1 }], [{ id: 1 }, { id: 2 }], ['id']).matches, true);
  assert.equal(compareDisjoint([{ id: 1 }], [{ id: 2 }], ['id']).matches, true);
  assert.equal(compareDisjoint([{ id: 1 }], [{ id: 1 }], ['id']).overlap, 1);
});

test('ordered projections and categorical distributions are deterministic', () => {
  assert.equal(compareOrderedProjection([{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 2 }], ['id']).equal, true);
  assert.equal(compareOrderedProjection([{ id: 2 }, { id: 1 }], [{ id: 1 }, { id: 2 }], ['id']).equal, false);
  assert.deepEqual(categoricalDistribution([{ state: 'b' }, { state: 'a' }, { state: 'b' }], 'state'), { categoryCount: 2, counts: [1, 2] });
});

test('expected-zero assertion passes only for zero rows', async () => {
  const item = statement({ expectedShape: 'rows', assertions: [{ id: 'zero', kind: 'expected_zero' }] });
  const passed = await runReadonlyDiagnostic({ inventory: inventory([item]), client: new FakeClient({ rows: new Map([[item.sql, []]]) }), target: LOCAL_TARGET });
  const failed = await runReadonlyDiagnostic({ inventory: inventory([item]), client: new FakeClient(), target: LOCAL_TARGET });
  assert.equal(passed.classification, READONLY_DIAGNOSTIC_PASSED);
  assert.equal(failed.classification, READONLY_DIAGNOSTIC_LOGICAL_MISMATCH);
});

test('inventory identity mismatch rejects before execution', async () => {
  const altered = inventory();
  altered.statements[0].assertions[0].expected = 2;
  const client = new FakeClient();
  const report = await runReadonlyDiagnostic({ inventory: altered, client, target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_REJECTED_UNSAFE);
  assert.equal(report.failure.code, 'STATEMENT_IDENTITY_MISMATCH');
  assert.equal(client.calls.length, 0);
});

test('exact SQL identity mismatch rejects before execution', async () => {
  const altered = inventory();
  altered.statements[0].sqlIdentity = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  const client = new FakeClient();
  const report = await runReadonlyDiagnostic({ inventory: altered, client, target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_REJECTED_UNSAFE);
  assert.equal(report.failure.code, 'SQL_IDENTITY_MISMATCH');
  assert.equal(client.calls.length, 0);
});

test('forward dependencies and ambiguous output policies reject before execution', async (t) => {
  await t.test('forward dependency', async () => {
    const sealed = inventory([
      statement({ dependsOn: ['later'] }),
      statement({ id: 'later', sql: 'SELECT 2::integer AS value' })
    ]);
    const client = new FakeClient();
    const report = await runReadonlyDiagnostic({ inventory: sealed, client, target: LOCAL_TARGET });
    assert.equal(report.classification, READONLY_DIAGNOSTIC_REJECTED_UNSAFE);
    assert.equal(report.failure.code, 'STATEMENT_DEPENDENCY_INVALID');
  });
  await t.test('ambiguous output', async () => {
    const sealed = inventory([statement({ output: { mode: 'raw', metrics: [] } })]);
    const client = new FakeClient();
    const report = await runReadonlyDiagnostic({ inventory: sealed, client, target: LOCAL_TARGET });
    assert.equal(report.classification, READONLY_DIAGNOSTIC_REJECTED_UNSAFE);
    assert.equal(report.failure.code, 'STATEMENT_OUTPUT_UNSAFE');
  });
});

test('rollback failure overrides successful query classification', async () => {
  const report = await runReadonlyDiagnostic({ inventory: inventory(), client: new FakeClient({ rollbackFailure: true }), target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_ROLLBACK_FAILED);
  assert.equal(report.transaction.rollback, 'FAILED');
  assert.equal(report.transaction.rollbackProven, false);
});

test('read-only proof failure still rolls back and fails execution', async () => {
  const report = await runReadonlyDiagnostic({ inventory: inventory(), client: new FakeClient({ readOnly: 'off' }), target: LOCAL_TARGET });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_EXECUTION_FAILED);
  assert.equal(report.failure.code, 'TRANSACTION_READ_ONLY_NOT_PROVEN');
  assert.equal(report.transaction.rollbackProven, true);
});

test('sealed inventory validates deterministically', () => {
  const sealed = inventory();
  assert.doesNotThrow(() => validateDiagnosticInventory(sealed));
  assert.equal(sealed.inventoryIdentity, inventory().inventoryIdentity);
  assert.equal(canonicalSerialize({ b: 1, a: 2 }), canonicalSerialize({ a: 2, b: 1 }));
});

test('tracked repository characterization inventory covers recurring evidence patterns', () => {
  assert.doesNotThrow(() => validateDiagnosticInventory(REPOSITORY_READONLY_CHARACTERIZATION));
  assert.deepEqual(
    REPOSITORY_READONLY_CHARACTERIZATION.statements.map((entry) => entry.id),
    ['migration_ledger_shape', 'fixture_budget_counts', 'stable_set_composite_key', 'ordered_projection_digest']
  );
});
