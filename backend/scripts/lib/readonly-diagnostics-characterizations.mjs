import { canonicalDigest, sealDiagnosticInventory } from './readonly-diagnostics.mjs';

const migrationRows = [{ migration_label: '0196' }, { migration_label: '0197' }];
const stableRows = [
  { organization_key: 'synthetic-org-a', allocation_key: 'synthetic-allocation-a' },
  { organization_key: 'synthetic-org-b', allocation_key: 'synthetic-allocation-a' }
];
const orderedRows = [{ ordinal: 1, category: 'first' }, { ordinal: 2, category: 'second' }];

const baseStatement = Object.freeze({
  parameters: [],
  expectedShape: 'rows',
  dependsOn: [],
  output: { mode: 'categorical', metrics: ['row_count', 'assertion_counts'] },
  maximumExecutions: 1
});

export const REPOSITORY_READONLY_CHARACTERIZATION = sealDiagnosticInventory({
  schemaVersion: 1,
  name: 'repository-characterization',
  version: 1,
  target: { category: 'local' },
  bounds: {
    maxStatements: 4,
    statementTimeoutMs: 5000,
    totalTimeoutMs: 20_000,
    maxRows: 100,
    maxPayloadBytes: 65_536
  },
  statements: [
    {
      ...baseStatement,
      id: 'migration_ledger_shape',
      sql: "SELECT '0196'::text AS migration_label UNION ALL SELECT '0197'::text AS migration_label ORDER BY migration_label",
      assertions: [
        { id: 'migration_order', kind: 'ordered_projection_equals', fields: ['migration_label'], expected: migrationRows }
      ]
    },
    {
      ...baseStatement,
      id: 'fixture_budget_counts',
      sql: 'SELECT 0::integer AS runtime_allocations, 0::integer AS expected_zero_rows',
      expectedShape: 'scalar',
      assertions: [
        { id: 'runtime_allocation_zero', kind: 'scalar_equals', column: 'runtime_allocations', expected: 0 },
        { id: 'expected_categories_zero', kind: 'scalar_equals', column: 'expected_zero_rows', expected: 0 }
      ]
    },
    {
      ...baseStatement,
      id: 'stable_set_composite_key',
      sql: "SELECT 'synthetic-org-a'::text AS organization_key, 'synthetic-allocation-a'::text AS allocation_key UNION ALL SELECT 'synthetic-org-b'::text AS organization_key, 'synthetic-allocation-a'::text AS allocation_key",
      assertions: [
        {
          id: 'stable_set_equal',
          kind: 'set_equals',
          keyFields: ['organization_key', 'allocation_key'],
          expected: stableRows
        }
      ]
    },
    {
      ...baseStatement,
      id: 'ordered_projection_digest',
      sql: "SELECT 1::integer AS ordinal, 'first'::text AS category UNION ALL SELECT 2::integer AS ordinal, 'second'::text AS category ORDER BY ordinal",
      assertions: [
        { id: 'ordered_rows_equal', kind: 'ordered_projection_equals', fields: ['ordinal', 'category'], expected: orderedRows },
        { id: 'ordered_digest_equal', kind: 'digest_equals', expected: canonicalDigest(orderedRows) }
      ]
    }
  ]
});
