import crypto from 'node:crypto';
import net from 'node:net';
import { validateReadonlySql } from './readonly-diagnostics-sql.mjs';

export const READONLY_DIAGNOSTIC_PASSED = 'READONLY_DIAGNOSTIC_PASSED';
export const READONLY_DIAGNOSTIC_LOGICAL_MISMATCH = 'READONLY_DIAGNOSTIC_LOGICAL_MISMATCH';
export const READONLY_DIAGNOSTIC_REJECTED_UNSAFE = 'READONLY_DIAGNOSTIC_REJECTED_UNSAFE';
export const READONLY_DIAGNOSTIC_EXECUTION_FAILED = 'READONLY_DIAGNOSTIC_EXECUTION_FAILED';
export const READONLY_DIAGNOSTIC_ROLLBACK_FAILED = 'READONLY_DIAGNOSTIC_ROLLBACK_FAILED';
export const READONLY_DIAGNOSTIC_TARGET_MISMATCH = 'READONLY_DIAGNOSTIC_TARGET_MISMATCH';

export const DIAGNOSTIC_CANONICALIZATION_VERSION = 'readonly-diagnostic-c14n-v1';
export const DIAGNOSTIC_INVENTORY_VERSION = 1;

const DEFAULT_BOUNDS = Object.freeze({
  maxStatements: 64,
  statementTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  maxRows: 10_000,
  maxPayloadBytes: 4 * 1024 * 1024
});

const MAXIMUM_BOUNDS = Object.freeze({
  maxStatements: 128,
  statementTimeoutMs: 60_000,
  totalTimeoutMs: 300_000,
  maxRows: 50_000,
  maxPayloadBytes: 16 * 1024 * 1024
});

const INVENTORY_KEYS = new Set([
  'schemaVersion', 'name', 'version', 'target', 'bounds', 'statements', 'inventoryIdentity'
]);
const STATEMENT_KEYS = new Set([
  'id', 'sql', 'parameters', 'expectedShape', 'assertions', 'dependsOn', 'output',
  'maximumExecutions', 'sqlIdentity', 'statementIdentity'
]);
const PARAMETER_TYPES = new Set([
  'text', 'integer', 'bigint', 'boolean', 'uuid', 'date', 'timestamp',
  'text[]', 'integer[]', 'bigint[]', 'boolean[]', 'uuid[]', 'date[]', 'timestamp[]'
]);

function diagnosticError(code, classification = READONLY_DIAGNOSTIC_REJECTED_UNSAFE) {
  const error = new Error(code);
  error.code = code;
  error.classification = classification;
  return error;
}

function safeFailureCode(error, fallback) {
  const candidate = typeof error?.code === 'string' ? error.code : '';
  return /^(?:[A-Z][A-Z0-9_]{2,63}|[0-9A-Z]{5})$/.test(candidate) ? candidate : fallback;
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw diagnosticError(code);
  }
}

function rejectUnknownKeys(value, allowed, code) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw diagnosticError(code);
}

function canonicalValue(value) {
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw diagnosticError('CANONICALIZATION_INVALID_DATE');
    return { $timestamp: value.toISOString() };
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw diagnosticError('CANONICALIZATION_NONFINITE_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  assertPlainObject(value, 'CANONICALIZATION_UNSUPPORTED_VALUE');
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])
  );
}

export function canonicalSerialize(value) {
  return JSON.stringify({ version: DIAGNOSTIC_CANONICALIZATION_VERSION, value: canonicalValue(value) });
}

export function canonicalDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalSerialize(value), 'utf8').digest('hex')}`;
}

function canonicalKey(row, keyFields) {
  assertPlainObject(row, 'COMPARISON_ROW_INVALID');
  if (!Array.isArray(keyFields) || !keyFields.length || new Set(keyFields).size !== keyFields.length) {
    throw diagnosticError('COMPARISON_KEY_FIELDS_INVALID');
  }
  const projection = {};
  for (const field of keyFields) {
    if (typeof field !== 'string' || !field || !Object.hasOwn(row, field)) {
      throw diagnosticError('COMPARISON_KEY_FIELD_MISSING');
    }
    projection[field] = row[field];
  }
  return canonicalSerialize(projection);
}

function keyedSet(rows, keyFields) {
  if (!Array.isArray(rows)) throw diagnosticError('COMPARISON_ROWS_INVALID');
  const values = new Set();
  let duplicates = 0;
  for (const row of rows) {
    const key = canonicalKey(row, keyFields);
    if (values.has(key)) duplicates += 1;
    values.add(key);
  }
  return { values, duplicates };
}

export function compareSets(actual, expected, keyFields) {
  const left = keyedSet(actual, keyFields);
  const right = keyedSet(expected, keyFields);
  const missing = [...right.values].filter((value) => !left.values.has(value)).length;
  const extra = [...left.values].filter((value) => !right.values.has(value)).length;
  return Object.freeze({
    equal: left.duplicates === 0 && right.duplicates === 0 && missing === 0 && extra === 0,
    actualCount: left.values.size,
    expectedCount: right.values.size,
    duplicateActual: left.duplicates,
    duplicateExpected: right.duplicates,
    missing,
    extra
  });
}

export function compareMultisets(actual, expected, keyFields) {
  const frequencies = (rows) => {
    const result = new Map();
    for (const row of rows) {
      const key = canonicalKey(row, keyFields);
      result.set(key, (result.get(key) || 0) + 1);
    }
    return result;
  };
  const left = frequencies(actual);
  const right = frequencies(expected);
  const keys = new Set([...left.keys(), ...right.keys()]);
  const differences = [...keys].filter((key) => left.get(key) !== right.get(key)).length;
  return Object.freeze({ equal: differences === 0, actualCount: actual.length, expectedCount: expected.length, differences });
}

export function compareOrderedProjection(actual, expected, fields) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || !Array.isArray(fields) || !fields.length) {
    throw diagnosticError('ORDERED_PROJECTION_INPUT_INVALID');
  }
  const project = (rows) => rows.map((row) => Object.fromEntries(fields.map((field) => {
    if (!Object.hasOwn(row, field)) throw diagnosticError('ORDERED_PROJECTION_FIELD_MISSING');
    return [field, row[field]];
  })));
  return Object.freeze({
    equal: canonicalSerialize(project(actual)) === canonicalSerialize(project(expected)),
    actualCount: actual.length,
    expectedCount: expected.length
  });
}

export function compareSubset(actual, expectedSuperset, keyFields) {
  const left = keyedSet(actual, keyFields);
  const right = keyedSet(expectedSuperset, keyFields);
  const outside = [...left.values].filter((value) => !right.values.has(value)).length;
  return Object.freeze({ matches: left.duplicates === 0 && outside === 0, actualCount: left.values.size, outside });
}

export function compareDisjoint(leftRows, rightRows, keyFields) {
  const left = keyedSet(leftRows, keyFields);
  const right = keyedSet(rightRows, keyFields);
  const overlap = [...left.values].filter((value) => right.values.has(value)).length;
  return Object.freeze({ matches: left.duplicates === 0 && right.duplicates === 0 && overlap === 0, overlap });
}

export function compareNullSafe(actual, expected) {
  return canonicalSerialize(actual) === canonicalSerialize(expected);
}

export function categoricalDistribution(rows, field) {
  if (!Array.isArray(rows) || typeof field !== 'string' || !field) {
    throw diagnosticError('DISTRIBUTION_INPUT_INVALID');
  }
  const distribution = new Map();
  for (const row of rows) {
    if (!Object.hasOwn(row, field)) throw diagnosticError('DISTRIBUTION_FIELD_MISSING');
    const key = canonicalSerialize(row[field]);
    distribution.set(key, (distribution.get(key) || 0) + 1);
  }
  return Object.freeze({ categoryCount: distribution.size, counts: [...distribution.values()].sort((a, b) => a - b) });
}

function statementIdentity(statement) {
  return canonicalDigest({
    id: statement.id,
    sql: statement.sql,
    parameters: statement.parameters || [],
    expectedShape: statement.expectedShape,
    assertions: statement.assertions || [],
    dependsOn: statement.dependsOn || [],
    output: statement.output,
    maximumExecutions: statement.maximumExecutions
  });
}

function sqlIdentity(statement) {
  return `sha256:${crypto.createHash('sha256').update(statement.sql, 'utf8').digest('hex')}`;
}

function inventoryIdentity(inventory) {
  return canonicalDigest({
    schemaVersion: inventory.schemaVersion,
    name: inventory.name,
    version: inventory.version,
    target: inventory.target,
    bounds: inventory.bounds,
    statements: inventory.statements.map((statement) => ({
      ...statement,
      statementIdentity: statement.statementIdentity || statementIdentity(statement)
    }))
  });
}

export function sealDiagnosticInventory(draft) {
  const inventory = structuredClone(draft);
  inventory.statements = inventory.statements.map((statement) => ({
    ...statement,
    sqlIdentity: sqlIdentity(statement),
    statementIdentity: statementIdentity(statement)
  }));
  inventory.inventoryIdentity = inventoryIdentity(inventory);
  return inventory;
}

function validateBounds(value = {}) {
  assertPlainObject(value, 'INVENTORY_BOUNDS_INVALID');
  rejectUnknownKeys(value, new Set(Object.keys(DEFAULT_BOUNDS)), 'INVENTORY_BOUNDS_UNKNOWN_FIELD');
  const bounds = { ...DEFAULT_BOUNDS, ...value };
  for (const [name, maximum] of Object.entries(MAXIMUM_BOUNDS)) {
    if (!Number.isSafeInteger(bounds[name]) || bounds[name] < 1 || bounds[name] > maximum) {
      throw diagnosticError('INVENTORY_BOUND_INVALID');
    }
  }
  return bounds;
}

function validateParameterDefinition(parameter) {
  assertPlainObject(parameter, 'PARAMETER_SCHEMA_INVALID');
  rejectUnknownKeys(parameter, new Set(['name', 'type', 'nullable', 'maxLength', 'maxItems']), 'PARAMETER_SCHEMA_UNKNOWN_FIELD');
  if (!/^[a-z][a-z0-9_]*$/.test(parameter.name || '') || !PARAMETER_TYPES.has(parameter.type)) {
    throw diagnosticError('PARAMETER_SCHEMA_INVALID');
  }
  if (typeof parameter.nullable !== 'boolean') throw diagnosticError('PARAMETER_NULLABILITY_REQUIRED');
  if (parameter.maxLength !== undefined && (!Number.isSafeInteger(parameter.maxLength) || parameter.maxLength < 1 || parameter.maxLength > 65_536)) {
    throw diagnosticError('PARAMETER_MAX_LENGTH_INVALID');
  }
  if (parameter.maxItems !== undefined && (!Number.isSafeInteger(parameter.maxItems) || parameter.maxItems < 1 || parameter.maxItems > 10_000)) {
    throw diagnosticError('PARAMETER_MAX_ITEMS_INVALID');
  }
}

function validateAssertion(assertion) {
  assertPlainObject(assertion, 'ASSERTION_INVALID');
  const allowed = new Set(['id', 'kind', 'expected', 'column', 'keyFields', 'fields']);
  rejectUnknownKeys(assertion, allowed, 'ASSERTION_UNKNOWN_FIELD');
  if (!/^[a-z][a-z0-9_]*$/.test(assertion.id || '')) throw diagnosticError('ASSERTION_ID_INVALID');
  const kinds = new Set([
    'row_count_equals', 'expected_zero', 'scalar_equals', 'null_safe_equals', 'digest_equals',
    'set_equals', 'multiset_equals', 'ordered_projection_equals', 'subset_of', 'disjoint_from',
    'duplicate_keys_absent'
  ]);
  if (!kinds.has(assertion.kind)) throw diagnosticError('ASSERTION_KIND_INVALID');
  if (assertion.kind === 'row_count_equals') {
    if (!Number.isSafeInteger(assertion.expected) || assertion.expected < 0) throw diagnosticError('ASSERTION_EXPECTED_INVALID');
  } else if (assertion.kind === 'expected_zero') {
    if (Object.hasOwn(assertion, 'expected')) throw diagnosticError('ASSERTION_EXPECTED_INVALID');
  } else if (['scalar_equals', 'null_safe_equals'].includes(assertion.kind)) {
    if (!/^[a-z][a-z0-9_]*$/.test(assertion.column || '') || !Object.hasOwn(assertion, 'expected')) {
      throw diagnosticError('ASSERTION_EXPECTED_INVALID');
    }
  } else if (assertion.kind === 'digest_equals') {
    if (!/^sha256:[0-9a-f]{64}$/.test(assertion.expected || '')) throw diagnosticError('ASSERTION_EXPECTED_INVALID');
  } else if (assertion.kind === 'ordered_projection_equals') {
    if (!Array.isArray(assertion.expected) || !Array.isArray(assertion.fields) || !assertion.fields.length ||
      new Set(assertion.fields).size !== assertion.fields.length || assertion.fields.some((field) => !/^[a-z][a-z0-9_]*$/.test(field))) {
      throw diagnosticError('ASSERTION_EXPECTED_INVALID');
    }
  } else {
    if (!Array.isArray(assertion.keyFields) || !assertion.keyFields.length ||
      new Set(assertion.keyFields).size !== assertion.keyFields.length || assertion.keyFields.some((field) => !/^[a-z][a-z0-9_]*$/.test(field))) {
      throw diagnosticError('ASSERTION_EXPECTED_INVALID');
    }
    if (assertion.kind !== 'duplicate_keys_absent' && !Array.isArray(assertion.expected)) {
      throw diagnosticError('ASSERTION_EXPECTED_INVALID');
    }
  }
}

export function validateDiagnosticInventory(inventory) {
  assertPlainObject(inventory, 'INVENTORY_INVALID');
  rejectUnknownKeys(inventory, INVENTORY_KEYS, 'INVENTORY_UNKNOWN_FIELD');
  if (inventory.schemaVersion !== DIAGNOSTIC_INVENTORY_VERSION) throw diagnosticError('INVENTORY_VERSION_UNSUPPORTED');
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(inventory.name || '') || !Number.isSafeInteger(inventory.version) || inventory.version < 1) {
    throw diagnosticError('INVENTORY_IDENTITY_FIELDS_INVALID');
  }
  assertPlainObject(inventory.target, 'INVENTORY_TARGET_INVALID');
  rejectUnknownKeys(inventory.target, new Set(['category']), 'INVENTORY_TARGET_UNKNOWN_FIELD');
  if (!['local', 'dev', 'prod'].includes(inventory.target.category)) throw diagnosticError('INVENTORY_TARGET_INVALID');
  const bounds = validateBounds(inventory.bounds);
  if (bounds.totalTimeoutMs < bounds.statementTimeoutMs) throw diagnosticError('INVENTORY_BOUND_INVALID');
  if (!Array.isArray(inventory.statements) || !inventory.statements.length || inventory.statements.length > bounds.maxStatements) {
    throw diagnosticError('INVENTORY_STATEMENT_COUNT_INVALID');
  }
  const ids = new Set();
  for (const [statementIndex, statement] of inventory.statements.entries()) {
    assertPlainObject(statement, 'STATEMENT_INVALID');
    rejectUnknownKeys(statement, STATEMENT_KEYS, 'STATEMENT_UNKNOWN_FIELD');
    if (!/^[a-z][a-z0-9_]*$/.test(statement.id || '') || ids.has(statement.id)) throw diagnosticError('STATEMENT_ID_INVALID');
    ids.add(statement.id);
    if (statement.maximumExecutions !== 1) throw diagnosticError('STATEMENT_EXECUTION_LIMIT_INVALID');
    if (!['rows', 'scalar'].includes(statement.expectedShape)) throw diagnosticError('STATEMENT_SHAPE_INVALID');
    if (!Array.isArray(statement.parameters)) throw diagnosticError('PARAMETER_SCHEMA_INVALID');
    statement.parameters.forEach(validateParameterDefinition);
    if (new Set(statement.parameters.map((parameter) => parameter.name)).size !== statement.parameters.length) {
      throw diagnosticError('PARAMETER_NAME_DUPLICATE');
    }
    const sql = validateReadonlySql(statement.sql);
    if (sql.parameterCount !== statement.parameters.length) throw diagnosticError('SQL_PARAMETER_COUNT_MISMATCH');
    if (!Array.isArray(statement.assertions) || !statement.assertions.length) throw diagnosticError('STATEMENT_ASSERTIONS_REQUIRED');
    statement.assertions.forEach(validateAssertion);
    if (new Set(statement.assertions.map((assertion) => assertion.id)).size !== statement.assertions.length) {
      throw diagnosticError('ASSERTION_ID_DUPLICATE');
    }
    if (!Array.isArray(statement.dependsOn)) throw diagnosticError('STATEMENT_DEPENDENCY_INVALID');
    assertPlainObject(statement.output, 'STATEMENT_OUTPUT_INVALID');
    rejectUnknownKeys(statement.output, new Set(['mode', 'metrics']), 'STATEMENT_OUTPUT_UNKNOWN_FIELD');
    if (statement.output.mode !== 'categorical' || !Array.isArray(statement.output.metrics)) {
      throw diagnosticError('STATEMENT_OUTPUT_UNSAFE');
    }
    if (new Set(statement.output.metrics).size !== statement.output.metrics.length) throw diagnosticError('STATEMENT_OUTPUT_UNSAFE');
    for (const metric of statement.output.metrics) {
      if (!['row_count', 'assertion_counts'].includes(metric)) throw diagnosticError('STATEMENT_OUTPUT_UNSAFE');
    }
    if (statement.sqlIdentity !== sqlIdentity(statement)) throw diagnosticError('SQL_IDENTITY_MISMATCH');
    if (statement.statementIdentity !== statementIdentity(statement)) throw diagnosticError('STATEMENT_IDENTITY_MISMATCH');
    for (const dependency of statement.dependsOn) {
      const dependencyIndex = inventory.statements.findIndex((candidate) => candidate.id === dependency);
      if (!ids.has(dependency) || dependency === statement.id || dependencyIndex >= statementIndex) {
        throw diagnosticError('STATEMENT_DEPENDENCY_INVALID');
      }
    }
  }
  if (inventory.inventoryIdentity !== inventoryIdentity(inventory)) throw diagnosticError('INVENTORY_IDENTITY_MISMATCH');
  return Object.freeze({ bounds });
}

function isLoopbackHost(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' ||
    (net.isIP(normalized) === 4 && normalized.startsWith('127.'));
}

export function validateDiagnosticTarget(expected, actual) {
  assertPlainObject(actual, 'TARGET_AMBIGUOUS');
  if (actual.category !== expected.category) {
    throw diagnosticError('TARGET_CATEGORY_MISMATCH', READONLY_DIAGNOSTIC_TARGET_MISMATCH);
  }
  if (expected.category === 'local') {
    if (!isLoopbackHost(actual.host)) throw diagnosticError('TARGET_LOCAL_NOT_LOOPBACK', READONLY_DIAGNOSTIC_TARGET_MISMATCH);
  } else {
    if (
      typeof actual.expectedIdentity !== 'string' || !actual.expectedIdentity ||
      typeof actual.actualIdentity !== 'string' || !actual.actualIdentity ||
      actual.expectedIdentity !== actual.actualIdentity
    ) {
      throw diagnosticError('TARGET_IDENTITY_MISMATCH', READONLY_DIAGNOSTIC_TARGET_MISMATCH);
    }
  }
  return true;
}

function validateScalarType(value, definition) {
  if (value === null) {
    if (!definition.nullable) throw diagnosticError('PARAMETER_NULL_REJECTED');
    return null;
  }
  const type = definition.type.replace(/\[\]$/, '');
  if (type === 'text') {
    if (typeof value !== 'string' || value.length > (definition.maxLength || 4096)) throw diagnosticError('PARAMETER_TYPE_INVALID');
    return value;
  }
  if (type === 'integer') {
    if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) throw diagnosticError('PARAMETER_TYPE_INVALID');
    return value;
  }
  if (type === 'bigint') {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw diagnosticError('PARAMETER_TYPE_INVALID');
    return value;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw diagnosticError('PARAMETER_TYPE_INVALID');
    return value;
  }
  if (type === 'uuid') {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw diagnosticError('PARAMETER_TYPE_INVALID');
    }
    return value;
  }
  if (type === 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
      throw diagnosticError('PARAMETER_TYPE_INVALID');
    }
    return value;
  }
  if (type === 'timestamp') {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw diagnosticError('PARAMETER_TYPE_INVALID');
    return value;
  }
  throw diagnosticError('PARAMETER_TYPE_INVALID');
}

function bindParameters(statement, supplied = {}) {
  assertPlainObject(supplied, 'PARAMETER_VALUES_INVALID');
  const expectedNames = statement.parameters.map((parameter) => parameter.name);
  if (Object.keys(supplied).length !== expectedNames.length || Object.keys(supplied).some((name) => !expectedNames.includes(name))) {
    throw diagnosticError('PARAMETER_COUNT_INVALID');
  }
  return statement.parameters.map((definition) => {
    const value = supplied[definition.name];
    if (definition.type.endsWith('[]')) {
      if (!Array.isArray(value) || value.length > (definition.maxItems || 1000)) throw diagnosticError('PARAMETER_TYPE_INVALID');
      return value.map((item) => validateScalarType(item, { ...definition, type: definition.type.slice(0, -2) }));
    }
    return validateScalarType(value, definition);
  });
}

function evaluateAssertion(assertion, rows) {
  let pass = false;
  if (assertion.kind === 'row_count_equals') pass = rows.length === assertion.expected;
  else if (assertion.kind === 'expected_zero') pass = rows.length === 0;
  else {
    if (assertion.kind === 'scalar_equals' || assertion.kind === 'null_safe_equals') {
      pass = rows.length === 1 && Object.hasOwn(rows[0], assertion.column) && compareNullSafe(rows[0][assertion.column], assertion.expected);
    } else if (assertion.kind === 'digest_equals') {
      pass = canonicalDigest(rows) === assertion.expected;
    } else if (assertion.kind === 'set_equals') {
      pass = compareSets(rows, assertion.expected, assertion.keyFields).equal;
    } else if (assertion.kind === 'multiset_equals') {
      pass = compareMultisets(rows, assertion.expected, assertion.keyFields).equal;
    } else if (assertion.kind === 'ordered_projection_equals') {
      pass = compareOrderedProjection(rows, assertion.expected, assertion.fields).equal;
    } else if (assertion.kind === 'subset_of') {
      pass = compareSubset(rows, assertion.expected, assertion.keyFields).matches;
    } else if (assertion.kind === 'disjoint_from') {
      pass = compareDisjoint(rows, assertion.expected, assertion.keyFields).matches;
    } else if (assertion.kind === 'duplicate_keys_absent') {
      pass = keyedSet(rows, assertion.keyFields).duplicates === 0;
    }
  }
  return { id: assertion.id, result: pass ? 'PASS' : 'LOGICAL_MISMATCH' };
}

function safeStatementResult(statement, rows, assertions) {
  const metrics = {};
  if (statement.output.metrics.includes('row_count')) metrics.rowCount = rows.length;
  if (statement.output.metrics.includes('assertion_counts')) {
    metrics.assertionsPassed = assertions.filter((assertion) => assertion.result === 'PASS').length;
    metrics.assertionsMismatched = assertions.filter((assertion) => assertion.result === 'LOGICAL_MISMATCH').length;
  }
  return {
    id: statement.id,
    sqlIdentity: statement.sqlIdentity,
    statementIdentity: statement.statementIdentity,
    result: assertions.every((assertion) => assertion.result === 'PASS') ? 'PASS' : 'LOGICAL_MISMATCH',
    assertions,
    metrics
  };
}

async function runQuery(client, config) {
  return client.query(config);
}

export async function runReadonlyDiagnostic({ inventory, client, target, parameters = {}, now = () => Date.now() }) {
  let validated;
  let inventoryValidated = false;
  try {
    validated = validateDiagnosticInventory(inventory);
    inventoryValidated = true;
    validateDiagnosticTarget(inventory.target, target);
    assertPlainObject(parameters, 'PARAMETER_VALUES_INVALID');
    const statementIds = new Set(inventory.statements.map((statement) => statement.id));
    if (Object.keys(parameters).some((id) => !statementIds.has(id))) throw diagnosticError('PARAMETER_STATEMENT_UNKNOWN');
    for (const statement of inventory.statements) bindParameters(statement, parameters[statement.id] || {});
  } catch (error) {
    return {
      classification: error.classification || READONLY_DIAGNOSTIC_REJECTED_UNSAFE,
      inventory: inventoryValidated
        ? { name: inventory.name, version: inventory.version, identity: inventory.inventoryIdentity }
        : { name: '<invalid>', version: null, identity: null },
      target: { category: inventoryValidated ? inventory.target.category : '<invalid>', verified: false },
      transaction: { begun: false, readOnlyProven: false, searchPathGuarded: false, rollback: 'NOT_REQUIRED', rollbackProven: false },
      statements: [],
      failure: { code: safeFailureCode(error, 'INVENTORY_REJECTED') }
    };
  }

  const report = {
    classification: READONLY_DIAGNOSTIC_PASSED,
    inventory: { name: inventory.name, version: inventory.version, identity: inventory.inventoryIdentity },
    target: { category: inventory.target.category, verified: true },
    transaction: { begun: false, readOnlyProven: false, searchPathGuarded: false, rollback: 'NOT_ATTEMPTED', rollbackProven: false },
    statements: [],
    failure: null
  };
  let connected = false;
  let beginAttempted = false;
  let executionFailed = false;
  const start = now();
  const resultsById = new Map();

  try {
    if (!client || typeof client.query !== 'function') throw diagnosticError('CLIENT_INVALID', READONLY_DIAGNOSTIC_EXECUTION_FAILED);
    if (typeof client.connect === 'function') {
      await client.connect();
      connected = true;
    }
    beginAttempted = true;
    const begin = await runQuery(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (begin?.command !== 'BEGIN') throw diagnosticError('TRANSACTION_BEGIN_NOT_PROVEN', READONLY_DIAGNOSTIC_EXECUTION_FAILED);
    report.transaction.begun = true;
    const proof = await runQuery(client, 'SHOW transaction_read_only');
    if (proof?.rows?.[0]?.transaction_read_only !== 'on') {
      throw diagnosticError('TRANSACTION_READ_ONLY_NOT_PROVEN', READONLY_DIAGNOSTIC_EXECUTION_FAILED);
    }
    report.transaction.readOnlyProven = true;
    const searchPath = await runQuery(client, 'SET LOCAL search_path TO pg_catalog');
    if (searchPath?.command !== 'SET') {
      throw diagnosticError('TRANSACTION_SEARCH_PATH_NOT_GUARDED', READONLY_DIAGNOSTIC_EXECUTION_FAILED);
    }
    report.transaction.searchPathGuarded = true;

    for (const statement of inventory.statements) {
      const blocked = statement.dependsOn.some((dependency) => resultsById.get(dependency) !== 'PASS');
      if (blocked) {
        const skipped = {
          id: statement.id,
          sqlIdentity: statement.sqlIdentity,
          statementIdentity: statement.statementIdentity,
          result: 'DEPENDENCY_BLOCKED',
          assertions: [],
          metrics: {}
        };
        report.statements.push(skipped);
        resultsById.set(statement.id, skipped.result);
        continue;
      }
      const elapsed = now() - start;
      if (elapsed >= validated.bounds.totalTimeoutMs) {
        throw diagnosticError('TOTAL_TIMEOUT_EXCEEDED', READONLY_DIAGNOSTIC_EXECUTION_FAILED);
      }
      const values = bindParameters(statement, parameters[statement.id] || {});
      const result = await runQuery(client, {
        text: statement.sql,
        values,
        query_timeout: Math.min(validated.bounds.statementTimeoutMs, validated.bounds.totalTimeoutMs - elapsed)
      });
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      if (rows.length > validated.bounds.maxRows) throw diagnosticError('ROW_BOUND_EXCEEDED', READONLY_DIAGNOSTIC_EXECUTION_FAILED);
      const payloadBytes = Buffer.byteLength(canonicalSerialize(rows), 'utf8');
      if (payloadBytes > validated.bounds.maxPayloadBytes) throw diagnosticError('PAYLOAD_BOUND_EXCEEDED', READONLY_DIAGNOSTIC_EXECUTION_FAILED);
      if (statement.expectedShape === 'scalar' && rows.length !== 1) {
        const mismatch = {
          id: statement.id,
          sqlIdentity: statement.sqlIdentity,
          statementIdentity: statement.statementIdentity,
          result: 'LOGICAL_MISMATCH',
          assertions: [],
          metrics: { rowCount: rows.length }
        };
        report.statements.push(mismatch);
        resultsById.set(statement.id, mismatch.result);
        continue;
      }
      const assertions = statement.assertions.map((assertion) => evaluateAssertion(assertion, rows));
      const statementResult = safeStatementResult(statement, rows, assertions);
      report.statements.push(statementResult);
      resultsById.set(statement.id, statementResult.result);
    }
  } catch (error) {
    executionFailed = true;
    report.failure = {
      code: safeFailureCode(
        error,
        error?.name === 'QueryTimeoutError' ? 'STATEMENT_TIMEOUT' : 'SQL_EXECUTION_FAILED'
      )
    };
  } finally {
    if (beginAttempted) {
      try {
        const rollback = await runQuery(client, 'ROLLBACK');
        report.transaction.rollback = rollback?.command === 'ROLLBACK' ? 'SUCCEEDED' : 'UNPROVEN';
        const probe = await runQuery(
          client,
          'SELECT pg_catalog.txid_current_if_assigned() IS NULL AS transaction_inactive'
        );
        report.transaction.rollbackProven =
          report.transaction.rollback === 'SUCCEEDED' && probe?.rows?.[0]?.transaction_inactive === true;
      } catch {
        report.transaction.rollback = 'FAILED';
        report.transaction.rollbackProven = false;
      }
    } else {
      report.transaction.rollback = 'NOT_REQUIRED';
    }
    if (connected && typeof client.end === 'function') {
      try {
        await client.end();
      } catch {
        if (!report.failure) report.failure = { code: 'CLIENT_CLOSE_FAILED' };
        executionFailed = true;
      }
    }
  }

  if (beginAttempted && !report.transaction.rollbackProven) {
    report.classification = READONLY_DIAGNOSTIC_ROLLBACK_FAILED;
    if (!report.failure) report.failure = { code: 'ROLLBACK_NOT_PROVEN' };
  } else if (executionFailed) {
    report.classification = READONLY_DIAGNOSTIC_EXECUTION_FAILED;
  } else if (report.statements.some((statement) => statement.result !== 'PASS')) {
    report.classification = READONLY_DIAGNOSTIC_LOGICAL_MISMATCH;
  }
  return report;
}

export function serializeDiagnosticReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatDiagnosticReport(report) {
  const lines = [
    '[readonly-diagnostic]',
    `classification: ${report.classification}`,
    `inventory: ${report.inventory.name} v${report.inventory.version ?? 'unknown'}`,
    `target: ${report.target.category} (${report.target.verified ? 'verified' : 'not-verified'})`,
    `transaction: begun=${report.transaction.begun}, readOnly=${report.transaction.readOnlyProven}, searchPathGuarded=${report.transaction.searchPathGuarded}, rollback=${report.transaction.rollback}, rollbackProven=${report.transaction.rollbackProven}`,
    'statements:'
  ];
  if (!report.statements.length) lines.push('  <none>');
  for (const statement of report.statements) {
    const rowCount = statement.metrics.rowCount === undefined ? '' : ` rows=${statement.metrics.rowCount}`;
    lines.push(`  ${statement.id}: ${statement.result}${rowCount}`);
  }
  if (report.failure) lines.push(`failure: ${report.failure.code}`);
  return lines.join('\n');
}
