import crypto from 'node:crypto';

import { canonicalSerialize } from '../readonly-diagnostics.mjs';

const PRESERVATION_FORMAT = 'dev-native-smoke-relational-preservation-v1';
const TABLE_SCOPE = Object.freeze([
  ['auth', 'users', 'id = $1::uuid', ['userId'], false],
  ['auth', 'identities', 'user_id = $1::uuid', ['userId'], false],
  ['app', 'organizations', 'id = $1::uuid', ['organizationId'], false],
  ['app', 'organization_members', 'org_id = $1::uuid and user_id = $2::uuid', ['organizationId', 'userId'], false],
  ['app', 'warehouses', 'org_id = $1::uuid', ['organizationId'], false],
  ['app', 'owner_companies', 'org_id = $1::uuid', ['organizationId'], false],
  ['app', 'general_feature_permissions', 'org_id = $1::uuid', ['organizationId'], false],
  ['app', 'user_preferences', 'org_id = $1::uuid and user_id = $2::uuid', ['organizationId', 'userId'], true],
  ['app', 'owner_notification_preferences', 'org_id = $1::uuid and owner_user_id = $2::uuid', ['organizationId', 'userId'], true]
].map(([schema, table, predicate, parameters, optional]) =>
  Object.freeze({ schema, table, predicate, parameters, optional })));

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertUuid(value, code) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw categoricalError(code);
  }
  return normalized;
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(value || ''))) {
    throw categoricalError('DEV_REFRESH_NATIVE_SMOKE_IDENTIFIER_INVALID');
  }
  return `"${value}"`;
}

function dollarQuote(value, token) {
  const rendered = String(value);
  if (rendered.includes(`$${token}$`)) throw categoricalError('DEV_REFRESH_NATIVE_SMOKE_VALUE_INVALID');
  return `$${token}$${rendered}$${token}$`;
}

async function relationExists(client, schema, table) {
  const result = await client.query('select to_regclass($1)::text as relation', [`${schema}.${table}`]);
  return Boolean(result.rows[0]?.relation);
}

async function insertableColumns(client, schema, table) {
  const result = await client.query(
    `select column_name from information_schema.columns
      where table_schema = $1 and table_name = $2
        and is_generated = 'NEVER' and identity_generation is null
      order by ordinal_position`,
    [schema, table]
  );
  const columns = result.rows.map((row) => String(row.column_name));
  if (!columns.length || columns.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) {
    throw categoricalError('DEV_REFRESH_NATIVE_SMOKE_COLUMN_SCOPE_INVALID');
  }
  return columns;
}

function buildInsertSql(entry) {
  if (!entry.rows.length) return '';
  const relation = `${quoteIdentifier(entry.schema)}.${quoteIdentifier(entry.table)}`;
  const columns = entry.columns.map(quoteIdentifier).join(', ');
  return entry.rows.map((row, index) => {
    const token = `native_${entry.schema}_${entry.table}_${index}`;
    return `insert into ${relation} (${columns}) select ${columns} from jsonb_populate_record(null::${relation}, ${dollarQuote(JSON.stringify(row), token)}::jsonb);`;
  }).join('\n');
}

function buildVerificationSql(entry, values) {
  const relation = `${quoteIdentifier(entry.schema)}.${quoteIdentifier(entry.table)}`;
  const columns = entry.columns.map(quoteIdentifier).join(', ');
  const parameters = new Map(entry.parameters.map((name, index) => [index + 1, values[name]]));
  const predicate = entry.predicate.replace(/\$(\d+)::uuid/g, (_match, index) =>
    `${dollarQuote(parameters.get(Number(index)), `verify_${entry.schema}_${entry.table}_${index}`)}::uuid`);
  const expected = dollarQuote(JSON.stringify(entry.rows), `expected_${entry.schema}_${entry.table}`);
  return [
    'if (select coalesce(jsonb_agg(to_jsonb(scoped) order by to_jsonb(scoped)::text), \'[]\'::jsonb)',
    `      from (select ${columns} from ${relation} where ${predicate}) scoped) <> ${expected}::jsonb then`,
    "  raise exception 'DEV_REFRESH_NATIVE_SMOKE_ROW_MISMATCH';",
    'end if;'
  ].join('\n');
}

async function captureNativeSmokePreservation(client, { userId, organizationId } = {}) {
  if (!client || typeof client.query !== 'function') {
    throw categoricalError('DEV_REFRESH_NATIVE_SMOKE_CLIENT_INVALID');
  }
  const values = {
    userId: assertUuid(userId, 'DEV_REFRESH_NATIVE_SMOKE_USER_INVALID'),
    organizationId: assertUuid(organizationId, 'DEV_REFRESH_NATIVE_SMOKE_ORG_INVALID')
  };
  const captured = [];
  for (const scope of TABLE_SCOPE) {
    if (!(await relationExists(client, scope.schema, scope.table))) {
      if (scope.optional) continue;
      throw categoricalError('DEV_REFRESH_NATIVE_SMOKE_TABLE_MISSING');
    }
    const columns = await insertableColumns(client, scope.schema, scope.table);
    const result = await client.query(
      `select to_jsonb(scoped) as row from (
         select ${columns.map(quoteIdentifier).join(', ')}
           from ${quoteIdentifier(scope.schema)}.${quoteIdentifier(scope.table)}
          where ${scope.predicate}
       ) scoped order by to_jsonb(scoped)::text`,
      scope.parameters.map((name) => values[name])
    );
    captured.push({ ...scope, columns, rows: result.rows.map((entry) => entry.row) });
  }
  const counts = Object.fromEntries(captured.map((entry) => [`${entry.schema}.${entry.table}`, entry.rows.length]));
  if (
    counts['auth.users'] !== 1 || counts['auth.identities'] !== 1 ||
    counts['app.organizations'] !== 1 || counts['app.organization_members'] !== 1 ||
    counts['app.warehouses'] < 1 || counts['app.owner_companies'] < 1
  ) throw categoricalError('DEV_REFRESH_NATIVE_SMOKE_CARDINALITY_INVALID');
  const membership = captured.find((entry) => entry.table === 'organization_members').rows[0];
  const user = captured.find((entry) => entry.schema === 'auth' && entry.table === 'users').rows[0];
  const identity = captured.find((entry) => entry.schema === 'auth' && entry.table === 'identities').rows[0];
  if (
    membership.role !== 'owner' || membership.status !== 'active' || user.banned_until != null ||
    user.raw_user_meta_data?.x_np_target_native_smoke !== true ||
    identity.identity_data?.x_np_target_native_smoke !== true
  ) throw categoricalError('DEV_REFRESH_NATIVE_SMOKE_CONTRACT_INVALID');
  const inserts = captured.map(buildInsertSql).filter(Boolean).join('\n');
  const verification = captured.map((entry) => buildVerificationSql(entry, values)).join('\n');
  const sql = [inserts, 'do $dev_native_smoke_verify$', 'begin', verification, 'end', '$dev_native_smoke_verify$;'].join('\n');
  const evidence = {
    format: PRESERVATION_FORMAT,
    userCount: 1,
    identityCount: 1,
    ownerMembershipCount: 1,
    foundationalTableCount: captured.length,
    rowCount: Object.values(counts).reduce((total, count) => total + count, 0),
    counts,
    rowsDigest: `sha256:${crypto.createHash('sha256').update(canonicalSerialize(
      captured.map(({ schema, table, rows }) => ({ schema, table, rows }))
    )).digest('hex')}`,
    sqlDigest: `sha256:${crypto.createHash('sha256').update(sql).digest('hex')}`
  };
  return { sql, evidence, userId: values.userId, organizationId: values.organizationId };
}

function verifyNativeSmokePreservation(value = {}) {
  const sql = String(value.sql || '');
  if (
    value?.evidence?.format !== PRESERVATION_FORMAT ||
    value.evidence.userCount !== 1 || value.evidence.identityCount !== 1 ||
    value.evidence.ownerMembershipCount !== 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.evidence.rowsDigest || '')) ||
    value.evidence.sqlDigest !== `sha256:${crypto.createHash('sha256').update(sql).digest('hex')}` ||
    !sql.includes('DEV_REFRESH_NATIVE_SMOKE_ROW_MISMATCH') ||
    /\b(?:delete|update|drop|alter|truncate|grant|revoke|create)\b/i.test(sql)
  ) throw categoricalError('DEV_REFRESH_NATIVE_SMOKE_PRESERVATION_INVALID');
  return value;
}

export {
  PRESERVATION_FORMAT,
  TABLE_SCOPE,
  captureNativeSmokePreservation,
  verifyNativeSmokePreservation
};
