import { GOLDEN_WORKFLOW_CONTRACT, SYNC_RUNBOOK_CHECKPOINTS } from './constants.mjs';

function buildGoldenWorkflowContract() {
  return {
    format: 'golden-nonprod-workflow-contract-v1',
    version: 1,
    targets: ['sandbox', 'dev'],
    executionOrder: ['sandbox', 'dev'],
    workflows: GOLDEN_WORKFLOW_CONTRACT.map((name, index) => ({ order: index + 1, name })),
    fixturePolicy: {
      guardedNonprodOnly: true,
      exactPrivateManifest: true,
      exactIdCleanup: true,
      oneTransactionCleanup: true,
      discoveryAddedTargets: false,
      strictNonfixtureAfterState: true
    }
  };
}

function buildSyncRunbook() {
  return {
    format: 'prod-to-nonprod-sync-runbook-v1',
    version: 1,
    baselineLineage: {
      sandbox: 'PROD_X -> SANDBOX_X_NP',
      dev: 'PROD_X -> DEV_X_NP + DECLARED_DEV_EXCEPTIONS'
    },
    checkpoints: SYNC_RUNBOOK_CHECKPOINTS,
    failClosed: true,
    retainsGoldenAndRecoveryArtifactsThroughAcceptance: true
  };
}

function buildArchitectureAlignmentTemplate() {
  return {
    format: 'post-refresh-architecture-alignment-v1',
    sections: [
      'inventory_domain_map',
      'film_physical_capacity_model',
      'reservations',
      'requirements',
      'extra',
      'film_orders',
      'receipts',
      'transfers',
      'checkout_checkin',
      'staged_pickup',
      'caulk',
      'organizations_auth',
      'table_function_edge_api_frontend_dependencies',
      'golden_workflow_coverage',
      'architecture_debt',
      'missing_adrs_tests_docs'
    ],
    sandboxBoundary: {
      subject: 'pooled_film_reservation_and_staged_physical_box_assignment',
      decisions: [
        'pool_key',
        'reservation_capacity',
        'physical_assignment_time',
        'requirement_extra_interaction',
        'cross_warehouse_behavior',
        'film_order_receipts',
        'staged_pickup',
        'audit_and_undo',
        'concurrency',
        'migration_strategy'
      ]
    }
  };
}

export { buildArchitectureAlignmentTemplate, buildGoldenWorkflowContract, buildSyncRunbook };
