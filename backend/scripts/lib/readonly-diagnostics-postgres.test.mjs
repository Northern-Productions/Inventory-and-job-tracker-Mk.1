import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  READONLY_DIAGNOSTIC_PASSED,
  READONLY_DIAGNOSTIC_LOGICAL_MISMATCH,
  runReadonlyDiagnostic,
  sealDiagnosticInventory
} from './readonly-diagnostics.mjs';
import { REPOSITORY_READONLY_CHARACTERIZATION } from './readonly-diagnostics-characterizations.mjs';

class PGliteClientAdapter {
  constructor() {
    this.database = new PGlite();
    this.connected = false;
  }

  async connect() {
    await this.database.waitReady;
    this.connected = true;
  }

  async query(input) {
    const text = typeof input === 'string' ? input : input.text;
    const values = typeof input === 'string' ? [] : input.values;
    const result = await this.database.query(text, values);
    const root = text.trim().split(/\s+/, 1)[0].toUpperCase();
    return { ...result, command: root === 'SET' ? 'SET' : root };
  }

  async end() {
    await this.database.close();
  }
}

function localInventory() {
  const base = {
    parameters: [],
    expectedShape: 'scalar',
    dependsOn: [],
    output: { mode: 'categorical', metrics: ['row_count', 'assertion_counts'] },
    maximumExecutions: 1
  };
  return sealDiagnosticInventory({
    schemaVersion: 1,
    name: 'postgres-characterization',
    version: 1,
    target: { category: 'local' },
    bounds: { maxStatements: 4, statementTimeoutMs: 5000, totalTimeoutMs: 20_000, maxRows: 100, maxPayloadBytes: 65_536 },
    statements: [
      {
        ...base,
        id: 'read_only_scalar',
        sql: 'SELECT 1::integer AS value',
        assertions: [{ id: 'scalar_matches', kind: 'scalar_equals', column: 'value', expected: 1 }]
      },
      {
        ...base,
        id: 'intentional_mismatch',
        sql: 'SELECT 2::integer AS value',
        assertions: [{ id: 'mismatch_recorded', kind: 'scalar_equals', column: 'value', expected: 4 }]
      },
      {
        ...base,
        id: 'later_snapshot_evidence',
        sql: 'SELECT pg_catalog.current_database() IS NOT NULL AS value',
        assertions: [{ id: 'later_evidence_passes', kind: 'scalar_equals', column: 'value', expected: true }]
      }
    ]
  });
}

test('disposable local PostgreSQL proves isolation, continuation, and rollback end to end', { timeout: 60_000 }, async () => {
  const report = await runReadonlyDiagnostic({
    inventory: localInventory(),
    client: new PGliteClientAdapter(),
    target: { category: 'local', host: '127.0.0.1' }
  });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_LOGICAL_MISMATCH);
  assert.equal(report.transaction.begun, true);
  assert.equal(report.transaction.readOnlyProven, true);
  assert.equal(report.transaction.searchPathGuarded, true);
  assert.equal(report.transaction.rollback, 'SUCCEEDED');
  assert.equal(report.transaction.rollbackProven, true);
  assert.deepEqual(report.statements.map((entry) => entry.result), ['PASS', 'LOGICAL_MISMATCH', 'PASS']);
});

test('tracked characterization inventory passes on disposable local PostgreSQL', { timeout: 60_000 }, async () => {
  const report = await runReadonlyDiagnostic({
    inventory: REPOSITORY_READONLY_CHARACTERIZATION,
    client: new PGliteClientAdapter(),
    target: { category: 'local', host: 'localhost' }
  });
  assert.equal(report.classification, READONLY_DIAGNOSTIC_PASSED);
  assert.deepEqual(report.statements.map((entry) => entry.result), ['PASS', 'PASS', 'PASS', 'PASS']);
  assert.equal(report.transaction.rollbackProven, true);
});
