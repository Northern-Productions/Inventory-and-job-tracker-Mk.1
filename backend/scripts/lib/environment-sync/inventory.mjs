import { captureDatabaseState, quoteIdentifier } from '../release-integrity.mjs';
import { canonicalDigest } from '../readonly-diagnostics.mjs';
import { ENVIRONMENT_INVENTORY_FORMAT } from './constants.mjs';

const CATALOG_SCHEMAS = Object.freeze(['app', 'app_api', 'public']);
const CLIENT_QUERY_QUEUES = new WeakMap();

function asText(value) {
  return String(value ?? '').trim();
}

function countValue(value) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error('Inventory count is invalid.');
  }
  return number;
}

function digestRows(rows) {
  return { count: rows.length, digest: canonicalDigest(rows) };
}

function safeConfigurationVariableNames(envValues = {}) {
  return Object.keys(envValues || {})
    .filter((name) => /^[A-Z][A-Z0-9_]{1,127}$/.test(name))
    .sort();
}

async function queryRows(client, sql, params = []) {
  const previous = CLIENT_QUERY_QUEUES.get(client) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => client.query(sql, params));
  CLIENT_QUERY_QUEUES.set(client, current);
  try {
    return (await current).rows;
  } finally {
    if (CLIENT_QUERY_QUEUES.get(client) === current) CLIENT_QUERY_QUEUES.delete(client);
  }
}

async function captureCatalog(client) {
  const [schemas, relations, columns, routines, triggers, constraints, indexes, policies, grants, roles, extensions, sequences] =
    await Promise.all([
      queryRows(
        client,
        `select nspname as schema_name
         from pg_catalog.pg_namespace
         where nspname !~ '^pg_' and nspname <> 'information_schema'
         order by nspname`
      ),
      queryRows(
        client,
        `select n.nspname as schema_name, c.relname as object_name, c.relkind, c.relpersistence,
                c.relrowsecurity, c.relforcerowsecurity
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = any($1::text[]) and c.relkind in ('r', 'p', 'v', 'm', 'S')
         order by n.nspname, c.relname`,
        [CATALOG_SCHEMAS]
      ),
      queryRows(
        client,
        `select table_schema as schema_name, table_name, ordinal_position, column_name,
                data_type, udt_schema, udt_name, is_nullable, coalesce(column_default, '') as column_default,
                is_identity, identity_generation, is_generated, generation_expression
         from information_schema.columns
         where table_schema = any($1::text[])
         order by table_schema, table_name, ordinal_position`,
        [CATALOG_SCHEMAS]
      ),
      queryRows(
        client,
        `select n.nspname as schema_name, p.proname as routine_name,
                pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
                pg_catalog.pg_get_function_result(p.oid) as result_type,
                l.lanname as language, p.provolatile, p.prosecdef,
                pg_catalog.pg_get_functiondef(p.oid) as definition
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         join pg_catalog.pg_language l on l.oid = p.prolang
         where n.nspname = any($1::text[]) and p.prokind in ('f', 'p')
         order by n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)`,
        [CATALOG_SCHEMAS]
      ),
      queryRows(
        client,
        `select n.nspname as schema_name, c.relname as table_name, t.tgname as trigger_name,
                pg_catalog.pg_get_triggerdef(t.oid, true) as definition, t.tgenabled
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where not t.tgisinternal and n.nspname = any($1::text[])
         order by n.nspname, c.relname, t.tgname`,
        [CATALOG_SCHEMAS]
      ),
      queryRows(
        client,
        `select n.nspname as schema_name, c.relname as table_name, con.conname as constraint_name,
                con.contype, con.convalidated, pg_catalog.pg_get_constraintdef(con.oid, true) as definition
         from pg_catalog.pg_constraint con
         join pg_catalog.pg_class c on c.oid = con.conrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = any($1::text[])
         order by n.nspname, c.relname, con.conname`,
        [CATALOG_SCHEMAS]
      ),
      queryRows(
        client,
        `select schemaname as schema_name, tablename as table_name, indexname as index_name, indexdef
         from pg_catalog.pg_indexes
         where schemaname = any($1::text[])
         order by schemaname, tablename, indexname`,
        [CATALOG_SCHEMAS]
      ),
      queryRows(
        client,
        `select schemaname as schema_name, tablename as table_name, policyname as policy_name,
                permissive, roles::text, cmd, coalesce(qual, '') as qual,
                coalesce(with_check, '') as with_check
         from pg_catalog.pg_policies
         where schemaname = any($1::text[])
         order by schemaname, tablename, policyname`,
        [CATALOG_SCHEMAS]
      ),
      queryRows(
        client,
        `select 'table'::text as object_type, table_schema as schema_name, table_name as object_name,
                grantee, privilege_type, is_grantable
         from information_schema.role_table_grants
         where table_schema = any($1::text[])
         union all
         select 'routine'::text, routine_schema, routine_name, grantee, privilege_type, is_grantable
         from information_schema.role_routine_grants
         where routine_schema = any($1::text[])
         order by object_type, schema_name, object_name, grantee, privilege_type`,
        [CATALOG_SCHEMAS]
      ),
      queryRows(
        client,
        `select rolname as role_name, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                rolcanlogin, rolreplication, rolbypassrls
         from pg_catalog.pg_roles
         where rolname !~ '^pg_'
         order by rolname`
      ),
      queryRows(
        client,
        `select e.extname as extension_name, e.extversion, n.nspname as schema_name
         from pg_catalog.pg_extension e
         join pg_catalog.pg_namespace n on n.oid = e.extnamespace
         order by e.extname`
      ),
      queryRows(
        client,
        `select sequence_schema as schema_name, sequence_name, data_type, start_value,
                minimum_value, maximum_value, increment, cycle_option
         from information_schema.sequences
         where sequence_schema = any($1::text[])
         order by sequence_schema, sequence_name`,
        [CATALOG_SCHEMAS]
      )
    ]);

  return {
    schemas: digestRows(schemas),
    relations: digestRows(relations),
    columns: digestRows(columns),
    routines: digestRows(routines),
    triggers: digestRows(triggers),
    constraints: digestRows(constraints),
    indexes: digestRows(indexes),
    policies: digestRows(policies),
    rolesAndGrants: digestRows([...roles, ...grants]),
    extensions: { ...digestRows(extensions), names: extensions.map((row) => row.extension_name) },
    sequences: digestRows(sequences)
  };
}

async function tableCountIfPresent(client, qualifiedName) {
  const exists = await client.query(`select pg_catalog.to_regclass($1) is not null as present`, [qualifiedName]);
  if (exists.rows[0]?.present !== true) return 0;
  const [schemaName, tableName] = qualifiedName.split('.', 2);
  const result = await client.query(
    `select count(*)::bigint as count from ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`
  );
  return countValue(result.rows[0]?.count);
}

async function captureAuthTopology(client) {
  const authTables = await queryRows(
    client,
    `select table_name
     from information_schema.tables
     where table_schema = 'auth' and table_type = 'BASE TABLE'
     order by table_name`
  );
  const counts = {};
  for (const { table_name: tableName } of authTables) {
    counts[tableName] = await tableCountIfPresent(client, `auth.${tableName}`);
  }
  const providers = await queryRows(
    client,
    `select provider, count(*)::bigint as count
     from auth.identities
     group by provider
     order by provider`
  );
  const memberships = await queryRows(
    client,
    `select m.role, m.status, (u.id is not null) as has_auth_user, count(*)::bigint as count
     from app.organization_members m
     left join auth.users u on u.id = m.user_id
     group by m.role, m.status, (u.id is not null)
     order by m.role, m.status, (u.id is not null)`
  );
  const sessionNames = [
    'sessions',
    'refresh_tokens',
    'mfa_amr_claims',
    'one_time_tokens',
    'flow_state',
    'mfa_challenges',
    'mfa_factors',
    'oauth_authorizations',
    'oauth_client_states',
    'oauth_clients',
    'oauth_consents',
    'saml_providers',
    'saml_relay_states',
    'sso_domains',
    'sso_providers',
    'webauthn_challenges',
    'webauthn_credentials'
  ];
  return {
    users: counts.users || 0,
    identities: counts.identities || 0,
    providers: providers.map((row) => ({ provider: row.provider, count: countValue(row.count) })),
    memberships: memberships.map((row) => ({
      role: row.role,
      status: row.status,
      hasAuthUser: row.has_auth_user === true,
      count: countValue(row.count)
    })),
    sessionAndTokenCounts: Object.fromEntries(sessionNames.map((name) => [name, counts[name] || 0])),
    authTableCount: authTables.length,
    authTableShapeDigest: canonicalDigest(authTables.map((row) => row.table_name))
  };
}

async function captureSideEffects(client, extensionNames) {
  const foreignTableRows = await queryRows(
    client,
    `select n.nspname as schema_name, c.relname as table_name
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'f'
     order by n.nspname, c.relname`
  );
  const publicationRows = await queryRows(
    client,
    `select p.pubname as publication_name, count(pt.*)::bigint as table_count
     from pg_catalog.pg_publication p
     left join pg_catalog.pg_publication_tables pt on pt.pubname = p.pubname
     group by p.pubname
     order by p.pubname`
  );
  const externalReferences = await queryRows(
    client,
    `select count(*)::bigint as count
     from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any($1::text[]) and p.prokind in ('f', 'p')
       and lower(pg_catalog.pg_get_functiondef(p.oid)) ~ '(net\\.|http_request|https?://|resend|webhook)'`,
    [CATALOG_SCHEMAS]
  );
  const webhookTriggers = await queryRows(
    client,
    `select count(*)::bigint as count
     from pg_catalog.pg_trigger t
     join pg_catalog.pg_proc p on p.oid = t.tgfoid
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where not t.tgisinternal and p.prokind in ('f', 'p')
       and lower(pg_catalog.pg_get_functiondef(p.oid)) ~ '(net\\.|http_request|https?://|webhook)'`
  );
  const pgCronJobs = await tableCountIfPresent(client, 'cron.job');
  const storageBuckets = await tableCountIfPresent(client, 'storage.buckets');
  const storageObjects = await tableCountIfPresent(client, 'storage.objects');
  const vaultSecrets = await tableCountIfPresent(client, 'vault.secrets');
  return {
    database: {
      pgCronJobs,
      pgNetEnabled: extensionNames.includes('pg_net'),
      databaseWebhookCount: countValue(webhookTriggers[0]?.count),
      foreignTableCount: foreignTableRows.length,
      externalFunctionReferenceCount: countValue(externalReferences[0]?.count),
      publications: publicationRows.map((row) => ({
        name: row.publication_name,
        tableCount: countValue(row.table_count)
      })),
      storageBuckets,
      storageObjects,
      vaultSecrets
    }
  };
}

function classifyUrl(value, projectRef) {
  const text = asText(value);
  if (!text) return 'unset';
  try {
    const url = new URL(text);
    if (/localhost|127\.0\.0\.1/i.test(url.hostname)) return 'local';
    if (projectRef && url.hostname.includes(projectRef)) return 'target_project';
    if (/\.invalid$/i.test(url.hostname)) return 'sink';
    return 'external';
  } catch {
    return 'invalid';
  }
}

async function fetchManagementJson(pathname, accessToken, fetchImpl) {
  const response = await fetchImpl(`https://api.supabase.com${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`MANAGEMENT_API_${response.status}`);
  return response.json();
}

async function fetchManagementSummary({ projectRef, accessToken, fetchImpl = fetch } = {}) {
  if (!asText(accessToken)) {
    return { available: false, reason: 'access_token_unavailable' };
  }
  try {
    const [project, functions, secrets, auth] = await Promise.all([
      fetchManagementJson(`/v1/projects/${projectRef}`, accessToken, fetchImpl),
      fetchManagementJson(`/v1/projects/${projectRef}/functions`, accessToken, fetchImpl),
      fetchManagementJson(`/v1/projects/${projectRef}/secrets`, accessToken, fetchImpl),
      fetchManagementJson(`/v1/projects/${projectRef}/config/auth`, accessToken, fetchImpl)
    ]);
    const providerFlags = Object.entries(auth || {})
      .filter(([key, value]) => /^external_.+_enabled$/.test(key) && value === true)
      .map(([key]) => key)
      .sort();
    return {
      available: true,
      project: {
        status: asText(project?.status),
        region: asText(project?.region),
        databaseVersion: asText(project?.database?.version)
      },
      edge: {
        deployments: (Array.isArray(functions) ? functions : [])
          .map((entry) => ({
            slug: asText(entry.slug || entry.name),
            version: Number(entry.version || 0),
            status: asText(entry.status),
            verifyJwt: entry.verify_jwt === true
          }))
          .sort((a, b) => a.slug.localeCompare(b.slug))
      },
      secrets: {
        names: (Array.isArray(secrets) ? secrets : [])
          .map((entry) => asText(entry.name))
          .filter(Boolean)
          .sort()
      },
      auth: {
        signupDisabled: auth?.disable_signup === true,
        emailEnabled: auth?.external_email_enabled === true,
        phoneEnabled: auth?.external_phone_enabled === true,
        mailerAutoconfirm: auth?.mailer_autoconfirm === true,
        smtpConfigured: Boolean(asText(auth?.smtp_host)),
        smsProviderConfigured: Boolean(asText(auth?.sms_provider)),
        siteUrlClass: classifyUrl(auth?.site_url, projectRef),
        redirectUrlClasses: Array.from(
          new Set(
            (Array.isArray(auth?.uri_allow_list)
              ? auth.uri_allow_list
              : asText(auth?.uri_allow_list).split(',').filter(Boolean))
              .map((value) => classifyUrl(value, projectRef))
          )
        ).sort(),
        enabledProviderFlags: providerFlags
      }
    };
  } catch (error) {
    return { available: false, reason: asText(error?.message).replace(/[^A-Z0-9_]/gi, '_').slice(0, 80) };
  }
}

async function fetchEdgeHealth({ supabaseUrl, fetchImpl = fetch } = {}) {
  const base = asText(supabaseUrl).replace(/\/$/, '');
  if (!base) return { available: false };
  try {
    const response = await fetchImpl(`${base}/functions/v1/api/health`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    });
    const body = await response.json();
    const data = body?.data || body || {};
    return {
      available: response.ok,
      httpStatus: response.status,
      apiVersion: asText(data?.version || data?.apiVersion),
      status: asText(data?.status),
      buildSha: asText(data?.apiBuildSha || data?.buildSha),
      builtAtPresent: Boolean(asText(data?.apiBuiltAt || data?.builtAt))
    };
  } catch {
    return { available: false };
  }
}

async function captureEnvironmentInventory({
  client,
  target,
  projectRef,
  envValues = {},
  management = { available: false },
  edgeHealth = { available: false },
  source = {},
  capturedAt = new Date().toISOString()
} = {}) {
  const readOnly = await client.query('show transaction_read_only');
  if (asText(readOnly.rows[0]?.transaction_read_only).toLowerCase() !== 'on') {
    throw new Error('Environment inventory requires transaction_read_only=on.');
  }
  const serverVersion = await client.query('show server_version');
  const databaseState = await captureDatabaseState(client);
  const catalog = await captureCatalog(client);
  const authTopology = await captureAuthTopology(client);
  const sideEffects = await captureSideEffects(client, catalog.extensions.names);
  const versions = databaseState.migrationState.versions;
  return {
    format: ENVIRONMENT_INVENTORY_FORMAT,
    version: 1,
    capturedAt,
    target: { environment: target, projectRef },
    source: {
      gitCommit: asText(source.gitCommit),
      edgeGraphDigest: asText(source.edgeGraphDigest),
      edgeLockDigest: asText(source.edgeLockDigest)
    },
    postgres: { version: asText(serverVersion.rows[0]?.server_version) },
    migration: {
      count: versions.length,
      tip: versions.at(-1) || '',
      digest: databaseState.migrationState.fingerprint
    },
    catalog,
    protectedData: databaseState.protectedData,
    protectedSchema: databaseState.schemaState,
    authTopology,
    sideEffects,
    edge: { health: edgeHealth, management: management.edge || { deployments: [] } },
    platform: {
      project: management.project || {},
      auth: management.auth || {},
      secrets: management.secrets || { names: [] },
      managementAvailable: management.available === true
    },
    configuration: { variableNames: safeConfigurationVariableNames(envValues) },
    transaction: { isolation: 'repeatable_read', readOnly: true, rollbackRequired: true }
  };
}

export {
  CATALOG_SCHEMAS,
  captureEnvironmentInventory,
  classifyUrl,
  fetchEdgeHealth,
  fetchManagementSummary,
  safeConfigurationVariableNames
};
