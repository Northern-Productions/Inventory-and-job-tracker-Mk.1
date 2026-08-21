import crypto from 'node:crypto';

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import {
  AUTH_PURGE_ORDER,
  AUTH_QUARANTINE_VERSION,
  CURRENT_AUTH_TABLES,
  REQUIRED_AUTH_COLUMNS
} from './constants.mjs';
import { buildMutationTargetReport, PROD_PROJECT_REF } from '../target-env-guards.mjs';

const QUARANTINED_EMAIL_SQL =
  "'np-' || substr(encode(extensions.digest(id::text || ':x-np:v1', 'sha256'), 'hex'), 1, 40) || '@users.invalid'";
const DISPOSABLE_DATABASE_PATTERN = /^x_rehearsal_(?:dev|sandbox)_[a-z0-9_]{1,48}$/;

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function existingCategoricalCode(error) {
  const code = String(error?.code || error?.message || '');
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : '';
}

function safeSqlState(error) {
  const code = String(error?.code || '');
  return /^[0-9A-Z]{5}$/.test(code) ? code : '';
}

function safeCount(value, label) {
  const count = Number(value || 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${label} is invalid.`);
  return count;
}

async function rows(client, text, values = []) {
  return (await client.query({ text, values })).rows;
}

async function assertDisposableLocalTarget(client, { disposableEngine = 'native-loopback' } = {}) {
  const result = await rows(
    client,
    `select current_database() as database_name,
            pg_catalog.inet_server_addr()::text as server_address,
            current_setting('application_name') as application_name,
            current_setting('transaction_read_only') as transaction_read_only,
            version() as server_version`
  );
  const row = result[0] || {};
  const pglite =
    disposableEngine === 'pglite-0.5.4' &&
    /PostgreSQL 18\.3 \(PGlite 0\.5\.4\)/.test(String(row.server_version || '')) &&
    row.server_address === null;
  const nativeLoopback =
    !DISPOSABLE_DATABASE_PATTERN.test(String(row.database_name || '')) ||
    !['127.0.0.1', '127.0.0.1/32', '::1', '::1/128'].includes(String(row.server_address || ''));
  if ((!pglite && nativeLoopback) || row.application_name !== 'environment-sync-x-rehearsal' || row.transaction_read_only !== 'off') {
    throw new Error('AUTH_QUARANTINE_TARGET_REJECTED');
  }
}

function connectionProjectRef(client) {
  const parameters = client?.connectionParameters || {};
  const host = String(parameters.host || '').toLowerCase();
  const directMatch = host.match(/^db\.([a-z0-9]{10,40})\.supabase\.co$/);
  if (directMatch) return directMatch[1];
  if (!/\.pooler\.supabase\.com$/.test(host)) return '';
  const userMatch = String(parameters.user || '').toLowerCase().match(/^postgres\.([a-z0-9]{10,40})$/);
  return userMatch?.[1] || '';
}

async function assertManagedNonprodTarget(
  client,
  { managedNonprodTarget = '', envValues = {}, sandboxRef = '' } = {}
) {
  const target = String(managedNonprodTarget || '').trim().toLowerCase();
  if (!['dev', 'sandbox'].includes(target)) {
    throw categoricalError('AUTH_QUARANTINE_MANAGED_TARGET_REJECTED');
  }
  const report = buildMutationTargetReport({
    envValues,
    requestedTarget: target,
    allowProd: false,
    sandboxRef,
    linked: false,
    linkedRef: ''
  });
  const derivedRef = connectionProjectRef(client);
  if (
    !report.ok ||
    report.mode !== 'mutation-guard' ||
    report.requestedTarget !== target ||
    !derivedRef ||
    report.expected.ref !== derivedRef ||
    derivedRef === PROD_PROJECT_REF
  ) {
    throw categoricalError('AUTH_QUARANTINE_MANAGED_TARGET_REJECTED');
  }

  const result = await rows(
    client,
    `select current_database() as database_name,
            pg_catalog.inet_server_addr()::text as server_address,
            current_setting('application_name') as application_name,
            current_setting('transaction_read_only') as transaction_read_only,
            current_user as current_user,
            coalesce((select ssl from pg_catalog.pg_stat_ssl where pid = pg_catalog.pg_backend_pid()), false) as ssl`
  );
  const row = result[0] || {};
  const serverAddress = String(row.server_address || '');
  if (
    row.database_name !== 'postgres' ||
    !serverAddress ||
    ['127.0.0.1', '127.0.0.1/32', '::1', '::1/128'].includes(serverAddress) ||
    row.application_name !== 'environment-sync-x-np-managed' ||
    row.transaction_read_only !== 'off' ||
    row.current_user !== 'postgres' ||
    row.ssl !== true
  ) {
    throw categoricalError('AUTH_QUARANTINE_MANAGED_TARGET_REJECTED');
  }

  return { target, projectRefMatched: true, mutationGuardPassed: true, ssl: true };
}

async function assertAuthQuarantineTarget(client, options = {}) {
  if (String(options.managedNonprodTarget || '').trim()) {
    return assertManagedNonprodTarget(client, options);
  }
  return assertDisposableLocalTarget(client, options);
}

async function assertExactAuthShape(client) {
  const tableRows = await rows(
    client,
    `select table_name
       from information_schema.tables
      where table_schema = 'auth' and table_type = 'BASE TABLE'
      order by table_name`
  );
  const tables = tableRows.map((row) => row.table_name);
  if (JSON.stringify(tables) !== JSON.stringify([...CURRENT_AUTH_TABLES])) {
    throw new Error('AUTH_SCHEMA_TABLE_SHAPE_UNREVIEWED');
  }
  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_AUTH_COLUMNS)) {
    const columnRows = await rows(
      client,
      `select column_name
         from information_schema.columns
        where table_schema = 'auth' and table_name = $1
        order by ordinal_position`,
      [tableName]
    );
    const actual = new Set(columnRows.map((row) => row.column_name));
    if (requiredColumns.some((column) => !actual.has(column))) {
      throw new Error('AUTH_SCHEMA_COLUMN_SHAPE_UNREVIEWED');
    }
  }
  const providerRows = await rows(client, `select distinct provider from auth.identities order by provider`);
  if (providerRows.some((row) => row.provider !== 'email')) {
    throw new Error('AUTH_PROVIDER_SHAPE_UNREVIEWED');
  }
  return { tables, providers: providerRows.map((row) => row.provider) };
}

async function captureAuthUuidSet(client) {
  const userRows = await rows(client, `select id::text as id from auth.users order by id`);
  const identityRows = await rows(
    client,
    `select id::text as id, user_id::text as user_id from auth.identities order by id`
  );
  return {
    userCount: userRows.length,
    identityCount: identityRows.length,
    userDigest: canonicalDigest(userRows),
    identityDigest: canonicalDigest(identityRows)
  };
}

async function captureAuthReferenceIntegrity(client) {
  const references = await rows(
    client,
    `select n.nspname as schema_name, c.relname as table_name, a.attname as column_name
       from pg_catalog.pg_constraint con
       join pg_catalog.pg_class c on c.oid = con.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join unnest(con.conkey) with ordinality source(attnum, position) on true
       join unnest(con.confkey) with ordinality target(attnum, position) using (position)
       join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = source.attnum
      where con.contype = 'f' and con.confrelid = 'auth.users'::regclass
        and target.attnum = (select attnum from pg_catalog.pg_attribute where attrelid = 'auth.users'::regclass and attname = 'id')
      order by n.nspname, c.relname, a.attname`
  );
  const checks = [];
  for (const reference of references) {
    const schema = `"${String(reference.schema_name).replaceAll('"', '""')}"`;
    const table = `"${String(reference.table_name).replaceAll('"', '""')}"`;
    const column = `"${String(reference.column_name).replaceAll('"', '""')}"`;
    const countRows = await rows(
      client,
      `select count(*)::bigint as count
         from ${schema}.${table} child
        where child.${column} is not null
          and not exists (select 1 from auth.users parent where parent.id = child.${column})`
    );
    checks.push({
      relation: `${reference.schema_name}.${reference.table_name}.${reference.column_name}`,
      dangling: safeCount(countRows[0]?.count, 'Auth reference count')
    });
  }
  return { count: checks.length, digest: canonicalDigest(checks), dangling: checks.reduce((sum, item) => sum + item.dangling, 0) };
}

async function purgeAuthEphemera(client) {
  const counts = {};
  for (const tableName of AUTH_PURGE_ORDER) {
    const result = await client.query(`delete from auth."${tableName}"`);
    counts[tableName] = safeCount(result.rowCount, 'Auth purge count');
  }
  return counts;
}

async function quarantineUsers(client) {
  const result = await client.query(
    `update auth.users
        set email = ${QUARANTINED_EMAIL_SQL},
            phone = null,
            encrypted_password = '!x-np-disabled-v1!',
            raw_app_meta_data = jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'x_np_quarantined', true),
            raw_user_meta_data = jsonb_build_object('x_np_quarantined', true),
            confirmation_token = '', confirmation_sent_at = null,
            recovery_token = '', recovery_sent_at = null,
            email_change_token_new = '', email_change = '', email_change_sent_at = null,
            email_change_token_current = '', email_change_confirm_status = 0,
            phone_change = '', phone_change_token = '', phone_change_sent_at = null,
            reauthentication_token = '', reauthentication_sent_at = null,
            invited_at = null, last_sign_in_at = null,
            banned_until = 'infinity'::timestamptz,
            is_sso_user = false, is_anonymous = false,
            updated_at = statement_timestamp()`
  );
  return safeCount(result.rowCount, 'Quarantined user count');
}

async function quarantineIdentities(client) {
  const result = await client.query(
    `update auth.identities i
        set provider = 'email',
            provider_id = u.email,
            identity_data = jsonb_build_object(
              'sub', u.id::text,
              'email', u.email,
              'email_verified', false,
              'phone_verified', false,
              'x_np_quarantined', true
            ),
            last_sign_in_at = null,
            updated_at = statement_timestamp()
       from auth.users u
      where u.id = i.user_id`
  );
  return safeCount(result.rowCount, 'Quarantined identity count');
}

async function verifyQuarantine(client, before) {
  const after = await captureAuthUuidSet(client);
  const counts = await rows(
    client,
    `select
       count(*) filter (where email !~ '^[a-z0-9-]+@users\\.invalid$')::bigint as routable_email_count,
       count(*) filter (where phone is not null or phone_change <> '')::bigint as phone_count,
       count(*) filter (where encrypted_password <> '!x-np-disabled-v1!' or banned_until <> 'infinity'::timestamptz)::bigint as usable_credential_shape_count,
       count(*) filter (where confirmation_token <> '' or recovery_token <> '' or email_change_token_new <> '' or email_change_token_current <> '' or reauthentication_token <> '')::bigint as token_column_count
     from auth.users`
  );
  const ephemera = {};
  for (const tableName of AUTH_PURGE_ORDER) {
    const result = await rows(client, `select count(*)::bigint as count from auth."${tableName}"`);
    ephemera[tableName] = safeCount(result[0]?.count, 'Post-quarantine Auth count');
  }
  const identityMismatch = await rows(
    client,
    `select count(*)::bigint as count
       from auth.identities i
       join auth.users u on u.id = i.user_id
      where i.provider <> 'email' or i.provider_id <> u.email or i.email <> u.email
         or i.identity_data->>'email' <> u.email or coalesce((i.identity_data->>'x_np_quarantined')::boolean, false) is not true`
  );
  const referenceIntegrity = await captureAuthReferenceIntegrity(client);
  const result = {
    uuidSetPreserved:
      before.userCount === after.userCount &&
      before.identityCount === after.identityCount &&
      before.userDigest === after.userDigest &&
      before.identityDigest === after.identityDigest,
    routableEmailCount: safeCount(counts[0]?.routable_email_count, 'Routable email count'),
    phoneCount: safeCount(counts[0]?.phone_count, 'Phone count'),
    usableCredentialShapeCount: safeCount(counts[0]?.usable_credential_shape_count, 'Credential shape count'),
    tokenColumnCount: safeCount(counts[0]?.token_column_count, 'Token column count'),
    identityMismatchCount: safeCount(identityMismatch[0]?.count, 'Identity mismatch count'),
    sessionAndTokenCounts: ephemera,
    referenceIntegrity
  };
  result.ok =
    result.uuidSetPreserved &&
    result.routableEmailCount === 0 &&
    result.phoneCount === 0 &&
    result.usableCredentialShapeCount === 0 &&
    result.tokenColumnCount === 0 &&
    result.identityMismatchCount === 0 &&
    Object.values(ephemera).every((count) => count === 0) &&
    referenceIntegrity.dangling === 0;
  if (!result.ok) throw new Error('AUTH_QUARANTINE_VERIFICATION_FAILED');
  return result;
}

async function createTargetNativeSmokeIdentity(client, options = {}) {
  let stage = 'TARGET_GUARD';
  const userId = String(options.userId || crypto.randomUUID());
  const identityId = String(options.identityId || crypto.randomUUID());
  const email = String(options.email || `smoke-${crypto.randomBytes(20).toString('hex')}@users.invalid`);
  const lifecycleTimestamp = String(options.lifecycleTimestamp || new Date().toISOString());
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(userId)) {
    throw categoricalError('TARGET_NATIVE_SMOKE_USER_ID_INVALID');
  }
  if (!Number.isFinite(Date.parse(lifecycleTimestamp))) {
    throw categoricalError('TARGET_NATIVE_SMOKE_TIMESTAMP_INVALID');
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(identityId)) {
    throw categoricalError('TARGET_NATIVE_SMOKE_IDENTITY_ID_INVALID');
  }
  if (!/^smoke-[a-f0-9]{40}@users\.invalid$/.test(email)) {
    throw categoricalError('TARGET_NATIVE_SMOKE_EMAIL_INVALID');
  }
  const credentialBytes = crypto.randomBytes(32);
  let credential = credentialBytes.toString('base64url');
  try {
    await assertDisposableLocalTarget(client, options);
    stage = 'USER_INSERT';
    await client.query(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         confirmation_token, recovery_token, email_change_token_new, email_change,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at, phone,
         phone_change, phone_change_token, email_change_token_current,
         email_change_confirm_status, reauthentication_token, banned_until,
         is_sso_user, is_anonymous
       ) values (
         coalesce((select instance_id from auth.users order by id limit 1), '00000000-0000-0000-0000-000000000000'::uuid),
         $1::uuid, 'authenticated', 'authenticated', $2,
         extensions.crypt($3, extensions.gen_salt('bf')), $4::timestamptz,
         '', '', '', '',
         jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'x_np_target_native_smoke', true),
         jsonb_build_object('x_np_target_native_smoke', true),
         $4::timestamptz, $4::timestamptz, null,
         '', '', '', 0, '', null, false, false
       )`,
      [userId, email, credential, lifecycleTimestamp]
    );
    stage = 'IDENTITY_INSERT';
    await client.query(
      `insert into auth.identities (
         id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
       ) values (
         $1::uuid, $2::uuid, $3::text,
         jsonb_build_object('sub', $2::text, 'email', $3::text, 'email_verified', true,
                            'phone_verified', false, 'x_np_target_native_smoke', true),
         'email', null, $4::timestamptz, $4::timestamptz
       )`,
      [identityId, userId, email, lifecycleTimestamp]
    );
    stage = 'VERIFICATION';
    const result = await rows(
      client,
      `select
         count(*) filter (
           where u.id = $1::uuid and i.id = $2::uuid and u.email = $3
             and u.banned_until is null
             and extensions.crypt($4, u.encrypted_password) = u.encrypted_password
             and i.user_id = u.id and i.provider = 'email' and i.provider_id = u.email
             and i.email = u.email
             and coalesce((i.identity_data->>'x_np_target_native_smoke')::boolean, false) is true
         )::bigint as smoke_match_count,
         count(*) filter (
           where u.id <> $1::uuid
             and (u.encrypted_password <> '!x-np-disabled-v1!'
                  or u.banned_until <> 'infinity'::timestamptz)
         )::bigint as copied_credential_shape_count
       from auth.users u
       left join auth.identities i on i.user_id = u.id`,
      [userId, identityId, email, credential]
    );
    const smokeMatchCount = safeCount(result[0]?.smoke_match_count, 'Native smoke count');
    const copiedCredentialShapeCount = safeCount(
      result[0]?.copied_credential_shape_count,
      'Copied credential shape count'
    );
    if (smokeMatchCount !== 1 || copiedCredentialShapeCount !== 0) {
      throw categoricalError('TARGET_NATIVE_SMOKE_VERIFICATION_FAILED');
    }
    return {
      method: 'disposable-native-auth-schema-contract',
      usersCreated: 1,
      identitiesCreated: 1,
      credentialVerified: true,
      copiedCredentialShapeCount,
      routableIdentityCreated: false,
      credentialUniquePerTarget: true,
      structuralIdentitySharedForParity: options.structuralIdentitySharedForParity === true,
      platformAuthAdminVerificationDeferred: true
    };
  } catch (error) {
    const code = existingCategoricalCode(error);
    if (code) throw error;
    const sqlState = safeSqlState(error);
    throw categoricalError(`TARGET_NATIVE_SMOKE_${stage}${sqlState ? `_SQLSTATE_${sqlState}` : ''}_FAILED`);
  } finally {
    credential = '';
    credentialBytes.fill(0);
  }
}

async function applyAuthQuarantine(client, options = {}) {
  let stage = 'TARGET_GUARD';
  try {
    await assertAuthQuarantineTarget(client, options);
    stage = 'SCHEMA_SHAPE';
    const shape = await assertExactAuthShape(client);
    stage = 'IDENTITY_CAPTURE';
    const before = await captureAuthUuidSet(client);
    stage = 'REFERENCE_CAPTURE';
    const beforeReferences = await captureAuthReferenceIntegrity(client);
    if (beforeReferences.dangling !== 0) throw new Error('AUTH_REFERENCE_INTEGRITY_FAILED');
    stage = 'EPHEMERA_PURGE';
    const purged = await purgeAuthEphemera(client);
    stage = 'USER_QUARANTINE';
    const usersUpdated = await quarantineUsers(client);
    stage = 'IDENTITY_QUARANTINE';
    const identitiesUpdated = await quarantineIdentities(client);
    stage = 'VERIFICATION';
    const verification = await verifyQuarantine(client, before);
    return {
      version: AUTH_QUARANTINE_VERSION,
      shape: { tableCount: shape.tables.length, providers: shape.providers },
      counts: { usersUpdated, identitiesUpdated, purged },
      verification,
      nativeSmokeHook: {
        method: 'target-native-auth-admin-api-after-platform-configuration',
        copiedCredentialReuse: false,
        uniquePerTarget: true
      }
    };
  } catch (error) {
    const code = existingCategoricalCode(error);
    if (code) throw error;
    const sqlState = safeSqlState(error);
    throw categoricalError(`AUTH_QUARANTINE_${stage}${sqlState ? `_SQLSTATE_${sqlState}` : ''}_FAILED`);
  }
}

export {
  DISPOSABLE_DATABASE_PATTERN,
  QUARANTINED_EMAIL_SQL,
  applyAuthQuarantine,
  assertAuthQuarantineTarget,
  assertDisposableLocalTarget,
  assertManagedNonprodTarget,
  assertExactAuthShape,
  captureAuthReferenceIntegrity,
  createTargetNativeSmokeIdentity
};
