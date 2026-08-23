import crypto from 'node:crypto';
import fs from 'node:fs';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import {
  verifyPrivateArtifactProtection,
  verifyPrivateDirectoryProtection
} from './private-artifacts.mjs';

const RUNTIME_KEY_MAGIC = 'ESRUN001';
const RUNTIME_KEY_BYTES = 32;
const FIXTURE_MANIFEST_FORMAT = 'sandbox-golden-workflow-fixture-v1';
const FIXTURE_FAILURE_FORMAT = 'sandbox-golden-workflow-failure-v1';
const FIXTURE_RECOVERY_FORMAT = 'sandbox-golden-recovery-v1';
const RUNTIME_LINEAGE_FORMAT = 'sandbox-runtime-lineage-v1';
const ID_JOURNAL_FORMAT = 'sandbox-golden-id-journal-v1';
const RECOVERY_PLAN_FORMAT = 'sandbox-runtime-fixture-recovery-plan-v1';
const RECOVERY_ATTEMPT_FORMAT = 'sandbox-runtime-fixture-recovery-attempt-v1';
const RECOVERY_RESULT_FORMAT = 'sandbox-runtime-fixture-recovery-result-v1';
const RECOVERY_OVERRIDE_ATTEMPT_FORMAT = 'sandbox-runtime-fixture-recovery-override-attempt-v1';
const RECOVERY_OVERRIDE_RESULT_FORMAT = 'sandbox-runtime-fixture-recovery-override-result-v1';
const OWNER_GUARD_TABLE = 'app.organization_members';
const OWNER_GUARD_TRIGGER = 'trg_prevent_last_owner_loss';
const OWNER_GUARD_FUNCTION = 'app.prevent_last_owner_loss';
const OWNER_GUARD_ENABLED = 'O';
const OWNER_GUARD_DISABLED = 'D';
const EXPECTED_OWNER_GUARD_TYPE = 27; // ROW + BEFORE + DELETE + UPDATE

function fixtureRecoveryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function asText(value) {
  return String(value ?? '').trim();
}

function asSafeCount(value, code = 'FIXTURE_RECOVERY_COUNT_INVALID') {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw fixtureRecoveryError(code);
  return count;
}

function assertUuid(value, code = 'FIXTURE_RECOVERY_ID_INVALID') {
  const normalized = asText(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw fixtureRecoveryError(code);
  }
  return normalized;
}

function runtimeCanonicalSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(runtimeCanonicalSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${runtimeCanonicalSerialize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function signRuntimePayload(payload, key) {
  if (!Buffer.isBuffer(key) || key.length !== RUNTIME_KEY_BYTES) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_KEY_INVALID');
  }
  return crypto.createHmac('sha256', key).update(runtimeCanonicalSerialize(payload)).digest('hex');
}

function timingSafeTextEqual(left, right) {
  const leftBytes = Buffer.from(asText(left), 'utf8');
  const rightBytes = Buffer.from(asText(right), 'utf8');
  try {
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function readRuntimeKey(keyPath) {
  verifyPrivateArtifactProtection(keyPath);
  const bytes = fs.readFileSync(keyPath);
  try {
    if (
      bytes.length !== RUNTIME_KEY_MAGIC.length + RUNTIME_KEY_BYTES ||
      bytes.subarray(0, RUNTIME_KEY_MAGIC.length).toString('ascii') !== RUNTIME_KEY_MAGIC
    ) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_KEY_INVALID');
    }
    return Buffer.from(bytes.subarray(RUNTIME_KEY_MAGIC.length));
  } finally {
    bytes.fill(0);
  }
}

function readSignedRuntimeRecord(filePath, key, expectedFormat) {
  verifyPrivateArtifactProtection(filePath);
  const bytes = fs.readFileSync(filePath);
  try {
    const record = JSON.parse(bytes.toString('utf8'));
    if (asText(record?.payload?.format) !== expectedFormat) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_RECORD_FORMAT_INVALID');
    }
    const expected = signRuntimePayload(record.payload, key);
    if (!timingSafeTextEqual(expected, record.hmacSha256)) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_RECORD_AUTHENTICATION_FAILED');
    }
    return { payload: record.payload, byteDigest: sha256Bytes(bytes) };
  } catch (error) {
    if (error?.code) throw error;
    throw fixtureRecoveryError('FIXTURE_RECOVERY_RECORD_INVALID');
  } finally {
    bytes.fill(0);
  }
}

function parseConcatenatedJsonObjects(contents) {
  const values = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth < 0) throw fixtureRecoveryError('FIXTURE_RECOVERY_JOURNAL_INVALID');
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(contents.slice(start, index + 1)));
        } catch {
          throw fixtureRecoveryError('FIXTURE_RECOVERY_JOURNAL_INVALID');
        }
        start = -1;
      }
    }
  }
  if (depth !== 0 || inString || start !== -1) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_JOURNAL_INVALID');
  }
  return values;
}

function readAndVerifyIdJournal(journalPath, { runTag, organizationIds }) {
  verifyPrivateArtifactProtection(journalPath);
  const bytes = fs.readFileSync(journalPath);
  try {
    const records = parseConcatenatedJsonObjects(bytes.toString('utf8'));
    const header = records[0];
    const allowedIds = new Set(organizationIds);
    if (
      records.length < 1 ||
      header?.format !== ID_JOURNAL_FORMAT ||
      header?.runTag !== runTag ||
      !Array.isArray(header?.entries)
    ) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_JOURNAL_INVALID');
    }
    let evidenceValueCount = 0;
    for (const record of records.slice(1)) {
      const category = asText(record?.category);
      const entries = record?.value;
      if (
        !/^[A-Z][A-Z0-9_]{2,95}$/.test(category) ||
        !Array.isArray(entries) ||
        entries.length === 0 ||
        entries.length > 128 ||
        entries.some((entry) => {
          const field = asText(entry?.field);
          const value = asText(entry?.value);
          return !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) ||
            !value ||
            value.length > 256 ||
            /[\u0000-\u001f\u007f]/.test(value);
        })
      ) {
        throw fixtureRecoveryError('FIXTURE_RECOVERY_JOURNAL_SCOPE_INVALID');
      }
      if (
        ['AUTH_CONTEXT', 'AUTH_ORGANIZATION'].includes(category) &&
        entries.some((entry) => entry.field !== 'orgId' || !allowedIds.has(entry.value))
      ) {
        throw fixtureRecoveryError('FIXTURE_RECOVERY_JOURNAL_SCOPE_INVALID');
      }
      evidenceValueCount += entries.length;
    }
    return {
      recordCount: records.length,
      evidenceValueCount,
      cleanupTargetCount: 0,
      byteDigest: sha256Bytes(bytes)
    };
  } finally {
    bytes.fill(0);
  }
}

function assertUniqueIds(values, expectedCount, code) {
  if (!Array.isArray(values) || values.length !== expectedCount) throw fixtureRecoveryError(code);
  const normalized = values.map((value) => assertUuid(value, code));
  if (new Set(normalized).size !== normalized.length) throw fixtureRecoveryError(code);
  return normalized;
}

function readRuntimeRecoveryAuthority({
  directoryPath,
  keyPath,
  manifestPath,
  failurePath,
  recoveryPath,
  lineagePath,
  journalPath,
  expectedProjectRef,
  expectedApplicationCommit
}) {
  verifyPrivateDirectoryProtection(directoryPath);
  const key = readRuntimeKey(keyPath);
  try {
    const manifest = readSignedRuntimeRecord(manifestPath, key, FIXTURE_MANIFEST_FORMAT);
    const failure = readSignedRuntimeRecord(failurePath, key, FIXTURE_FAILURE_FORMAT);
    const recovery = readSignedRuntimeRecord(recoveryPath, key, FIXTURE_RECOVERY_FORMAT);
    const lineage = readSignedRuntimeRecord(lineagePath, key, RUNTIME_LINEAGE_FORMAT);
    const projectRef = asText(expectedProjectRef).toLowerCase();
    const applicationCommit = asText(expectedApplicationCommit).toLowerCase();
    const organizationIds = assertUniqueIds(
      manifest.payload?.cleanupAuthority?.organizationIds,
      2,
      'FIXTURE_RECOVERY_ORGANIZATION_AUTHORITY_INVALID'
    );
    const temporaryUserId = assertUuid(
      manifest.payload?.cleanupAuthority?.temporaryUserId,
      'FIXTURE_RECOVERY_TEMPORARY_USER_INVALID'
    );
    const permanentSmokeUserId = assertUuid(
      manifest.payload?.permanentSmokeUserId,
      'FIXTURE_RECOVERY_SMOKE_USER_INVALID'
    );
    if (
      !/^[a-z0-9]{10,40}$/.test(projectRef) ||
      manifest.payload.projectRef !== projectRef ||
      recovery.payload.projectRef !== projectRef ||
      lineage.payload.projectRef !== projectRef ||
      !/^[0-9a-f]{40}$/.test(applicationCommit) ||
      lineage.payload.applicationCommit !== applicationCommit ||
      manifest.payload.temporaryIdentity?.userId !== temporaryUserId ||
      temporaryUserId === permanentSmokeUserId ||
      asText(manifest.payload.runTag).length < 16 ||
      asSafeCount(recovery.payload.fixtureRows) === 0 ||
      asSafeCount(recovery.payload.cleanupCommits) !== 0 ||
      recovery.payload.nonfixtureEqual !== true ||
      lineage.payload.certification?.recoveryRequired !== true
    ) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_AUTHORITY_INVALID');
    }
    const journal = readAndVerifyIdJournal(journalPath, {
      runTag: manifest.payload.runTag,
      organizationIds
    });
    return {
      key: Buffer.from(key),
      manifest: manifest.payload,
      failure: failure.payload,
      recovery: recovery.payload,
      lineage: lineage.payload,
      organizationIds,
      temporaryUserId,
      permanentSmokeUserId,
      manifestByteDigest: manifest.byteDigest,
      failureByteDigest: failure.byteDigest,
      recoveryByteDigest: recovery.byteDigest,
      lineageByteDigest: lineage.byteDigest,
      journal
    };
  } finally {
    key.fill(0);
  }
}

function assertSafeIdentifier(value, code = 'FIXTURE_RECOVERY_IDENTIFIER_INVALID') {
  const normalized = asText(value);
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) throw fixtureRecoveryError(code);
  return normalized;
}

function fixturePredicate(table, columns, parameter = '$1') {
  if (table === 'organizations') return { sql: `t.id = any(${parameter}::uuid[])`, usesOrganizations: true };
  if (columns.includes('org_id')) return { sql: `t.org_id = any(${parameter}::uuid[])`, usesOrganizations: true };
  if (table === 'user_organization_preferences' && columns.includes('selected_org_id')) {
    return { sql: `t.selected_org_id = any(${parameter}::uuid[])`, usesOrganizations: true };
  }
  return { sql: 'false', usesOrganizations: false };
}

async function applicationTables(client) {
  const result = await client.query(`
    select tables.table_name,
           array_agg(columns.column_name::text order by columns.ordinal_position)
             filter (where columns.column_name is not null) as columns
      from information_schema.tables tables
      left join information_schema.columns columns
        on columns.table_schema = tables.table_schema
       and columns.table_name = tables.table_name
     where tables.table_schema = 'app'
       and tables.table_type = 'BASE TABLE'
     group by tables.table_name
     order by tables.table_name
  `);
  return result.rows.map((row) => ({
    table: assertSafeIdentifier(row.table_name),
    columns: (row.columns || []).map((column) => assertSafeIdentifier(column))
  }));
}

async function captureFixtureState(client, { manifest, organizationIds }) {
  const expected = new Map((manifest?.prefixture?.projections || []).map((entry) => [entry.table, entry]));
  if (
    manifest?.prefixture?.format !== 'sandbox-golden-prefixture-v1' ||
    !Number.isSafeInteger(manifest?.prefixture?.tableCount) ||
    expected.size !== manifest.prefixture.tableCount
  ) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_BASELINE_INVALID');
  }
  const tables = await applicationTables(client);
  if (tables.length !== expected.size) throw fixtureRecoveryError('FIXTURE_RECOVERY_TABLE_SCOPE_MISMATCH');
  const fixtureCounts = {};
  const projections = [];
  for (const { table, columns } of tables) {
    const baseline = expected.get(table);
    if (!baseline) throw fixtureRecoveryError('FIXTURE_RECOVERY_TABLE_SCOPE_MISMATCH');
    const predicate = fixturePredicate(table, columns);
    const values = predicate.usesOrganizations ? [organizationIds] : [];
    const fixture = await client.query(
      `select count(*)::integer as count from app.${table} t where ${predicate.sql}`,
      values
    );
    const count = asSafeCount(fixture.rows[0]?.count);
    if (count > 0) fixtureCounts[table] = count;
    const rows = await client.query(
      `select to_jsonb(t) as row from app.${table} t where (${predicate.sql}) is not true order by to_jsonb(t)::text`,
      values
    );
    const rowDigest = crypto.createHash('sha256');
    for (const row of rows.rows) rowDigest.update(`${runtimeCanonicalSerialize(row.row)}\n`);
    projections.push({
      table,
      count: rows.rowCount,
      digest: `sha256:${rowDigest.digest('hex')}`
    });
  }
  const fixtureRows = Object.values(fixtureCounts).reduce((total, count) => total + count, 0);
  return {
    fixtureCounts,
    fixtureRows,
    tableCount: projections.length,
    projections,
    projectionSetDigest: canonicalDigest(projections),
    baselineEqual: runtimeCanonicalSerialize(projections) === runtimeCanonicalSerialize(manifest.prefixture.projections)
  };
}

async function captureAuthState(client, { temporaryUserId, permanentSmokeUserId }) {
  const result = await client.query(
    `select count(*)::integer as all_users,
            count(*) filter (where id = $1::uuid)::integer as temporary_exact,
            count(*) filter (where id = $2::uuid)::integer as smoke_exact,
            count(*) filter (
              where coalesce((raw_user_meta_data->>'x_np_target_native_smoke')::boolean, false) is true
            )::integer as smoke_users,
            count(*) filter (
              where coalesce((raw_user_meta_data->>'x_np_target_native_temporary')::boolean, false) is true
            )::integer as temporary_users,
            count(*) filter (
              where coalesce((raw_user_meta_data->>'x_np_target_native_smoke')::boolean, false) is not true
                and coalesce((raw_user_meta_data->>'x_np_target_native_temporary')::boolean, false) is not true
            )::integer as copied_users,
            count(*) filter (
              where coalesce((raw_user_meta_data->>'x_np_target_native_smoke')::boolean, false) is not true
                and coalesce((raw_user_meta_data->>'x_np_target_native_temporary')::boolean, false) is not true
                and (encrypted_password <> '!x-np-disabled-v1!' or banned_until <> 'infinity'::timestamptz)
            )::integer as usable_copied_credentials
       from auth.users`,
    [temporaryUserId, permanentSmokeUserId]
  );
  const row = result.rows[0] || {};
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, asSafeCount(value, 'FIXTURE_RECOVERY_AUTH_COUNT_INVALID')])
  );
}

async function captureIdentityReferences(client, { temporaryUserId, organizationIds }) {
  const tables = await applicationTables(client);
  const referenceColumns = new Set([
    'user_id',
    'admin_user_id',
    'updated_by_user_id',
    'created_by_user_id',
    'actor_user_id',
    'requested_by_user_id'
  ]);
  let exactReferences = 0;
  let nonfixtureReferences = 0;
  for (const { table, columns } of tables) {
    const predicate = fixturePredicate(table, columns, '$2');
    for (const column of columns.filter((entry) => referenceColumns.has(entry))) {
      const result = await client.query(
        `select count(*)::integer as exact_count,
                count(*) filter (where (${predicate.sql}) is not true)::integer as nonfixture_count
           from app.${table} t
          where t.${column} = $1::uuid`,
        predicate.usesOrganizations ? [temporaryUserId, organizationIds] : [temporaryUserId]
      );
      exactReferences += asSafeCount(result.rows[0]?.exact_count);
      nonfixtureReferences += asSafeCount(result.rows[0]?.nonfixture_count);
    }
  }
  return { exactReferences, nonfixtureReferences };
}

async function captureSideEffectState(client) {
  const availability = await client.query(`
    select to_regclass('net.http_request_queue') is not null as net_queue_available,
           to_regclass('cron.job') is not null as cron_available
  `);
  const state = availability.rows[0] || {};
  const netQueue = state.net_queue_available
    ? asSafeCount((await client.query('select count(*)::integer as count from net.http_request_queue')).rows[0]?.count)
    : 0;
  const cronJobs = state.cron_available
    ? asSafeCount((await client.query('select count(*)::integer as count from cron.job')).rows[0]?.count)
    : 0;
  return {
    netQueue,
    cronJobs,
    netQueueAvailable: state.net_queue_available === true,
    cronAvailable: state.cron_available === true
  };
}

function extractOwnerGuardFunctionSource(migrationSql) {
  const source = String(migrationSql || '').replace(/\r\n/g, '\n');
  const match = source.match(
    /create or replace function app\.prevent_last_owner_loss\(\)\s*[\s\S]*?as \$\$\n([\s\S]*?)\n\$\$;/i
  );
  if (!match) throw fixtureRecoveryError('FIXTURE_RECOVERY_OWNER_GUARD_SOURCE_MISSING');
  return match[1].trim();
}

async function captureOwnerGuard(client, expectedFunctionSource, { expectedEnabled = OWNER_GUARD_ENABLED } = {}) {
  const result = await client.query(`
    select trigger.tgenabled,
           trigger.tgtype::integer as trigger_type,
           pg_get_triggerdef(trigger.oid, false) as trigger_definition,
           function.prosrc as function_source,
           function.prosecdef as security_definer,
           function.proconfig,
           function_namespace.nspname as function_schema,
           function.proname as function_name,
           pg_get_function_identity_arguments(function.oid) as identity_arguments,
           owner.rolname as owner_role
      from pg_catalog.pg_trigger trigger
      join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace relation_namespace on relation_namespace.oid = relation.relnamespace
      join pg_catalog.pg_proc function on function.oid = trigger.tgfoid
      join pg_catalog.pg_namespace function_namespace on function_namespace.oid = function.pronamespace
      join pg_catalog.pg_roles owner on owner.oid = function.proowner
     where relation_namespace.nspname = 'app'
       and relation.relname = 'organization_members'
       and trigger.tgname = 'trg_prevent_last_owner_loss'
       and not trigger.tgisinternal
  `);
  if (result.rowCount !== 1) throw fixtureRecoveryError('FIXTURE_RECOVERY_OWNER_GUARD_SHAPE_INVALID');
  const row = result.rows[0];
  const normalizedSource = asText(row.function_source).replace(/\r\n/g, '\n');
  if (
    row.tgenabled !== expectedEnabled ||
    Number(row.trigger_type) !== EXPECTED_OWNER_GUARD_TYPE ||
    row.security_definer !== true ||
    row.function_schema !== 'app' ||
    row.function_name !== 'prevent_last_owner_loss' ||
    asText(row.identity_arguments) !== '' ||
    runtimeCanonicalSerialize(row.proconfig) !== runtimeCanonicalSerialize(['search_path=public, app, app_api']) ||
    normalizedSource !== asText(expectedFunctionSource)
  ) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_OWNER_GUARD_CONTRACT_MISMATCH');
  }
  return {
    table: OWNER_GUARD_TABLE,
    trigger: OWNER_GUARD_TRIGGER,
    function: OWNER_GUARD_FUNCTION,
    enabled: row.tgenabled,
    triggerType: Number(row.trigger_type),
    triggerDefinitionDigest: canonicalDigest(row.trigger_definition),
    functionSourceDigest: canonicalDigest(normalizedSource),
    functionConfigDigest: canonicalDigest(row.proconfig),
    ownerRoleDigest: canonicalDigest(row.owner_role),
    securityDefiner: true,
    sourceMatches: true
  };
}

async function captureOwnerInvariant(client, excludedOrganizationIds = []) {
  const result = await client.query(
    `select count(*)::integer as violations
       from app.organizations organization
      where not (organization.id = any($1::uuid[]))
        and not exists (
          select 1
            from app.organization_members membership
           where membership.org_id = organization.id
             and membership.role = 'owner'
             and membership.status = 'active'
        )`,
    [excludedOrganizationIds]
  );
  return asSafeCount(result.rows[0]?.violations);
}

async function rows(client, sql, values = []) {
  return (await client.query(sql, values)).rows;
}

async function captureProtectionFingerprint(client) {
  const columns = await rows(client, `
    select table_name, ordinal_position, column_name, udt_schema, udt_name, is_nullable,
           column_default, is_generated, generation_expression
      from information_schema.columns
     where table_schema = 'app'
     order by table_name, ordinal_position
  `);
  const constraints = await rows(client, `
    select relation.relname as table_name, constraint_row.conname,
           constraint_row.contype, pg_get_constraintdef(constraint_row.oid, true) as definition
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'app'
     order by relation.relname, constraint_row.conname
  `);
  const indexes = await rows(client, `
    select tablename as table_name, indexname as index_name, indexdef as definition
      from pg_catalog.pg_indexes
     where schemaname = 'app'
     order by tablename, indexname
  `);
  const routines = await rows(client, `
    select namespace.nspname as schema_name, function.proname,
           pg_get_function_identity_arguments(function.oid) as identity_arguments,
           pg_get_functiondef(function.oid) as definition,
           owner.rolname as owner_role
      from pg_catalog.pg_proc function
      join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
      join pg_catalog.pg_roles owner on owner.oid = function.proowner
     where namespace.nspname = any(array['app','app_api'])
        or (namespace.nspname = 'public' and function.proname like 'api_%')
     order by namespace.nspname, function.proname, pg_get_function_identity_arguments(function.oid)
  `);
  const triggers = await rows(client, `
    select relation.relname as table_name, trigger.tgname as trigger_name,
           trigger.tgenabled, pg_get_triggerdef(trigger.oid, false) as definition
      from pg_catalog.pg_trigger trigger
      join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'app' and not trigger.tgisinternal
     order by relation.relname, trigger.tgname
  `);
  const policies = await rows(client, `
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      from pg_catalog.pg_policies
     where schemaname = 'app'
     order by tablename, policyname
  `);
  const applicationAcls = await rows(client, `
    with relation_acl as (
      select namespace.nspname as schema_name, 'relation'::text as object_type,
             class.relname as object_name, ''::text as identity_arguments,
             coalesce(grantee.rolname, 'PUBLIC') as grantee,
             acl.privilege_type, acl.is_grantable
        from pg_catalog.pg_class class
        join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
        cross join lateral pg_catalog.aclexplode(class.relacl) acl
        left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
       where namespace.nspname = any(array['app','app_api'])
    ), routine_acl as (
      select namespace.nspname as schema_name, 'routine'::text as object_type,
             function.proname as object_name,
             pg_get_function_identity_arguments(function.oid) as identity_arguments,
             coalesce(grantee.rolname, 'PUBLIC') as grantee,
             acl.privilege_type, acl.is_grantable
        from pg_catalog.pg_proc function
        join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
        cross join lateral pg_catalog.aclexplode(function.proacl) acl
        left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
       where namespace.nspname = any(array['app','app_api'])
          or (namespace.nspname = 'public' and function.proname like 'api_%')
    )
    select * from relation_acl
    union all
    select * from routine_acl
    order by schema_name, object_type, object_name, identity_arguments, grantee, privilege_type, is_grantable
  `);
  const schemaAcls = await rows(client, `
    select namespace.nspname as schema_name, owner.rolname as owner_role,
           coalesce(grantee.rolname, 'PUBLIC') as grantee,
           acl.privilege_type, acl.is_grantable
      from pg_catalog.pg_namespace namespace
      join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
      cross join lateral pg_catalog.aclexplode(
        coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
      ) acl
      left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
     where namespace.nspname = any(array[
       'app','app_api','public','auth','storage','realtime','vault','graphql','graphql_public','extensions'
     ])
     order by schema_name, grantee, privilege_type, is_grantable
  `);
  const defaultAcls = await rows(client, `
    select owner.rolname as owner_role, coalesce(namespace.nspname, '') as schema_name,
           defaults.defaclobjtype as object_type, coalesce(grantee.rolname, 'PUBLIC') as grantee,
           acl.privilege_type, acl.is_grantable
      from pg_catalog.pg_default_acl defaults
      join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
      left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) acl
      left join pg_catalog.pg_roles grantee on grantee.oid = nullif(acl.grantee, 0)
     order by owner_role, schema_name, object_type, grantee, privilege_type, is_grantable
  `);
  const managedCatalog = await rows(client, `
    select namespace.nspname as schema_name, class.relname as object_name,
           class.relkind, owner.rolname as owner_role
      from pg_catalog.pg_class class
      join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
      join pg_catalog.pg_roles owner on owner.oid = class.relowner
     where namespace.nspname = any(array['auth','storage','realtime','vault','graphql','graphql_public','extensions'])
     order by namespace.nspname, class.relkind, class.relname
  `);
  const managedRoutines = await rows(client, `
    select namespace.nspname as schema_name, function.proname,
           pg_get_function_identity_arguments(function.oid) as identity_arguments,
           owner.rolname as owner_role
      from pg_catalog.pg_proc function
      join pg_catalog.pg_namespace namespace on namespace.oid = function.pronamespace
      join pg_catalog.pg_roles owner on owner.oid = function.proowner
     where namespace.nspname = any(array['auth','storage','realtime','vault','graphql','graphql_public','extensions'])
     order by namespace.nspname, function.proname, pg_get_function_identity_arguments(function.oid)
  `);
  const migrationRelation = await client.query(
    `select to_regclass('supabase_migrations.schema_migrations') is not null as available`
  );
  const migrations = migrationRelation.rows[0]?.available
    ? await rows(client, `select version, name from supabase_migrations.schema_migrations order by version`)
    : [];
  const parts = {
    applicationSchema: { columns, constraints, indexes, routines, triggers },
    policies,
    applicationAcls,
    schemaAcls,
    defaultAcls,
    managedPlane: { catalog: managedCatalog, routines: managedRoutines },
    migrations
  };
  return Object.fromEntries(
    Object.entries(parts).map(([key, value]) => {
      const count = Array.isArray(value)
        ? value.length
        : Object.values(value).reduce(
            (total, entries) => total + (Array.isArray(entries) ? entries.length : 0),
            0
          );
      return [key, { count, digest: canonicalDigest(value) }];
    })
  );
}

function assertFixtureStateAgainstAuthority(fixtureState, authority) {
  if (
    fixtureState.baselineEqual !== true ||
    fixtureState.tableCount !== authority.manifest.prefixture.tableCount ||
    fixtureState.fixtureRows !== asSafeCount(authority.recovery.fixtureRows) ||
    Object.keys(fixtureState.fixtureCounts).length === 0
  ) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_FIXTURE_STATE_MISMATCH');
  }
}

function assertAuthStateBefore(authState, authority) {
  const baseline = authority.manifest.prefixture.auth || {};
  if (
    authState.temporary_exact !== 1 ||
    authState.smoke_exact !== 1 ||
    authState.smoke_users !== asSafeCount(baseline.smokeUsers) ||
    authState.temporary_users !== 1 ||
    authState.copied_users !== asSafeCount(baseline.copiedUsers) ||
    authState.usable_copied_credentials !== asSafeCount(baseline.usableCopiedCredentials) ||
    authState.all_users !== asSafeCount(baseline.allUsers) + 1
  ) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_AUTH_STATE_MISMATCH');
  }
}

function assertSideEffectsEqual(sideEffects, manifest) {
  const baseline = manifest.prefixture.sideEffects || {};
  if (runtimeCanonicalSerialize(sideEffects) !== runtimeCanonicalSerialize(baseline)) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_SIDE_EFFECT_STATE_MISMATCH');
  }
}

function buildFixtureRecoveryPlan({
  authority,
  fixtureState,
  authState,
  identityReferences,
  sideEffects,
  ownerGuard,
  protection,
  ownerInvariantViolations,
  expectedApplicationCommit,
  createdAt = new Date().toISOString()
}) {
  assertFixtureStateAgainstAuthority(fixtureState, authority);
  assertAuthStateBefore(authState, authority);
  assertSideEffectsEqual(sideEffects, authority.manifest);
  if (
    identityReferences.nonfixtureReferences !== 0 ||
    ownerGuard.enabled !== OWNER_GUARD_ENABLED ||
    ownerGuard.sourceMatches !== true ||
    ownerInvariantViolations !== 0
  ) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_PRECONDITION_FAILED');
  }
  return {
    format: RECOVERY_PLAN_FORMAT,
    projectRef: authority.manifest.projectRef,
    runTag: authority.manifest.runTag,
    applicationCommit: asText(expectedApplicationCommit).toLowerCase(),
    sourceAuthority: {
      manifestDigest: authority.manifestByteDigest,
      failureDigest: authority.failureByteDigest,
      recoveryDigest: authority.recoveryByteDigest,
      lineageDigest: authority.lineageByteDigest,
      journalDigest: authority.journal.byteDigest,
      journalRecords: authority.journal.recordCount
    },
    expected: {
      fixtureCounts: fixtureState.fixtureCounts,
      fixtureRows: fixtureState.fixtureRows,
      applicationTables: fixtureState.tableCount,
      baselineProjectionSetDigest: authority.manifest.prefixture.projectionSetDigest,
      auth: authState,
      identityReferences,
      sideEffects,
      ownerGuard,
      protection,
      survivingOwnerViolations: 0
    },
    cleanup: {
      organizationRootCount: authority.organizationIds.length,
      temporaryAuthUserCount: 1,
      exactManifestRootsOnly: true,
      oneSerializableTransaction: true,
      ownerGuardSuspension: OWNER_GUARD_TRIGGER
    },
    createdAt
  };
}

function assertPlanMatchesAuthority(plan, authority, expectedApplicationCommit) {
  if (
    plan?.format !== RECOVERY_PLAN_FORMAT ||
    plan?.projectRef !== authority.manifest.projectRef ||
    plan?.runTag !== authority.manifest.runTag ||
    plan?.applicationCommit !== asText(expectedApplicationCommit).toLowerCase() ||
    plan?.sourceAuthority?.manifestDigest !== authority.manifestByteDigest ||
    plan?.sourceAuthority?.failureDigest !== authority.failureByteDigest ||
    plan?.sourceAuthority?.recoveryDigest !== authority.recoveryByteDigest ||
    plan?.sourceAuthority?.lineageDigest !== authority.lineageByteDigest ||
    plan?.sourceAuthority?.journalDigest !== authority.journal.byteDigest ||
    plan?.cleanup?.organizationRootCount !== authority.organizationIds.length ||
    plan?.cleanup?.exactManifestRootsOnly !== true ||
    plan?.cleanup?.oneSerializableTransaction !== true ||
    plan?.cleanup?.ownerGuardSuspension !== OWNER_GUARD_TRIGGER
  ) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_PLAN_AUTHORITY_MISMATCH');
  }
  return true;
}

function assertPlanMatchesCurrentState(plan, { fixtureState, authState, identityReferences, sideEffects, ownerGuard, protection, ownerInvariantViolations }) {
  if (
    runtimeCanonicalSerialize(plan.expected.fixtureCounts) !== runtimeCanonicalSerialize(fixtureState.fixtureCounts) ||
    plan.expected.fixtureRows !== fixtureState.fixtureRows ||
    fixtureState.baselineEqual !== true ||
    runtimeCanonicalSerialize(plan.expected.auth) !== runtimeCanonicalSerialize(authState) ||
    runtimeCanonicalSerialize(plan.expected.identityReferences) !== runtimeCanonicalSerialize(identityReferences) ||
    runtimeCanonicalSerialize(plan.expected.sideEffects) !== runtimeCanonicalSerialize(sideEffects) ||
    runtimeCanonicalSerialize(plan.expected.ownerGuard) !== runtimeCanonicalSerialize(ownerGuard) ||
    runtimeCanonicalSerialize(plan.expected.protection) !== runtimeCanonicalSerialize(protection) ||
    ownerInvariantViolations !== 0
  ) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_PLAN_STATE_MISMATCH');
  }
}

async function captureRecoveryPreconditions(client, authority, expectedFunctionSource) {
  const fixtureState = await captureFixtureState(client, authority);
  const authState = await captureAuthState(client, authority);
  const identityReferences = await captureIdentityReferences(client, authority);
  const sideEffects = await captureSideEffectState(client);
  const ownerGuard = await captureOwnerGuard(client, expectedFunctionSource);
  const protection = await captureProtectionFingerprint(client);
  const ownerInvariantViolations = await captureOwnerInvariant(client, authority.organizationIds);
  return {
    fixtureState,
    authState,
    identityReferences,
    sideEffects,
    ownerGuard,
    protection,
    ownerInvariantViolations
  };
}

async function deleteFilmOrderHistoryForRecovery(client, authority, plan) {
  const expectedLinks = asSafeCount(
    plan?.expected?.fixtureCounts?.film_order_box_links,
    'FIXTURE_RECOVERY_FILM_ORDER_LINK_BUDGET_INVALID'
  );
  const expectedOrders = asSafeCount(
    plan?.expected?.fixtureCounts?.film_orders,
    'FIXTURE_RECOVERY_FILM_ORDER_BUDGET_INVALID'
  );
  const expectedEvents = asSafeCount(
    plan?.expected?.fixtureCounts?.film_order_events,
    'FIXTURE_RECOVERY_FILM_ORDER_EVENT_BUDGET_INVALID'
  );
  if (expectedLinks < 1 || expectedOrders < 1) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_FILM_ORDER_HISTORY_NOT_APPLICABLE');
  }

  const links = await client.query(
    'delete from app.film_order_box_links where org_id = any($1::uuid[])',
    [authority.organizationIds]
  );
  if (links.rowCount !== expectedLinks) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_FILM_ORDER_LINK_DELETE_COUNT_MISMATCH');
  }
  const orders = await client.query(
    'delete from app.film_orders where org_id = any($1::uuid[])',
    [authority.organizationIds]
  );
  if (orders.rowCount !== expectedOrders) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_FILM_ORDER_DELETE_COUNT_MISMATCH');
  }
  const events = await client.query(
    'delete from app.film_order_events where org_id = any($1::uuid[])',
    [authority.organizationIds]
  );
  const expectedGeneratedEvents = expectedLinks + expectedOrders;
  if (events.rowCount !== expectedEvents + expectedGeneratedEvents) {
    throw fixtureRecoveryError('FIXTURE_RECOVERY_FILM_ORDER_EVENT_DELETE_COUNT_MISMATCH');
  }
  return {
    linksDeleted: links.rowCount,
    ordersDeleted: orders.rowCount,
    eventsDeleted: events.rowCount,
    generatedEventsDeleted: expectedGeneratedEvents
  };
}

async function executeFixtureRecoveryTransaction({
  client,
  authority,
  plan,
  expectedFunctionSource,
  recoveryMode = 'ordinary'
}) {
  let transactionStarted = false;
  let commitStarted = false;
  let committed = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    transactionStarted = true;
    await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [authority.manifest.runTag]);
    const before = await captureRecoveryPreconditions(client, authority, expectedFunctionSource);
    assertPlanMatchesCurrentState(plan, before);

    await client.query(
      'ALTER TABLE app.organization_members DISABLE TRIGGER trg_prevent_last_owner_loss'
    );
    const disabledGuard = await captureOwnerGuard(client, expectedFunctionSource, {
      expectedEnabled: OWNER_GUARD_DISABLED
    });
    if (
      disabledGuard.triggerDefinitionDigest !== before.ownerGuard.triggerDefinitionDigest ||
      disabledGuard.functionSourceDigest !== before.ownerGuard.functionSourceDigest ||
      disabledGuard.functionConfigDigest !== before.ownerGuard.functionConfigDigest ||
      disabledGuard.ownerRoleDigest !== before.ownerGuard.ownerRoleDigest
    ) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_OWNER_GUARD_DISABLE_DRIFT');
    }

    let recoveryHistory = null;
    if (recoveryMode === 'film-order-event-trigger-fk') {
      recoveryHistory = await deleteFilmOrderHistoryForRecovery(client, authority, plan);
    } else if (recoveryMode !== 'ordinary') {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_MODE_INVALID');
    }

    const deleted = await client.query(
      'delete from app.organizations where id = any($1::uuid[])',
      [authority.organizationIds]
    );
    if (deleted.rowCount !== authority.organizationIds.length) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_ROOT_DELETE_COUNT_MISMATCH');
    }

    const afterDelete = await captureFixtureState(client, authority);
    if (afterDelete.fixtureRows !== 0 || afterDelete.baselineEqual !== true) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_DATABASE_AFTER_STATE_MISMATCH');
    }
    const identityReferences = await captureIdentityReferences(client, authority);
    if (identityReferences.exactReferences !== 0 || identityReferences.nonfixtureReferences !== 0) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_IDENTITY_REFERENCE_RESIDUE');
    }
    const sideEffects = await captureSideEffectState(client);
    assertSideEffectsEqual(sideEffects, authority.manifest);

    await client.query(
      'ALTER TABLE app.organization_members ENABLE TRIGGER trg_prevent_last_owner_loss'
    );
    const restoredGuard = await captureOwnerGuard(client, expectedFunctionSource);
    if (runtimeCanonicalSerialize(restoredGuard) !== runtimeCanonicalSerialize(before.ownerGuard)) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_OWNER_GUARD_RESTORE_MISMATCH');
    }
    if ((await captureOwnerInvariant(client, []) ) !== 0) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_SURVIVING_OWNER_INVARIANT_FAILED');
    }
    const protection = await captureProtectionFingerprint(client);
    if (runtimeCanonicalSerialize(protection) !== runtimeCanonicalSerialize(before.protection)) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_PROTECTED_STATE_DRIFT');
    }

    commitStarted = true;
    await client.query('COMMIT');
    committed = true;
    return {
      committed: true,
      deletedOrganizationRoots: deleted.rowCount,
      fixtureRowsDeleted: before.fixtureState.fixtureRows,
      fixtureCountsDeleted: before.fixtureState.fixtureCounts,
      applicationTablesEqual: afterDelete.tableCount,
      triggerRestored: true,
      protectedStateEqual: true,
      recoveryHistory
    };
  } catch (error) {
    if (transactionStarted && !commitStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        throw fixtureRecoveryError('FIXTURE_RECOVERY_ROLLBACK_UNPROVEN');
      }
    }
    if (commitStarted && !committed) {
      throw fixtureRecoveryError('FIXTURE_RECOVERY_COMMIT_OUTCOME_AMBIGUOUS');
    }
    throw error;
  }
}

function buildSignedRuntimeRecord(payload, key) {
  return { payload, hmacSha256: signRuntimePayload(payload, key) };
}

function buildRecoveryAttempt(plan, { startedAt = new Date().toISOString() } = {}) {
  return {
    format: RECOVERY_ATTEMPT_FORMAT,
    projectRef: plan.projectRef,
    runTag: plan.runTag,
    planDigest: canonicalDigest(plan),
    oneShot: true,
    startedAt
  };
}

function buildRecoveryResult(plan, result, { completedAt = new Date().toISOString() } = {}) {
  return {
    format: RECOVERY_RESULT_FORMAT,
    projectRef: plan.projectRef,
    runTag: plan.runTag,
    planDigest: canonicalDigest(plan),
    ...result,
    completedAt
  };
}

export {
  FIXTURE_FAILURE_FORMAT,
  FIXTURE_MANIFEST_FORMAT,
  FIXTURE_RECOVERY_FORMAT,
  ID_JOURNAL_FORMAT,
  OWNER_GUARD_ENABLED,
  OWNER_GUARD_TRIGGER,
  RECOVERY_ATTEMPT_FORMAT,
  RECOVERY_OVERRIDE_ATTEMPT_FORMAT,
  RECOVERY_OVERRIDE_RESULT_FORMAT,
  RECOVERY_PLAN_FORMAT,
  RECOVERY_RESULT_FORMAT,
  RUNTIME_LINEAGE_FORMAT,
  assertAuthStateBefore,
  assertFixtureStateAgainstAuthority,
  assertPlanMatchesAuthority,
  buildFixtureRecoveryPlan,
  buildRecoveryAttempt,
  buildRecoveryResult,
  buildSignedRuntimeRecord,
  captureAuthState,
  captureFixtureState,
  captureIdentityReferences,
  captureOwnerGuard,
  captureOwnerInvariant,
  captureProtectionFingerprint,
  captureRecoveryPreconditions,
  captureSideEffectState,
  deleteFilmOrderHistoryForRecovery,
  executeFixtureRecoveryTransaction,
  extractOwnerGuardFunctionSource,
  fixturePredicate,
  readRuntimeRecoveryAuthority,
  readSignedRuntimeRecord,
  runtimeCanonicalSerialize,
  sha256Bytes,
  signRuntimePayload
};
