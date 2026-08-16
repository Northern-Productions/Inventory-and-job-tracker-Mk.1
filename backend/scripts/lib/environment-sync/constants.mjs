const ENVIRONMENT_INVENTORY_FORMAT = 'environment-inventory-v1';
const BASELINE_MANIFEST_FORMAT = 'golden-prod-baseline-manifest-v1';
const DERIVED_MANIFEST_FORMAT = 'nonprod-baseline-manifest-v1';
const PRESERVATION_MANIFEST_FORMAT = 'dev-preservation-manifest-v1';
const RECOVERY_MANIFEST_FORMAT = 'dev-pre-refresh-recovery-manifest-v1';
const MANIFEST_AUTHENTICATION = 'hmac-sha256-v1';
const CANONICALIZATION_VERSION = 'environment-sync-c14n-v1';
const AUTH_QUARANTINE_VERSION = 'supabase-auth-quarantine-pg17-v1';
const SIDE_EFFECT_POLICY_VERSION = 'nonprod-side-effect-policy-v1';
const CANONICAL_APPLICATION_SOURCE_COMMIT = 'cc11d933900737d06ce4b47296226f13a51af548';
const EXPECTED_PROD_EDGE = Object.freeze({
  slug: 'api',
  version: 279,
  status: 'ACTIVE',
  verifyJwt: false,
  healthStatus: 'ok',
  buildSha: '647ecc8611a2283ac3d77a56d1103a03b4ad268d',
  projectStatus: 'ACTIVE_HEALTHY',
  region: 'us-west-2'
});

const SANDBOX_PROJECT_REF_VARIABLE = 'SANDBOX_SUPABASE_PROJECT_REF';

const TARGET_DATABASE_VARIABLES = Object.freeze({
  dev: ['DEV_DATABASE_URL', 'DATABASE_URL', 'SUPABASE_DB_URL'],
  prod: ['PROD_DATABASE_URL', 'DATABASE_URL', 'SUPABASE_DB_URL'],
  sandbox: ['SANDBOX_DATABASE_URL', 'DATABASE_URL', 'SUPABASE_DB_URL']
});

const TARGET_FRONTEND_VARIABLES = Object.freeze([
  'VITE_API_BASE_URL',
  'VITE_PROXY_TARGET',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY'
]);

const TARGET_SMOKE_VARIABLES = Object.freeze([
  'SMOKE_USER_EMAIL',
  'SMOKE_USER_PASSWORD',
  'SMOKE_USER_ROLE',
  'SMOKE_AUTH_TOKEN',
  'SMOKE_INCLUDE_MUTATIONS',
  'SMOKE_TRANSFER_BOX_ID',
  'SMOKE_TRANSFER_DEST_WAREHOUSE',
  'SMOKE_TRANSFER_ROUNDTRIP'
]);

const CURRENT_AUTH_TABLES = Object.freeze([
  'audit_log_entries',
  'custom_oauth_providers',
  'flow_state',
  'identities',
  'instances',
  'mfa_amr_claims',
  'mfa_challenges',
  'mfa_factors',
  'oauth_authorizations',
  'oauth_client_states',
  'oauth_clients',
  'oauth_consents',
  'one_time_tokens',
  'refresh_tokens',
  'saml_providers',
  'saml_relay_states',
  'schema_migrations',
  'sessions',
  'sso_domains',
  'sso_providers',
  'users',
  'webauthn_challenges',
  'webauthn_credentials'
]);

const REQUIRED_AUTH_COLUMNS = Object.freeze({
  users: [
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
    'is_anonymous'
  ],
  identities: [
    'id',
    'user_id',
    'provider_id',
    'identity_data',
    'provider',
    'email',
    'last_sign_in_at',
    'created_at',
    'updated_at'
  ]
});

const AUTH_PURGE_ORDER = Object.freeze([
  'mfa_amr_claims',
  'refresh_tokens',
  'sessions',
  'one_time_tokens',
  'flow_state',
  'mfa_challenges',
  'mfa_factors',
  'webauthn_challenges',
  'webauthn_credentials',
  'oauth_authorizations',
  'oauth_consents',
  'oauth_client_states',
  'oauth_clients',
  'saml_relay_states',
  'saml_providers',
  'sso_domains',
  'sso_providers',
  'custom_oauth_providers',
  'audit_log_entries'
]);

const GOLDEN_WORKFLOW_CONTRACT = Object.freeze([
  'native_nonprod_sign_in',
  'organization_access_context',
  'permissions',
  'default_warehouse',
  'inventory_search',
  'create_job',
  'allocate_remove_film',
  'same_box_requirement_extra',
  'auto_allocate',
  'film_order_create_receive_fulfill',
  'immutable_receipt_history',
  'receive_create_box',
  'transfer_receive_cancel',
  'checkout_checkin',
  'caulk_create_allocate_fulfill',
  'label_flow',
  'staged_pickup',
  'team_multi_org_permissions',
  'job_deletion',
  'authorization_isolation'
]);

const SYNC_RUNBOOK_CHECKPOINTS = Object.freeze([
  { id: 'A', name: 'stable_prod', actions: ['provider_backup', 'health', 'quiet_snapshot', 'source_identity'] },
  { id: 'B', name: 'golden_x', actions: ['capture', 'encrypt', 'hash', 'restore_test', 'manifest'] },
  { id: 'C', name: 'dev_recovery_y', actions: ['capture', 'encrypt', 'restore_test', 'preservation_manifest'] },
  { id: 'D', name: 'sandbox', actions: ['create_project', 'target_guard', 'restore_x', 'apply_x_np', 'settings', 'native_smoke', 'edge', 'local_frontend', 'workflows', 'parity'] },
  { id: 'E', name: 'dev', actions: ['target_guard', 'restore_x', 'apply_x_np', 'dev_preservation', 'edge', 'workflows', 'parity'] },
  { id: 'F', name: 'lineage', actions: ['prove_sandbox_lineage', 'prove_dev_lineage', 'retain_x_y'] }
]);

const DEFAULT_ALLOWED_NONPROD_EXCEPTIONS = Object.freeze([
  '/target/environment',
  '/target/projectRef',
  '/platform/project/region',
  '/platform/edge/deployments',
  '/platform/auth/siteUrlClass',
  '/platform/auth/redirectUrlClasses',
  '/platform/secrets/names',
  '/configuration/variableNames',
  '/authTopology/users',
  '/authTopology/identities',
  '/authTopology/memberships',
  '/authTopology/sessionAndTokenCounts'
]);

export {
  AUTH_PURGE_ORDER,
  AUTH_QUARANTINE_VERSION,
  BASELINE_MANIFEST_FORMAT,
  CANONICAL_APPLICATION_SOURCE_COMMIT,
  CANONICALIZATION_VERSION,
  CURRENT_AUTH_TABLES,
  DEFAULT_ALLOWED_NONPROD_EXCEPTIONS,
  DERIVED_MANIFEST_FORMAT,
  ENVIRONMENT_INVENTORY_FORMAT,
  EXPECTED_PROD_EDGE,
  GOLDEN_WORKFLOW_CONTRACT,
  MANIFEST_AUTHENTICATION,
  PRESERVATION_MANIFEST_FORMAT,
  RECOVERY_MANIFEST_FORMAT,
  REQUIRED_AUTH_COLUMNS,
  SANDBOX_PROJECT_REF_VARIABLE,
  SIDE_EFFECT_POLICY_VERSION,
  SYNC_RUNBOOK_CHECKPOINTS,
  TARGET_DATABASE_VARIABLES,
  TARGET_FRONTEND_VARIABLES,
  TARGET_SMOKE_VARIABLES
};
