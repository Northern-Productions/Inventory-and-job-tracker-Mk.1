import {
  PRESERVATION_MANIFEST_FORMAT,
  RECOVERY_MANIFEST_FORMAT,
  TARGET_FRONTEND_VARIABLES,
  TARGET_SMOKE_VARIABLES
} from './constants.mjs';

function asText(value) {
  return String(value ?? '').trim();
}

function sortedNames(values = []) {
  return Array.from(new Set(values.map(asText).filter(Boolean))).sort();
}

function buildDevPreservationManifest({
  projectRef,
  capturedAt,
  smokeIdentity,
  authSettings = {},
  secretNames = [],
  environmentVariableNames = [],
  projectSettings = {},
  retainedTestConfiguration = []
} = {}) {
  if (!asText(projectRef)) throw new Error('DEV project ref is required.');
  if (!asText(smokeIdentity?.userId)) throw new Error('DEV smoke identity mapping is required.');
  const memberships = Array.isArray(smokeIdentity.memberships) ? smokeIdentity.memberships : [];
  if (memberships.length === 0) throw new Error('DEV smoke membership mapping is required.');
  for (const membership of memberships) {
    if (!asText(membership.orgId) || !['owner', 'admin', 'member'].includes(asText(membership.role))) {
      throw new Error('DEV smoke membership is invalid.');
    }
  }
  return {
    format: PRESERVATION_MANIFEST_FORMAT,
    version: 1,
    target: { environment: 'dev', projectRef: asText(projectRef) },
    capturedAt: asText(capturedAt),
    smokeIdentity: {
      userId: asText(smokeIdentity.userId),
      memberships: memberships
        .map((entry) => ({
          orgId: asText(entry.orgId),
          role: asText(entry.role),
          status: asText(entry.status) || 'active'
        }))
        .sort((a, b) => `${a.orgId}:${a.role}`.localeCompare(`${b.orgId}:${b.role}`)),
      recreationVariables: sortedNames(TARGET_SMOKE_VARIABLES)
    },
    authSettings,
    secretNames: sortedNames(secretNames),
    environmentVariableNames: sortedNames([
      ...environmentVariableNames,
      ...TARGET_FRONTEND_VARIABLES,
      ...TARGET_SMOKE_VARIABLES
    ]),
    projectSettings,
    retainedTestConfiguration: sortedNames(retainedTestConfiguration),
    excluded: [
      'business_rows',
      'sessions',
      'refresh_tokens',
      'ephemeral_auth_flow_state',
      'tagged_film_order_fixture_history',
      'tagged_starter_weight_profiles'
    ]
  };
}

function buildDevRecoveryManifest({
  recoveryId,
  capturedAt,
  components = [],
  inventoryDigest,
  preservationManifestDigest,
  restoreTest = {}
} = {}) {
  if (!asText(recoveryId) || !asText(inventoryDigest) || !asText(preservationManifestDigest)) {
    throw new Error('DEV recovery manifest identity is incomplete.');
  }
  return {
    format: RECOVERY_MANIFEST_FORMAT,
    version: 1,
    recoveryId: asText(recoveryId),
    capturedAt: asText(capturedAt),
    components,
    inventoryDigest: asText(inventoryDigest),
    preservationManifestDigest: asText(preservationManifestDigest),
    restoreTest: {
      completed: restoreTest.completed === true,
      result: asText(restoreTest.result)
    },
    retention: 'through_post_refresh_acceptance'
  };
}

export { buildDevPreservationManifest, buildDevRecoveryManifest };
