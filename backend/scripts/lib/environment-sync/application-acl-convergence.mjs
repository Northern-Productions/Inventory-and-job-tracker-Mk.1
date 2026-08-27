import { canonicalDigest, canonicalSerialize } from '../readonly-diagnostics.mjs';

const APPLICATION_ACL_CONTRACT_FORMAT = 'application-acl-contract-v1';
const APPLICATION_ACL_CONVERGENCE_FORMAT = 'application-acl-convergence-manifest-v1';
const APPLICATION_ACL_CANONICALIZATION = 'application-acl-c14n-v1';
const APPLICATION_OBJECT_CLASSES = Object.freeze([
  'schema',
  'table',
  'view',
  'sequence',
  'function',
  'procedure'
]);
const APPLICATION_FACING_ROLES = Object.freeze([
  'PUBLIC',
  'anon',
  'authenticated',
  'authenticator',
  'service_role'
]);
const TARGET_NATIVE_AUTHENTICATOR_PUBLIC_SCHEMA_USAGE = Object.freeze({
  classification: 'TARGET_NATIVE_AUTHENTICATOR_PUBLIC_SCHEMA_USAGE',
  count: 1,
  digest: 'sha256:a1c886a69af16049b426f4779befe853c8f8229fbd96fd7743a2b721cce96720',
  catalogDigest: 'sha256:994e4f57b2a0421f1a4604b608fc8f261edad5704eac2d0d46ae4de754ec8fbb',
  grantee: 'authenticator',
  schema: 'public',
  privilege: 'USAGE',
  create: false,
  tableOperations: 0,
  sequenceOperations: 0,
  directApplicationFunctionExecute: 0,
  additionalApplicationOperations: 0,
  targetPrestatePreserved: true,
  prodPeerMatch: true,
  broadSchemaIgnore: false
});
const OBJECT_PRIVILEGES = Object.freeze({
  schema: Object.freeze(['CREATE', 'USAGE']),
  table: Object.freeze(['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']),
  view: Object.freeze(['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']),
  sequence: Object.freeze(['SELECT', 'UPDATE', 'USAGE']),
  function: Object.freeze(['EXECUTE']),
  procedure: Object.freeze(['EXECUTE'])
});

const APPLICATION_ACL_OBJECTS_SQL = `with application_objects as (
  select 'schema'::text as "objectClass", n.nspname::text as "schemaName",
         n.nspname::text as "objectName", ''::text as "identityArguments",
         owner.rolname::text as "ownerRole", false as "securityDefiner"
    from pg_catalog.pg_namespace n
    join pg_catalog.pg_roles owner on owner.oid = n.nspowner
   where n.nspname = any(array['app','app_api'])
  union all
  select case c.relkind when 'S' then 'sequence'
                        when 'v' then 'view'
                        when 'm' then 'view'
                        else 'table' end,
         n.nspname, c.relname, '', owner.rolname, false
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = c.relowner
   where n.nspname = any(array['app','app_api'])
     and c.relkind = any(array['r'::"char",'p'::"char",'v'::"char",'m'::"char",'S'::"char"])
  union all
  select case p.prokind when 'p' then 'procedure' else 'function' end,
         n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
         owner.rolname, p.prosecdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
   where p.prokind = any(array['f'::"char",'p'::"char"])
     and (n.nspname = any(array['app','app_api'])
       or (n.nspname = 'public' and owner.rolname = 'postgres'))
)
select "objectClass", "schemaName", "objectName", "identityArguments",
       "ownerRole", "securityDefiner"
  from application_objects
 order by "objectClass", "schemaName", "objectName", "identityArguments"`;

const APPLICATION_ACL_GRANTS_SQL = `with application_grants as (
  select 'schema'::text as "objectClass", n.nspname::text as "schemaName",
         n.nspname::text as "objectName", ''::text as "identityArguments",
         owner.rolname::text as "ownerRole", grantor.rolname::text as "grantor",
         coalesce(grantee.rolname, 'PUBLIC')::text as "grantee",
         acl.privilege_type::text as "privilege", acl.is_grantable as "grantable"
    from pg_catalog.pg_namespace n
    join pg_catalog.pg_roles owner on owner.oid = n.nspowner
    cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
   where n.nspname = any(array['app','app_api']) and acl.grantee <> n.nspowner
  union all
  select case c.relkind when 'S' then 'sequence'
                        when 'v' then 'view'
                        when 'm' then 'view'
                        else 'table' end,
         n.nspname, c.relname, '', owner.rolname, grantor.rolname,
         coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type, acl.is_grantable
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = c.relowner
    cross join lateral pg_catalog.aclexplode(
      coalesce(c.relacl, pg_catalog.acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner))
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
   where n.nspname = any(array['app','app_api'])
     and c.relkind = any(array['r'::"char",'p'::"char",'v'::"char",'m'::"char",'S'::"char"])
     and acl.grantee <> c.relowner
  union all
  select case p.prokind when 'p' then 'procedure' else 'function' end,
         n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
         owner.rolname, grantor.rolname, coalesce(grantee.rolname, 'PUBLIC'),
         acl.privilege_type, acl.is_grantable
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
    cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
   where p.prokind = any(array['f'::"char",'p'::"char"])
     and (n.nspname = any(array['app','app_api'])
       or (n.nspname = 'public' and owner.rolname = 'postgres'))
     and acl.grantee <> p.proowner
)
select "objectClass", "schemaName", "objectName", "identityArguments",
       "ownerRole", "grantor", "grantee", "privilege", "grantable"
  from application_grants
 order by "objectClass", "schemaName", "objectName", "identityArguments",
          "grantee", "privilege", "grantor", "grantable"`;

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function checkedText(value, code) {
  const text = String(value ?? '');
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) throw categoricalError(code);
  return text;
}

function checkedOptionalText(value, code) {
  const text = String(value ?? '');
  if (/[\u0000-\u001f\u007f]/.test(text)) throw categoricalError(code);
  return text;
}

function verifyCertifiedManagedAclExceptions(exceptions) {
  if (!Array.isArray(exceptions) || exceptions.length !== 1) {
    throw categoricalError('MANAGED_ACL_EXCEPTION_SET_UNCERTIFIED');
  }
  const exception = exceptions[0];
  if (
    !exception ||
    typeof exception !== 'object' ||
    Array.isArray(exception) ||
    canonicalSerialize(Object.keys(exception).sort()) !==
      canonicalSerialize(Object.keys(TARGET_NATIVE_AUTHENTICATOR_PUBLIC_SCHEMA_USAGE).sort()) ||
    canonicalSerialize(exception) !==
      canonicalSerialize(TARGET_NATIVE_AUTHENTICATOR_PUBLIC_SCHEMA_USAGE)
  ) {
    throw categoricalError('MANAGED_ACL_EXCEPTION_UNCERTIFIED');
  }
  return true;
}

function normalizeObject(row = {}) {
  const objectClass = checkedText(row.objectClass ?? row.object_class, 'APPLICATION_ACL_OBJECT_CLASS_INVALID');
  if (!APPLICATION_OBJECT_CLASSES.includes(objectClass)) {
    throw categoricalError('APPLICATION_ACL_OBJECT_CLASS_INVALID');
  }
  return {
    objectClass,
    schemaName: checkedText(row.schemaName ?? row.schema_name, 'APPLICATION_ACL_SCHEMA_INVALID'),
    objectName: checkedText(row.objectName ?? row.object_name, 'APPLICATION_ACL_OBJECT_NAME_INVALID'),
    identityArguments: checkedOptionalText(
      row.identityArguments ?? row.identity_arguments,
      'APPLICATION_ACL_SIGNATURE_INVALID'
    ),
    ownerRole: checkedText(row.ownerRole ?? row.owner_role, 'APPLICATION_ACL_OWNER_INVALID'),
    securityDefiner: row.securityDefiner === true || row.security_definer === true
  };
}

function normalizeGrant(row = {}) {
  const object = normalizeObject({ ...row, securityDefiner: false });
  const privilege = checkedText(row.privilege, 'APPLICATION_ACL_PRIVILEGE_INVALID').toUpperCase();
  if (!OBJECT_PRIVILEGES[object.objectClass].includes(privilege)) {
    throw categoricalError('APPLICATION_ACL_PRIVILEGE_INVALID');
  }
  return {
    objectClass: object.objectClass,
    schemaName: object.schemaName,
    objectName: object.objectName,
    identityArguments: object.identityArguments,
    ownerRole: object.ownerRole,
    grantor: checkedText(row.grantor, 'APPLICATION_ACL_GRANTOR_INVALID'),
    grantee: checkedText(row.grantee, 'APPLICATION_ACL_GRANTEE_INVALID'),
    privilege,
    grantable: row.grantable === true
  };
}

function objectKey(row) {
  return [row.objectClass, row.schemaName, row.objectName, row.identityArguments].join('\u0000');
}

function grantKey(row) {
  return [objectKey(row), row.grantee, row.privilege].join('\u0000');
}

function sortObjects(rows) {
  return [...rows].sort((left, right) => objectKey(left).localeCompare(objectKey(right), 'en'));
}

function sortGrants(rows) {
  return [...rows].sort((left, right) => {
    const keyOrder = grantKey(left).localeCompare(grantKey(right), 'en');
    if (keyOrder !== 0) return keyOrder;
    return canonicalSerialize(left).localeCompare(canonicalSerialize(right), 'en');
  });
}

function assertUnique(rows, keyOf, code) {
  if (new Set(rows.map(keyOf)).size !== rows.length) throw categoricalError(code);
}

function contractPayload(contract) {
  return {
    format: contract.format,
    version: contract.version,
    canonicalization: contract.canonicalization,
    scope: contract.scope,
    objects: contract.objects,
    grants: contract.grants,
    objectDigest: contract.objectDigest,
    grantDigest: contract.grantDigest
  };
}

function buildApplicationAclContract({ objects = [], grants = [] } = {}) {
  const normalizedObjects = sortObjects(objects.map(normalizeObject));
  const normalizedGrants = sortGrants(grants.map(normalizeGrant));
  assertUnique(normalizedObjects, objectKey, 'APPLICATION_ACL_OBJECT_DUPLICATE');
  assertUnique(normalizedGrants, grantKey, 'APPLICATION_ACL_GRANT_DUPLICATE');
  const objectIdentities = new Set(normalizedObjects.map(objectKey));
  if (normalizedGrants.some((grant) => !objectIdentities.has(objectKey(grant)))) {
    throw categoricalError('APPLICATION_ACL_GRANT_OBJECT_MISSING');
  }
  const contract = {
    format: APPLICATION_ACL_CONTRACT_FORMAT,
    version: 1,
    canonicalization: APPLICATION_ACL_CANONICALIZATION,
    scope: {
      portableSchemas: ['app', 'app_api'],
      publicRoutineOwner: 'postgres',
      ownerImplicitPrivilegesExcluded: true
    },
    objects: normalizedObjects,
    grants: normalizedGrants,
    objectDigest: canonicalDigest(normalizedObjects),
    grantDigest: canonicalDigest(normalizedGrants)
  };
  contract.contractDigest = canonicalDigest(contractPayload(contract));
  return contract;
}

function verifyApplicationAclContract(contract) {
  if (
    contract?.format !== APPLICATION_ACL_CONTRACT_FORMAT ||
    contract?.version !== 1 ||
    contract?.canonicalization !== APPLICATION_ACL_CANONICALIZATION ||
    !Array.isArray(contract?.objects) ||
    !Array.isArray(contract?.grants)
  ) {
    throw categoricalError('APPLICATION_ACL_CONTRACT_INVALID');
  }
  const rebuilt = buildApplicationAclContract({ objects: contract.objects, grants: contract.grants });
  if (canonicalSerialize(rebuilt) !== canonicalSerialize(contract)) {
    throw categoricalError('APPLICATION_ACL_CONTRACT_DIGEST_MISMATCH');
  }
  return true;
}

async function captureApplicationAclContract(client) {
  if (!client || typeof client.query !== 'function') {
    throw categoricalError('APPLICATION_ACL_CLIENT_INVALID');
  }
  const objects = await client.query(APPLICATION_ACL_OBJECTS_SQL);
  const grants = await client.query(APPLICATION_ACL_GRANTS_SQL);
  return buildApplicationAclContract({ objects: objects.rows, grants: grants.rows });
}

function compareApplicationAclContracts(source, target) {
  verifyApplicationAclContract(source);
  verifyApplicationAclContract(target);
  const sourceObjects = new Map(source.objects.map((row) => [objectKey(row), row]));
  const targetObjects = new Map(target.objects.map((row) => [objectKey(row), row]));
  const sourceGrants = new Map(source.grants.map((row) => [grantKey(row), row]));
  const targetGrants = new Map(target.grants.map((row) => [grantKey(row), row]));
  const sourceOnlyObjects = source.objects.filter((row) => !targetObjects.has(objectKey(row)));
  const targetOnlyObjects = target.objects.filter((row) => !sourceObjects.has(objectKey(row)));
  const objectMismatches = source.objects.filter((row) => {
    const other = targetObjects.get(objectKey(row));
    return other && canonicalSerialize(other) !== canonicalSerialize(row);
  }).map((row) => ({ source: row, target: targetObjects.get(objectKey(row)) }));
  const sourceOnlyGrants = source.grants.filter((row) => !targetGrants.has(grantKey(row)));
  const targetOnlyGrants = target.grants.filter((row) => !sourceGrants.has(grantKey(row)));
  const grantMismatches = source.grants.filter((row) => {
    const other = targetGrants.get(grantKey(row));
    return other && canonicalSerialize(other) !== canonicalSerialize(row);
  }).map((row) => ({ source: row, target: targetGrants.get(grantKey(row)) }));
  return {
    sourceOnlyObjects,
    targetOnlyObjects,
    objectMismatches,
    sourceOnlyGrants,
    targetOnlyGrants,
    grantMismatches,
    exact: sourceOnlyObjects.length === 0 && targetOnlyObjects.length === 0 &&
      objectMismatches.length === 0 && sourceOnlyGrants.length === 0 &&
      targetOnlyGrants.length === 0 && grantMismatches.length === 0
  };
}

function assertConvergenceOperation(grant, action) {
  if (!['grant', 'revoke'].includes(action)) {
    throw categoricalError('APPLICATION_ACL_OPERATION_INVALID');
  }
  if (
    !APPLICATION_FACING_ROLES.includes(grant.grantee) ||
    grant.ownerRole !== 'postgres' ||
    grant.grantor !== 'postgres' ||
    grant.grantable !== false ||
    !OBJECT_PRIVILEGES[grant.objectClass]?.includes(grant.privilege)
  ) {
    throw categoricalError(
      action === 'grant'
        ? 'APPLICATION_ACL_SOURCE_ONLY_GRANT_UNREVIEWED'
        : 'APPLICATION_ACL_TARGET_ONLY_GRANT_UNREVIEWED'
    );
  }
  return {
    action,
    ...grant
  };
}

function convergencePayload(manifest) {
  const { manifestDigest: _manifestDigest, ...payload } = manifest;
  return payload;
}

function buildApplicationAclConvergenceManifest({ source, target } = {}) {
  const comparison = compareApplicationAclContracts(source, target);
  if (comparison.sourceOnlyObjects.length > 0) throw categoricalError('APPLICATION_ACL_SOURCE_OBJECT_MISSING');
  if (comparison.targetOnlyObjects.length > 0) throw categoricalError('APPLICATION_ACL_TARGET_OBJECT_UNEXPECTED');
  if (comparison.objectMismatches.length > 0) throw categoricalError('APPLICATION_ACL_OBJECT_VALUE_MISMATCH');
  if (comparison.grantMismatches.length > 0) throw categoricalError('APPLICATION_ACL_GRANT_VALUE_MISMATCH');
  const operations = sortGrants([
    ...comparison.sourceOnlyGrants.map((grant) => assertConvergenceOperation(grant, 'grant')),
    ...comparison.targetOnlyGrants.map((grant) => assertConvergenceOperation(grant, 'revoke'))
  ]);
  const manifest = {
    format: APPLICATION_ACL_CONVERGENCE_FORMAT,
    version: 1,
    canonicalization: APPLICATION_ACL_CANONICALIZATION,
    sourceContractDigest: source.contractDigest,
    targetContractDigest: target.contractDigest,
    sourceObjectDigest: source.objectDigest,
    targetObjectDigest: target.objectDigest,
    sourceGrantCount: source.grants.length,
    targetGrantCount: target.grants.length,
    operationCount: operations.length,
    unknownCount: 0,
    operations
  };
  manifest.operationDigest = canonicalDigest(operations);
  manifest.manifestDigest = canonicalDigest(convergencePayload(manifest));
  return manifest;
}

function verifyApplicationAclConvergenceManifest(manifest) {
  if (
    manifest?.format !== APPLICATION_ACL_CONVERGENCE_FORMAT ||
    manifest?.version !== 1 ||
    manifest?.canonicalization !== APPLICATION_ACL_CANONICALIZATION ||
    !Array.isArray(manifest?.operations) ||
    manifest?.operationCount !== manifest.operations.length ||
    manifest?.unknownCount !== 0
  ) {
    throw categoricalError('APPLICATION_ACL_CONVERGENCE_MANIFEST_INVALID');
  }
  const operations = sortGrants(manifest.operations.map((operation) => {
    if (!['grant', 'revoke'].includes(operation?.action)) {
      throw categoricalError('APPLICATION_ACL_OPERATION_INVALID');
    }
    return assertConvergenceOperation(normalizeGrant(operation), operation.action);
  }));
  if (
    canonicalSerialize(operations) !== canonicalSerialize(manifest.operations) ||
    canonicalDigest(operations) !== manifest.operationDigest ||
    canonicalDigest(convergencePayload(manifest)) !== manifest.manifestDigest
  ) {
    throw categoricalError('APPLICATION_ACL_CONVERGENCE_MANIFEST_DIGEST_MISMATCH');
  }
  return true;
}

function quoteIdentifier(value) {
  return `"${checkedText(value, 'APPLICATION_ACL_IDENTIFIER_INVALID').replaceAll('"', '""')}"`;
}

function safeIdentityArguments(value) {
  const text = checkedOptionalText(value, 'APPLICATION_ACL_SIGNATURE_INVALID');
  if (
    text.length > 8192 || text.includes(';') || text.includes('--') ||
    text.includes('/*') || text.includes('*/') || text.includes("'")
  ) {
    throw categoricalError('APPLICATION_ACL_SIGNATURE_INVALID');
  }
  return text;
}

function renderApplicationAclOperation(operation) {
  const grant = assertConvergenceOperation(normalizeGrant(operation), operation?.action);
  const command = grant.action === 'grant' ? 'GRANT' : 'REVOKE';
  const preposition = grant.action === 'grant' ? 'TO' : 'FROM';
  const grantee = grant.grantee === 'PUBLIC' ? 'PUBLIC' : quoteIdentifier(grant.grantee);
  const schema = quoteIdentifier(grant.schemaName);
  const object = quoteIdentifier(grant.objectName);
  if (grant.objectClass === 'schema') {
    return `${command} ${grant.privilege} ON SCHEMA ${schema} ${preposition} ${grantee};`;
  }
  if (['table', 'view'].includes(grant.objectClass)) {
    return `${command} ${grant.privilege} ON TABLE ${schema}.${object} ${preposition} ${grantee};`;
  }
  if (grant.objectClass === 'sequence') {
    return `${command} ${grant.privilege} ON SEQUENCE ${schema}.${object} ${preposition} ${grantee};`;
  }
  const kind = grant.objectClass === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
  return `${command} ${grant.privilege} ON ${kind} ${schema}.${object}(${safeIdentityArguments(grant.identityArguments)}) ${preposition} ${grantee};`;
}

function renderApplicationAclRevoke(operation) {
  return renderApplicationAclOperation({ ...operation, action: 'revoke' });
}

function applicationAclAugmentationDigest(operations = []) {
  const rows = operations.map((operation) => {
    const grant = normalizeGrant(operation);
    return {
      action: checkedText(operation.action, 'APPLICATION_ACL_OPERATION_INVALID'),
      kind: grant.objectClass,
      schemaName: grant.schemaName,
      objectName: grant.objectName,
      identityArguments: grant.identityArguments,
      ownerRole: grant.ownerRole,
      grantor: grant.grantor,
      grantee: grant.grantee,
      privilege: grant.privilege,
      grantable: grant.grantable
    };
  }).sort((left, right) => canonicalSerialize(left).localeCompare(canonicalSerialize(right), 'en'));
  return canonicalDigest(rows);
}

function sqlJson(value) {
  return JSON.stringify(value).replaceAll("'", "''");
}

function buildApplicationAclConvergenceSql(sourceContract) {
  verifyApplicationAclContract(sourceContract);
  const sourceObjects = sqlJson(sourceContract.objects);
  const sourceGrants = sqlJson(sourceContract.grants);
  return `do $application_acl_convergence$
declare
  v_source_objects jsonb := '${sourceObjects}'::jsonb;
  v_source_grants jsonb := '${sourceGrants}'::jsonb;
  v_target_objects jsonb;
  v_target_grants jsonb;
  v_after_objects jsonb;
  v_after_grants jsonb;
  v_item jsonb;
  v_grantee_sql text;
  v_statement text;
begin
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_target_objects
    from (${APPLICATION_ACL_OBJECTS_SQL}) q;
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_target_grants
    from (${APPLICATION_ACL_GRANTS_SQL}) q;

  if jsonb_array_length(v_source_objects) <> jsonb_array_length(v_target_objects)
     or exists (select 1 from jsonb_array_elements(v_source_objects) s
                 where not v_target_objects @> jsonb_build_array(s))
     or exists (select 1 from jsonb_array_elements(v_target_objects) t
                 where not v_source_objects @> jsonb_build_array(t)) then
    raise exception 'APPLICATION_ACL_OBJECT_CONTRACT_MISMATCH';
  end if;

  for v_item in select value from jsonb_array_elements(v_source_grants) loop
    if not v_target_grants @> jsonb_build_array(v_item) then
      if exists (
        select 1 from jsonb_array_elements(v_target_grants) t
         where t->>'objectClass' = v_item->>'objectClass'
           and t->>'schemaName' = v_item->>'schemaName'
           and t->>'objectName' = v_item->>'objectName'
           and t->>'identityArguments' = v_item->>'identityArguments'
           and t->>'grantee' = v_item->>'grantee'
           and t->>'privilege' = v_item->>'privilege'
      ) then
        raise exception 'APPLICATION_ACL_GRANT_VALUE_MISMATCH';
      end if;
      if (v_item->>'grantee') <> all(array['PUBLIC','anon','authenticated','authenticator','service_role'])
         or v_item->>'ownerRole' <> 'postgres'
         or v_item->>'grantor' <> 'postgres'
         or (v_item->>'grantable')::boolean is not false then
        raise exception 'APPLICATION_ACL_SOURCE_ONLY_GRANT_UNREVIEWED';
      end if;
      if (v_item->>'objectClass' in ('function','procedure') and v_item->>'privilege' <> 'EXECUTE')
         or (v_item->>'objectClass' = 'schema' and v_item->>'privilege' not in ('CREATE','USAGE'))
         or (v_item->>'objectClass' in ('table','view') and v_item->>'privilege' not in ('DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'))
         or (v_item->>'objectClass' = 'sequence' and v_item->>'privilege' not in ('SELECT','UPDATE','USAGE'))
         or v_item->>'objectClass' not in ('schema','table','view','sequence','function','procedure') then
        raise exception 'APPLICATION_ACL_SOURCE_ONLY_PRIVILEGE_UNREVIEWED';
      end if;
      v_grantee_sql := case when v_item->>'grantee' = 'PUBLIC' then 'PUBLIC'
                            else format('%I', v_item->>'grantee') end;
      if v_item->>'objectClass' = 'schema' then
        v_statement := format('GRANT %s ON SCHEMA %I TO %s',
          v_item->>'privilege', v_item->>'schemaName', v_grantee_sql);
      elsif v_item->>'objectClass' in ('table','view') then
        v_statement := format('GRANT %s ON TABLE %I.%I TO %s',
          v_item->>'privilege', v_item->>'schemaName', v_item->>'objectName', v_grantee_sql);
      elsif v_item->>'objectClass' = 'sequence' then
        v_statement := format('GRANT %s ON SEQUENCE %I.%I TO %s',
          v_item->>'privilege', v_item->>'schemaName', v_item->>'objectName', v_grantee_sql);
      else
        if v_item->>'identityArguments' ~ '[[:cntrl:]]'
           or position(';' in v_item->>'identityArguments') > 0
           or position('--' in v_item->>'identityArguments') > 0
           or position('/*' in v_item->>'identityArguments') > 0
           or position('*/' in v_item->>'identityArguments') > 0
           or position(chr(39) in v_item->>'identityArguments') > 0 then
          raise exception 'APPLICATION_ACL_SIGNATURE_INVALID';
        end if;
        v_statement := format('GRANT %s ON %s %I.%I(%s) TO %s',
          v_item->>'privilege', upper(v_item->>'objectClass'),
          v_item->>'schemaName', v_item->>'objectName',
          v_item->>'identityArguments', v_grantee_sql);
      end if;
      execute v_statement;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(v_target_grants) loop
    if v_source_grants @> jsonb_build_array(v_item) then continue; end if;
    if (v_item->>'grantee') <> all(array['PUBLIC','anon','authenticated','authenticator','service_role'])
       or v_item->>'ownerRole' <> 'postgres'
       or v_item->>'grantor' <> 'postgres'
       or (v_item->>'grantable')::boolean is not false then
      raise exception 'APPLICATION_ACL_TARGET_ONLY_GRANT_UNREVIEWED';
    end if;
    if (v_item->>'objectClass' in ('function','procedure') and v_item->>'privilege' <> 'EXECUTE')
       or (v_item->>'objectClass' = 'schema' and v_item->>'privilege' not in ('CREATE','USAGE'))
       or (v_item->>'objectClass' in ('table','view') and v_item->>'privilege' not in ('DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'))
       or (v_item->>'objectClass' = 'sequence' and v_item->>'privilege' not in ('SELECT','UPDATE','USAGE'))
       or v_item->>'objectClass' not in ('schema','table','view','sequence','function','procedure') then
      raise exception 'APPLICATION_ACL_TARGET_ONLY_PRIVILEGE_UNREVIEWED';
    end if;
    v_grantee_sql := case when v_item->>'grantee' = 'PUBLIC' then 'PUBLIC'
                          else format('%I', v_item->>'grantee') end;
    if v_item->>'objectClass' = 'schema' then
      v_statement := format('REVOKE %s ON SCHEMA %I FROM %s',
        v_item->>'privilege', v_item->>'schemaName', v_grantee_sql);
    elsif v_item->>'objectClass' in ('table','view') then
      v_statement := format('REVOKE %s ON TABLE %I.%I FROM %s',
        v_item->>'privilege', v_item->>'schemaName', v_item->>'objectName', v_grantee_sql);
    elsif v_item->>'objectClass' = 'sequence' then
      v_statement := format('REVOKE %s ON SEQUENCE %I.%I FROM %s',
        v_item->>'privilege', v_item->>'schemaName', v_item->>'objectName', v_grantee_sql);
    else
      if v_item->>'identityArguments' ~ '[[:cntrl:]]'
         or position(';' in v_item->>'identityArguments') > 0
         or position('--' in v_item->>'identityArguments') > 0
         or position('/*' in v_item->>'identityArguments') > 0
         or position('*/' in v_item->>'identityArguments') > 0
         or position(chr(39) in v_item->>'identityArguments') > 0 then
        raise exception 'APPLICATION_ACL_SIGNATURE_INVALID';
      end if;
      v_statement := format('REVOKE %s ON %s %I.%I(%s) FROM %s',
        v_item->>'privilege', upper(v_item->>'objectClass'),
        v_item->>'schemaName', v_item->>'objectName',
        v_item->>'identityArguments', v_grantee_sql);
    end if;
    execute v_statement;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_after_objects
    from (${APPLICATION_ACL_OBJECTS_SQL}) q;
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_after_grants
    from (${APPLICATION_ACL_GRANTS_SQL}) q;
  if jsonb_array_length(v_source_objects) <> jsonb_array_length(v_after_objects)
     or exists (select 1 from jsonb_array_elements(v_source_objects) s
                 where not v_after_objects @> jsonb_build_array(s))
     or exists (select 1 from jsonb_array_elements(v_after_objects) t
                 where not v_source_objects @> jsonb_build_array(t)) then
    raise exception 'APPLICATION_ACL_OBJECT_POSTCHECK_MISMATCH';
  end if;
  if jsonb_array_length(v_source_grants) <> jsonb_array_length(v_after_grants)
     or exists (select 1 from jsonb_array_elements(v_source_grants) s
                 where not v_after_grants @> jsonb_build_array(s))
     or exists (select 1 from jsonb_array_elements(v_after_grants) t
                 where not v_source_grants @> jsonb_build_array(t)) then
    raise exception 'APPLICATION_ACL_GRANT_POSTCHECK_MISMATCH';
  end if;
end
$application_acl_convergence$;`;
}

export {
  APPLICATION_ACL_CANONICALIZATION,
  APPLICATION_ACL_CONTRACT_FORMAT,
  APPLICATION_ACL_CONVERGENCE_FORMAT,
  APPLICATION_ACL_GRANTS_SQL,
  APPLICATION_ACL_OBJECTS_SQL,
  APPLICATION_FACING_ROLES,
  TARGET_NATIVE_AUTHENTICATOR_PUBLIC_SCHEMA_USAGE,
  applicationAclAugmentationDigest,
  buildApplicationAclContract,
  buildApplicationAclConvergenceManifest,
  buildApplicationAclConvergenceSql,
  captureApplicationAclContract,
  compareApplicationAclContracts,
  renderApplicationAclOperation,
  renderApplicationAclRevoke,
  verifyApplicationAclContract,
  verifyApplicationAclConvergenceManifest,
  verifyCertifiedManagedAclExceptions
};
