import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';
import { authenticateManifest, verifyAuthenticatedManifest } from './manifest.mjs';

const MANAGED_PROFILE_FORMAT = 'target-native-managed-profile-certificate-v1';
const MANAGED_PROFILE_CANONICALIZATION = 'target-native-managed-profile-c14n-v1';
const MANAGED_PROFILE_SECURITY_POLICY_FORMAT = 'target-native-managed-security-policy-v1';
const MANAGED_PROFILE_SECURITY_RESULT_FORMAT = 'target-native-managed-security-result-v1';

const APPLICATION_FACING_ROLES = Object.freeze([
  'anon',
  'authenticated',
  'authenticator',
  'service_role'
]);

const EVIDENCE_ROW_SCHEMAS = Object.freeze({
  roles: Object.freeze([
    'role_name', 'rolsuper', 'rolinherit', 'rolcreaterole', 'rolcreatedb', 'rolcanlogin',
    'rolreplication', 'rolbypassrls', 'rolconfig'
  ]),
  schemas: Object.freeze(['schema_name', 'owner_role']),
  schemaAcls: Object.freeze([
    'schema_name', 'owner_role', 'grantor_role', 'grantee', 'privilege_type', 'is_grantable'
  ]),
  defaultAcls: Object.freeze([
    'owner_role', 'schema_name', 'object_type', 'grantor_role', 'grantee',
    'privilege_type', 'is_grantable'
  ]),
  memberships: Object.freeze([
    'member_role', 'granted_role', 'grantor_role', 'admin_option', 'inherit_option', 'set_option'
  ]),
  managedObjects: Object.freeze([
    'schema_name', 'object_type', 'object_identity', 'owner_role'
  ]),
  managedObjectAcls: Object.freeze([
    'schema_name', 'object_type', 'object_identity', 'owner_role', 'grantor_role',
    'grantee', 'privilege_type', 'is_grantable'
  ]),
  authOwners: Object.freeze(['owner_role']),
  extensions: Object.freeze([
    'extension_name', 'schema_name', 'owner_role', 'extension_version'
  ]),
  publications: Object.freeze([
    'publication_name', 'owner_role', 'all_tables', 'insert_enabled', 'update_enabled',
    'delete_enabled', 'truncate_enabled', 'via_root'
  ]),
  publicationRelations: Object.freeze([
    'publication_name', 'schema_name', 'relation_name'
  ]),
  roleCapabilities: Object.freeze([
    'role_name', 'public_usage', 'public_create', 'public_owner_member'
  ])
});

const BOOLEAN_FIELDS = new Set([
  'rolsuper', 'rolinherit', 'rolcreaterole', 'rolcreatedb', 'rolcanlogin',
  'rolreplication', 'rolbypassrls', 'is_grantable', 'admin_option', 'inherit_option',
  'set_option', 'all_tables', 'insert_enabled', 'update_enabled', 'delete_enabled',
  'truncate_enabled', 'via_root', 'public_usage', 'public_create', 'public_owner_member'
]);

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeText(value, code = 'MANAGED_PROFILE_TEXT_INVALID') {
  const text = String(value ?? '');
  if (!text || text.length > 1024 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw categoricalError(code);
  }
  return text;
}

function normalizeBoolean(value) {
  if (value !== true && value !== false) {
    throw categoricalError('MANAGED_PROFILE_BOOLEAN_INVALID');
  }
  return value;
}

function normalizeStringArray(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw categoricalError(code);
  const normalized = value.map((entry) => normalizeText(entry, code)).sort();
  if (new Set(normalized).size !== normalized.length) throw categoricalError(code);
  return normalized;
}

function normalizeRow(row, fields, collectionName) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw categoricalError('MANAGED_PROFILE_EVIDENCE_ROW_INVALID');
  }
  const actualKeys = Object.keys(row).sort();
  const expectedKeys = [...fields].sort();
  if (canonicalSerialize(actualKeys) !== canonicalSerialize(expectedKeys)) {
    throw categoricalError('MANAGED_PROFILE_EVIDENCE_ROW_SHAPE_INVALID');
  }
  const normalized = {};
  for (const field of fields) {
    if (field === 'rolconfig') {
      normalized[field] = normalizeStringArray(row[field], 'MANAGED_PROFILE_ROLE_CONFIG_INVALID');
    } else if (BOOLEAN_FIELDS.has(field)) {
      normalized[field] = normalizeBoolean(row[field]);
    } else {
      const allowEmpty = field === 'schema_name' && collectionName === 'defaultAcls';
      const text = String(row[field] ?? '');
      if ((!allowEmpty && !text) || text.length > 1024 || /[\u0000-\u001f\u007f]/.test(text)) {
        throw categoricalError('MANAGED_PROFILE_EVIDENCE_TEXT_INVALID');
      }
      normalized[field] = text;
    }
  }
  return normalized;
}

function normalizeCollection(value, collectionName) {
  if (!Array.isArray(value)) throw categoricalError('MANAGED_PROFILE_EVIDENCE_COLLECTION_INVALID');
  const fields = EVIDENCE_ROW_SCHEMAS[collectionName];
  const normalized = value.map((row) => normalizeRow(row, fields, collectionName));
  normalized.sort((left, right) => canonicalSerialize(left).localeCompare(canonicalSerialize(right)));
  const serialized = normalized.map((row) => canonicalSerialize(row));
  if (new Set(serialized).size !== serialized.length) {
    const error = categoricalError('MANAGED_PROFILE_EVIDENCE_DUPLICATE_ROW');
    error.collection = collectionName;
    const counts = new Map();
    for (const value of serialized) counts.set(value, (counts.get(value) || 0) + 1);
    const duplicateRows = normalized.filter((row) => counts.get(canonicalSerialize(row)) > 1);
    error.duplicateCount = duplicateRows.length - new Set(
      duplicateRows.map((row) => canonicalSerialize(row))
    ).size;
    error.duplicateCategories = [...new Set(
      duplicateRows.map((row) => row.object_type || row.privilege_type || 'uncategorized')
    )].sort();
    throw error;
  }
  return normalized;
}

function normalizeManagedProfileEvidence(evidence = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw categoricalError('MANAGED_PROFILE_EVIDENCE_INVALID');
  }
  const expectedKeys = Object.keys(EVIDENCE_ROW_SCHEMAS).sort();
  const actualKeys = Object.keys(evidence).sort();
  if (canonicalSerialize(actualKeys) !== canonicalSerialize(expectedKeys)) {
    throw categoricalError('MANAGED_PROFILE_EVIDENCE_SHAPE_INVALID');
  }
  return Object.fromEntries(
    Object.keys(EVIDENCE_ROW_SCHEMAS).map((name) => [name, normalizeCollection(evidence[name], name)])
  );
}

function managedProfileEvidenceFromCatalog(catalog = {}) {
  return normalizeManagedProfileEvidence(
    Object.fromEntries(Object.keys(EVIDENCE_ROW_SCHEMAS).map((name) => [name, catalog[name]]))
  );
}

function normalizeTarget(target = {}) {
  const environment = String(target.environment || '').trim().toLowerCase();
  const projectRef = String(target.projectRef || '').trim().toLowerCase();
  if (!['dev', 'sandbox'].includes(environment) || !/^[a-z0-9]{20}$/.test(projectRef)) {
    throw categoricalError('MANAGED_PROFILE_TARGET_INVALID');
  }
  return { environment, projectRef };
}

function normalizeRoleList(value, code) {
  if (!Array.isArray(value)) throw categoricalError(code);
  const roles = value.map((role) => normalizeText(role, code)).sort();
  if (new Set(roles).size !== roles.length) throw categoricalError(code);
  return roles;
}

function normalizePrivilegePaths(value) {
  if (!Array.isArray(value)) throw categoricalError('MANAGED_PROFILE_SECURITY_PATHS_INVALID');
  const paths = value.map((entry) => {
    if (
      !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      canonicalSerialize(Object.keys(entry).sort()) !== canonicalSerialize(['capability', 'source_role', 'target_role'])
    ) {
      throw categoricalError('MANAGED_PROFILE_SECURITY_PATH_INVALID');
    }
    const capability = normalizeText(entry.capability, 'MANAGED_PROFILE_SECURITY_PATH_INVALID');
    if (!['bypass_rls', 'owner_equivalent'].includes(capability)) {
      throw categoricalError('MANAGED_PROFILE_SECURITY_PATH_INVALID');
    }
    return {
      source_role: normalizeText(entry.source_role, 'MANAGED_PROFILE_SECURITY_PATH_INVALID'),
      target_role: normalizeText(entry.target_role, 'MANAGED_PROFILE_SECURITY_PATH_INVALID'),
      capability
    };
  });
  paths.sort((left, right) => canonicalSerialize(left).localeCompare(canonicalSerialize(right)));
  if (new Set(paths.map((entry) => canonicalSerialize(entry))).size !== paths.length) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_PATHS_INVALID');
  }
  return paths;
}

function normalizeSecurityPolicy(policy = {}) {
  const expectedKeys = [
    'format',
    'expectedPublicOwner',
    'applicationFacingRoles',
    'allowedApplicationPublicUsageRoles',
    'allowedApplicationLoginRoles',
    'allowedApplicationBypassRlsRoles',
    'allowedApplicationPrivilegePaths',
    'certifiedPrivilegedRoles'
  ].sort();
  if (
    !policy || typeof policy !== 'object' || Array.isArray(policy) ||
    canonicalSerialize(Object.keys(policy).sort()) !== canonicalSerialize(expectedKeys) ||
    policy.format !== MANAGED_PROFILE_SECURITY_POLICY_FORMAT
  ) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_POLICY_INVALID');
  }
  const normalized = {
    format: MANAGED_PROFILE_SECURITY_POLICY_FORMAT,
    expectedPublicOwner: normalizeText(
      policy.expectedPublicOwner,
      'MANAGED_PROFILE_SECURITY_PUBLIC_OWNER_INVALID'
    ),
    applicationFacingRoles: normalizeRoleList(
      policy.applicationFacingRoles,
      'MANAGED_PROFILE_SECURITY_APPLICATION_ROLES_INVALID'
    ),
    allowedApplicationPublicUsageRoles: normalizeRoleList(
      policy.allowedApplicationPublicUsageRoles,
      'MANAGED_PROFILE_SECURITY_USAGE_POLICY_INVALID'
    ),
    allowedApplicationLoginRoles: normalizeRoleList(
      policy.allowedApplicationLoginRoles,
      'MANAGED_PROFILE_SECURITY_LOGIN_POLICY_INVALID'
    ),
    allowedApplicationBypassRlsRoles: normalizeRoleList(
      policy.allowedApplicationBypassRlsRoles,
      'MANAGED_PROFILE_SECURITY_BYPASS_POLICY_INVALID'
    ),
    allowedApplicationPrivilegePaths: normalizePrivilegePaths(
      policy.allowedApplicationPrivilegePaths
    ),
    certifiedPrivilegedRoles: normalizeRoleList(
      policy.certifiedPrivilegedRoles,
      'MANAGED_PROFILE_SECURITY_PRIVILEGED_ROLES_INVALID'
    )
  };
  if (
    canonicalSerialize(normalized.applicationFacingRoles) !==
      canonicalSerialize([...APPLICATION_FACING_ROLES].sort())
  ) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_APPLICATION_ROLES_INVALID');
  }
  return normalized;
}

function membershipReachability(roles, memberships) {
  const adjacency = new Map(roles.map((role) => [role.role_name, new Set()]));
  for (const membership of memberships) {
    if (!adjacency.has(membership.member_role)) adjacency.set(membership.member_role, new Set());
    adjacency.get(membership.member_role).add(membership.granted_role);
  }
  const closure = new Map();
  for (const role of adjacency.keys()) {
    const reached = new Set([role]);
    const queue = [role];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const next of adjacency.get(current) || []) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    closure.set(role, reached);
  }
  return closure;
}

function sameSet(left, right) {
  return canonicalSerialize([...left].sort()) === canonicalSerialize([...right].sort());
}

function certifyManagedProfileSecurity(evidenceInput, policyInput) {
  const evidence = normalizeManagedProfileEvidence(evidenceInput);
  const policy = normalizeSecurityPolicy(policyInput);
  const roles = new Map(evidence.roles.map((role) => [role.role_name, role]));
  const capabilities = new Map(
    evidence.roleCapabilities.map((entry) => [entry.role_name, entry])
  );
  const publicSchema = evidence.schemas.find((entry) => entry.schema_name === 'public');
  if (!publicSchema || publicSchema.owner_role !== policy.expectedPublicOwner) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_PUBLIC_OWNER_MISMATCH');
  }
  for (const roleName of policy.applicationFacingRoles) {
    if (!roles.has(roleName) || !capabilities.has(roleName)) {
      throw categoricalError('MANAGED_PROFILE_SECURITY_APPLICATION_ROLE_MISSING');
    }
  }
  const applicationRoles = policy.applicationFacingRoles.map((roleName) => roles.get(roleName));
  if (applicationRoles.some((role) => role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication)) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_APPLICATION_ROLE_PRIVILEGED');
  }
  const publicUsage = applicationRoles
    .filter((role) => capabilities.get(role.role_name).public_usage)
    .map((role) => role.role_name);
  if (!sameSet(publicUsage, policy.allowedApplicationPublicUsageRoles)) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_PUBLIC_USAGE_MISMATCH');
  }
  const publicCreate = applicationRoles
    .filter((role) => capabilities.get(role.role_name).public_create)
    .map((role) => role.role_name);
  if (publicCreate.length !== 0) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_PUBLIC_CREATE_REJECTED');
  }
  const loginRoles = applicationRoles.filter((role) => role.rolcanlogin).map((role) => role.role_name);
  if (!sameSet(loginRoles, policy.allowedApplicationLoginRoles)) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_APPLICATION_LOGIN_MISMATCH');
  }
  const bypassRoles = applicationRoles.filter((role) => role.rolbypassrls).map((role) => role.role_name);
  if (!sameSet(bypassRoles, policy.allowedApplicationBypassRlsRoles)) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_APPLICATION_BYPASS_MISMATCH');
  }
  const publicGrantOptions = evidence.schemaAcls.filter(
    (entry) =>
      entry.schema_name === 'public' && entry.is_grantable &&
      (entry.grantee === 'PUBLIC' || policy.applicationFacingRoles.includes(entry.grantee))
  );
  if (publicGrantOptions.length !== 0) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_PUBLIC_GRANT_OPTION_REJECTED');
  }
  const privilegedRoles = evidence.roles
    .filter(
      (role) =>
        role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication ||
        role.rolbypassrls || role.role_name === publicSchema.owner_role
    )
    .map((role) => role.role_name);
  if (!sameSet(privilegedRoles, policy.certifiedPrivilegedRoles)) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_PRIVILEGED_ROLE_SET_MISMATCH');
  }
  const closure = membershipReachability(evidence.roles, evidence.memberships);
  const derivedPaths = [];
  for (const sourceRole of policy.applicationFacingRoles) {
    for (const targetRole of closure.get(sourceRole) || []) {
      const target = roles.get(targetRole);
      if (!target) continue;
      const ownerEquivalent =
        target.rolsuper || target.rolcreaterole || target.rolcreatedb ||
        target.role_name === publicSchema.owner_role;
      if (ownerEquivalent) {
        throw categoricalError('MANAGED_PROFILE_SECURITY_OWNER_PATH_REJECTED');
      }
      if (targetRole !== sourceRole && !policy.applicationFacingRoles.includes(targetRole)) {
        throw categoricalError('MANAGED_PROFILE_SECURITY_UNREVIEWED_APPLICATION_MEMBERSHIP_PATH');
      }
      if (target.rolbypassrls) {
        derivedPaths.push({ source_role: sourceRole, target_role: targetRole, capability: 'bypass_rls' });
      }
    }
  }
  derivedPaths.sort((left, right) => canonicalSerialize(left).localeCompare(canonicalSerialize(right)));
  if (derivedPaths.some((entry) => entry.capability === 'owner_equivalent')) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_OWNER_PATH_REJECTED');
  }
  if (
    canonicalSerialize(derivedPaths) !== canonicalSerialize(policy.allowedApplicationPrivilegePaths)
  ) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_PRIVILEGE_PATH_MISMATCH');
  }
  const publicOwnerCapabilities = evidence.roleCapabilities.filter(
    (entry) => entry.public_owner_member && policy.applicationFacingRoles.includes(entry.role_name)
  );
  if (publicOwnerCapabilities.length !== 0) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_OWNER_CAPABILITY_REJECTED');
  }
  return {
    format: MANAGED_PROFILE_SECURITY_RESULT_FORMAT,
    compatible: true,
    policyDigest: canonicalDigest(policy),
    publicOwner: publicSchema.owner_role,
    applicationFacingRoleCount: applicationRoles.length,
    publicUsageRoleCount: publicUsage.length,
    publicCreateRoleCount: 0,
    publicGrantOptionCount: 0,
    directBypassRoleCount: bypassRoles.length,
    approvedPrivilegePathCount: derivedPaths.length,
    ownerPathCount: 0,
    privilegedRoleCount: privilegedRoles.length,
    evidenceDigest: canonicalDigest(evidence)
  };
}

function buildManagedProfileCertificate({ profileId, target, evidence, securityPolicy } = {}) {
  const normalizedProfileId = String(profileId || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,95}$/.test(normalizedProfileId)) {
    throw categoricalError('MANAGED_PROFILE_ID_INVALID');
  }
  const normalizedTarget = normalizeTarget(target);
  const normalizedEvidence = normalizeManagedProfileEvidence(evidence);
  const normalizedPolicy = normalizeSecurityPolicy(securityPolicy);
  const security = certifyManagedProfileSecurity(normalizedEvidence, normalizedPolicy);
  return {
    format: MANAGED_PROFILE_FORMAT,
    version: 1,
    canonicalization: MANAGED_PROFILE_CANONICALIZATION,
    profileId: normalizedProfileId,
    target: normalizedTarget,
    profileDigest: canonicalDigest(normalizedEvidence),
    evidence: normalizedEvidence,
    securityPolicy: normalizedPolicy,
    security
  };
}

function authenticateManagedProfileCertificate(certificate, key) {
  return authenticateManifest(certificate, key);
}

function verifyManagedProfileCertificate({ certificate, key, target, evidence, expectedProfileId = '' } = {}) {
  const expectedKeys = [
    'format', 'version', 'canonicalization', 'profileId', 'target', 'profileDigest',
    'evidence', 'securityPolicy', 'security', 'authentication'
  ].sort();
  if (
    !certificate || typeof certificate !== 'object' || Array.isArray(certificate) ||
    canonicalSerialize(Object.keys(certificate).sort()) !== canonicalSerialize(expectedKeys) ||
    certificate?.format !== MANAGED_PROFILE_FORMAT || certificate?.version !== 1 ||
    certificate?.canonicalization !== MANAGED_PROFILE_CANONICALIZATION ||
    !/^[a-z][a-z0-9._-]{2,95}$/.test(String(certificate?.profileId || ''))
  ) {
    throw categoricalError('MANAGED_PROFILE_CERTIFICATE_FORMAT_INVALID');
  }
  try {
    verifyAuthenticatedManifest(certificate, key);
  } catch {
    throw categoricalError('MANAGED_PROFILE_CERTIFICATE_AUTHENTICATION_FAILED');
  }
  const normalizedTarget = normalizeTarget(target);
  if (canonicalSerialize(certificate.target) !== canonicalSerialize(normalizedTarget)) {
    throw categoricalError('MANAGED_PROFILE_TARGET_MISMATCH');
  }
  if (expectedProfileId && certificate.profileId !== expectedProfileId) {
    throw categoricalError('MANAGED_PROFILE_ID_MISMATCH');
  }
  const normalizedEvidence = normalizeManagedProfileEvidence(evidence);
  if (
    canonicalSerialize(certificate.evidence) !== canonicalSerialize(normalizedEvidence) ||
    certificate.profileDigest !== canonicalDigest(normalizedEvidence)
  ) {
    const error = categoricalError('MANAGED_PROFILE_EVIDENCE_MISMATCH');
    error.differenceCollections = Object.keys(EVIDENCE_ROW_SCHEMAS).filter(
      (name) => canonicalSerialize(certificate.evidence?.[name]) !== canonicalSerialize(normalizedEvidence[name])
    );
    error.counts = Object.fromEntries(error.differenceCollections.map((name) => [name, {
      certified: Array.isArray(certificate.evidence?.[name]) ? certificate.evidence[name].length : -1,
      observed: normalizedEvidence[name].length
    }]));
    throw error;
  }
  const security = certifyManagedProfileSecurity(normalizedEvidence, certificate.securityPolicy);
  if (canonicalSerialize(certificate.security) !== canonicalSerialize(security)) {
    throw categoricalError('MANAGED_PROFILE_SECURITY_RESULT_MISMATCH');
  }
  return {
    compatible: true,
    authenticated: true,
    target: normalizedTarget,
    profileId: certificate.profileId,
    profileDigest: certificate.profileDigest,
    securityDigest: canonicalDigest(security),
    security
  };
}

export {
  APPLICATION_FACING_ROLES,
  MANAGED_PROFILE_CANONICALIZATION,
  MANAGED_PROFILE_FORMAT,
  MANAGED_PROFILE_SECURITY_POLICY_FORMAT,
  MANAGED_PROFILE_SECURITY_RESULT_FORMAT,
  authenticateManagedProfileCertificate,
  buildManagedProfileCertificate,
  certifyManagedProfileSecurity,
  managedProfileEvidenceFromCatalog,
  normalizeManagedProfileEvidence,
  verifyManagedProfileCertificate
};
