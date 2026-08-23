import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPLICATION_FACING_ROLES,
  MANAGED_PROFILE_SECURITY_POLICY_FORMAT,
  authenticateManagedProfileCertificate,
  buildManagedProfileCertificate,
  verifyManagedProfileCertificate
} from './managed-profile.mjs';

const KEY = Buffer.from('managed-profile-test-key-material-00000000000000000000000000000000');
const DEV_TARGET = Object.freeze({ environment: 'dev', projectRef: 'd'.repeat(20) });
const SANDBOX_TARGET = Object.freeze({ environment: 'sandbox', projectRef: 's'.repeat(20) });

function role(role_name, overrides = {}) {
  return {
    role_name,
    rolsuper: false,
    rolinherit: true,
    rolcreaterole: false,
    rolcreatedb: false,
    rolcanlogin: false,
    rolreplication: false,
    rolbypassrls: false,
    rolconfig: [],
    ...overrides
  };
}

function evidence(publicOwner = 'postgres') {
  const roles = [
    role('anon'),
    role('authenticated'),
    role('authenticator', { rolcanlogin: true }),
    role('cli_login_postgres', { rolcanlogin: true }),
    role('pg_database_owner'),
    role('postgres', {
      rolcreaterole: true,
      rolcreatedb: true,
      rolcanlogin: true,
      rolreplication: true,
      rolbypassrls: true
    }),
    role('service_role', { rolbypassrls: true }),
    role('supabase_admin', { rolsuper: true }),
    role('supabase_auth_admin', { rolcreaterole: true }),
    role('supabase_realtime_admin'),
    role('supabase_storage_admin', { rolcreaterole: true })
  ];
  const schemaOwners = {
    auth: 'supabase_admin',
    extensions: 'postgres',
    graphql: 'supabase_admin',
    graphql_public: 'supabase_admin',
    public: publicOwner,
    realtime: 'supabase_admin',
    storage: 'supabase_admin',
    supabase_migrations: 'postgres',
    vault: 'supabase_admin'
  };
  return {
    roles,
    schemas: Object.entries(schemaOwners).map(([schema_name, owner_role]) => ({ schema_name, owner_role })),
    schemaAcls: [
      ...APPLICATION_FACING_ROLES.map((grantee) => ({
        schema_name: 'public', owner_role: publicOwner, grantor_role: publicOwner,
        grantee, privilege_type: 'USAGE', is_grantable: false
      })),
      {
        schema_name: 'public', owner_role: publicOwner, grantor_role: publicOwner,
        grantee: publicOwner, privilege_type: 'CREATE', is_grantable: true
      },
      {
        schema_name: 'public', owner_role: publicOwner, grantor_role: publicOwner,
        grantee: publicOwner, privilege_type: 'USAGE', is_grantable: true
      }
    ],
    defaultAcls: [{
      owner_role: 'postgres', schema_name: 'public', object_type: 'f',
      grantor_role: 'postgres', grantee: 'authenticated', privilege_type: 'EXECUTE',
      is_grantable: false
    }],
    memberships: [
      {
        member_role: 'authenticator', granted_role: 'anon', grantor_role: 'postgres',
        admin_option: false, inherit_option: true, set_option: true
      },
      {
        member_role: 'authenticator', granted_role: 'authenticated', grantor_role: 'postgres',
        admin_option: false, inherit_option: true, set_option: true
      },
      {
        member_role: 'authenticator', granted_role: 'service_role', grantor_role: 'postgres',
        admin_option: false, inherit_option: true, set_option: true
      },
      {
        member_role: 'cli_login_postgres', granted_role: 'postgres', grantor_role: 'postgres',
        admin_option: false, inherit_option: true, set_option: true
      }
    ],
    managedObjects: [
      { schema_name: 'auth', object_type: 'relation:r', object_identity: 'users', owner_role: 'supabase_auth_admin' }
    ],
    managedObjectAcls: [{
      schema_name: 'auth', object_type: 'relation:r', object_identity: 'users',
      owner_role: 'supabase_auth_admin', grantor_role: 'supabase_auth_admin',
      grantee: 'supabase_auth_admin', privilege_type: 'SELECT', is_grantable: true
    }],
    authOwners: [{ owner_role: 'supabase_auth_admin' }],
    extensions: [
      { extension_name: 'pgcrypto', schema_name: 'extensions', owner_role: 'postgres', extension_version: '1.3' },
      { extension_name: 'uuid-ossp', schema_name: 'extensions', owner_role: 'postgres', extension_version: '1.1' }
    ],
    publications: [{
      publication_name: 'supabase_realtime', owner_role: 'postgres', all_tables: false,
      insert_enabled: true, update_enabled: true, delete_enabled: true,
      truncate_enabled: true, via_root: false
    }],
    publicationRelations: [],
    roleCapabilities: roles.map((entry) => ({
      role_name: entry.role_name,
      public_usage: APPLICATION_FACING_ROLES.includes(entry.role_name) || entry.role_name === publicOwner,
      public_create: entry.role_name === publicOwner,
      public_owner_member: entry.role_name === publicOwner
    }))
  };
}

function securityPolicy(publicOwner = 'postgres') {
  return {
    format: MANAGED_PROFILE_SECURITY_POLICY_FORMAT,
    expectedPublicOwner: publicOwner,
    applicationFacingRoles: [...APPLICATION_FACING_ROLES],
    allowedApplicationPublicUsageRoles: [...APPLICATION_FACING_ROLES],
    allowedApplicationLoginRoles: ['authenticator'],
    allowedApplicationBypassRlsRoles: ['service_role'],
    allowedApplicationPrivilegePaths: [
      { source_role: 'authenticator', target_role: 'service_role', capability: 'bypass_rls' },
      { source_role: 'service_role', target_role: 'service_role', capability: 'bypass_rls' }
    ],
    certifiedPrivilegedRoles: [
      'postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin',
      ...(publicOwner === 'pg_database_owner' ? ['pg_database_owner'] : [])
    ]
  };
}

function certificateFor(target, publicOwner, profileId) {
  return authenticateManagedProfileCertificate(buildManagedProfileCertificate({
    profileId,
    target,
    evidence: evidence(publicOwner),
    securityPolicy: securityPolicy(publicOwner)
  }), KEY);
}

test('authenticated DEV and SANDBOX profiles accept only their exact target-native evidence', () => {
  const dev = certificateFor(DEV_TARGET, 'postgres', 'dev-historical-managed-profile');
  const sandbox = certificateFor(
    SANDBOX_TARGET,
    'pg_database_owner',
    'sandbox-current-managed-profile'
  );
  const devProof = verifyManagedProfileCertificate({
    certificate: dev, key: KEY, target: DEV_TARGET, evidence: evidence('postgres')
  });
  const sandboxProof = verifyManagedProfileCertificate({
    certificate: sandbox, key: KEY, target: SANDBOX_TARGET,
    evidence: evidence('pg_database_owner')
  });
  assert.equal(devProof.authenticated, true);
  assert.equal(sandboxProof.authenticated, true);
  assert.notEqual(devProof.profileDigest, sandboxProof.profileDigest);
});

test('profiles reject changed owners, defaults, memberships, role attributes, schemas, and ACLs', () => {
  const certificate = certificateFor(DEV_TARGET, 'postgres', 'dev-historical-managed-profile');
  const mutations = [
    (value) => { value.schemas.find((entry) => entry.schema_name === 'public').owner_role = 'pg_database_owner'; },
    (value) => { value.defaultAcls[0].is_grantable = true; },
    (value) => { value.memberships[0].set_option = false; },
    (value) => { value.roles.find((entry) => entry.role_name === 'authenticated').rolbypassrls = true; },
    (value) => { value.schemas.push({ schema_name: 'unexpected_managed', owner_role: 'postgres' }); },
    (value) => { value.schemaAcls.push({
      schema_name: 'public', owner_role: 'postgres', grantor_role: 'postgres',
      grantee: 'unexpected_role', privilege_type: 'USAGE', is_grantable: false
    }); },
    (value) => { value.schemaAcls.find((entry) => entry.grantee === 'authenticated').is_grantable = true; },
    (value) => { value.managedObjects.push({
      schema_name: 'auth', object_type: 'relation:r', object_identity: 'unexpected',
      owner_role: 'supabase_auth_admin'
    }); }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(evidence('postgres'));
    mutate(changed);
    assert.throws(
      () => verifyManagedProfileCertificate({
        certificate, key: KEY, target: DEV_TARGET, evidence: changed
      }),
      /MANAGED_PROFILE_EVIDENCE_MISMATCH/
    );
  }
});

test('unsafe application-facing CREATE, owner, and bypass paths cannot be certified', () => {
  const unsafeCreate = evidence('postgres');
  unsafeCreate.roleCapabilities.find((entry) => entry.role_name === 'authenticated').public_create = true;
  assert.throws(
    () => buildManagedProfileCertificate({
      profileId: 'unsafe-create', target: DEV_TARGET, evidence: unsafeCreate,
      securityPolicy: securityPolicy('postgres')
    }),
    /MANAGED_PROFILE_SECURITY_PUBLIC_CREATE_REJECTED/
  );

  const unsafeBypass = evidence('postgres');
  unsafeBypass.roles.find((entry) => entry.role_name === 'authenticated').rolbypassrls = true;
  assert.throws(
    () => buildManagedProfileCertificate({
      profileId: 'unsafe-bypass', target: DEV_TARGET, evidence: unsafeBypass,
      securityPolicy: securityPolicy('postgres')
    }),
    /MANAGED_PROFILE_SECURITY_APPLICATION_BYPASS_MISMATCH/
  );

  const unsafeOwnerPath = evidence('postgres');
  unsafeOwnerPath.memberships.push({
    member_role: 'authenticated', granted_role: 'postgres', grantor_role: 'postgres',
    admin_option: false, inherit_option: true, set_option: true
  });
  assert.throws(
    () => buildManagedProfileCertificate({
      profileId: 'unsafe-owner-path', target: DEV_TARGET, evidence: unsafeOwnerPath,
      securityPolicy: securityPolicy('postgres')
    }),
    /MANAGED_PROFILE_SECURITY_OWNER_PATH_REJECTED/
  );
});

test('profile authentication and target binding reject cross-profile use and tampering', () => {
  const dev = certificateFor(DEV_TARGET, 'postgres', 'dev-historical-managed-profile');
  const sandbox = certificateFor(
    SANDBOX_TARGET,
    'pg_database_owner',
    'sandbox-current-managed-profile'
  );
  assert.throws(
    () => verifyManagedProfileCertificate({
      certificate: dev, key: KEY, target: SANDBOX_TARGET, evidence: evidence('postgres')
    }),
    /MANAGED_PROFILE_TARGET_MISMATCH/
  );
  const changedSandbox = evidence('pg_database_owner');
  changedSandbox.schemas.find((entry) => entry.schema_name === 'public').owner_role = 'postgres';
  assert.throws(
    () => verifyManagedProfileCertificate({
      certificate: sandbox, key: KEY, target: SANDBOX_TARGET, evidence: changedSandbox
    }),
    /MANAGED_PROFILE_EVIDENCE_MISMATCH/
  );
  assert.throws(
    () => verifyManagedProfileCertificate({
      certificate: sandbox, key: KEY, target: DEV_TARGET, evidence: evidence('postgres')
    }),
    /MANAGED_PROFILE_TARGET_MISMATCH/
  );
  const tampered = structuredClone(dev);
  tampered.security.publicUsageRoleCount += 1;
  assert.throws(
    () => verifyManagedProfileCertificate({
      certificate: tampered, key: KEY, target: DEV_TARGET, evidence: evidence('postgres')
    }),
    /MANAGED_PROFILE_CERTIFICATE_AUTHENTICATION_FAILED/
  );
});
