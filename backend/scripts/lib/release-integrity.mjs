import crypto from 'node:crypto';

import { TARGET_REFS } from './target-env-guards.mjs';

const SNAPSHOT_FORMAT = 'window-film-release-integrity';
const SNAPSHOT_VERSION = 1;
const ROW_FINGERPRINT_ALGORITHM = 'sha256-over-sorted-md5-jsonb-v1';
const SCHEMA_FINGERPRINT_ALGORITHM = 'sha256-over-column-metadata-v1';
const PROTECTED_SCOPE = Object.freeze({
  discoveredSchemas: Object.freeze(['app']),
  explicitTables: Object.freeze(['auth.users'])
});

function asText(value) {
  return String(value ?? '').trim();
}

function sha256(value = '') {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function quoteIdentifier(value) {
  const identifier = asText(value);
  if (!identifier || identifier.includes('\0')) {
    throw new Error('Invalid SQL identifier.');
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTableName(table) {
  return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;
}

function tableKey(table) {
  return `${table.schema}.${table.table}`;
}

function normalizeStringSet(values = []) {
  const normalized = new Set();
  for (const value of values) {
    for (const item of String(value ?? '').split(',')) {
      const text = asText(item);
      if (text) {
        normalized.add(text);
      }
    }
  }
  return normalized;
}

function assertFingerprint(value, label) {
  if (!/^sha256:[a-f0-9]{64}$/.test(asText(value))) {
    throw new Error(`${label} is not a valid SHA-256 fingerprint.`);
  }
}

function assertTableName(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/.test(asText(value))) {
    throw new Error(`${label} must be a schema-qualified table name.`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value || {}).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function validateSnapshot(snapshot, label = 'snapshot') {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  assertExactKeys(
    snapshot,
    [
      'capturedAt',
      'coverage',
      'format',
      'migrationState',
      'phase',
      'protectedData',
      'schemaState',
      'source',
      'target',
      'version'
    ],
    label
  );
  assertExactKeys(snapshot.target, ['environment', 'projectRef'], `${label}.target`);
  assertExactKeys(
    snapshot.source,
    ['gitBranch', 'gitCommit', 'workingTreeClean'],
    `${label}.source`
  );
  assertExactKeys(
    snapshot.coverage,
    [
      'discoveredSchemas',
      'explicitTables',
      'protectedTableCount',
      'rowFingerprintAlgorithm'
    ],
    `${label}.coverage`
  );
  assertExactKeys(
    snapshot.migrationState,
    ['fingerprint', 'versions'],
    `${label}.migrationState`
  );
  assertExactKeys(
    snapshot.schemaState,
    ['algorithm', 'fingerprint', 'tables'],
    `${label}.schemaState`
  );
  assertExactKeys(
    snapshot.protectedData,
    ['tableCount', 'tables'],
    `${label}.protectedData`
  );
  if (snapshot.format !== SNAPSHOT_FORMAT || snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(`${label} uses an unsupported release-integrity snapshot format.`);
  }
  if (!['pre', 'post'].includes(snapshot.phase)) {
    throw new Error(`${label}.phase must be pre or post.`);
  }
  if (!Number.isFinite(Date.parse(snapshot.capturedAt))) {
    throw new Error(`${label}.capturedAt must be an ISO timestamp.`);
  }
  if (!['dev', 'prod'].includes(snapshot.target?.environment)) {
    throw new Error(`${label}.target.environment must be dev or prod.`);
  }
  if (!/^[a-z0-9]{10,40}$/.test(asText(snapshot.target?.projectRef))) {
    throw new Error(`${label}.target.projectRef is invalid.`);
  }
  if (snapshot.target.projectRef !== TARGET_REFS[snapshot.target.environment]) {
    throw new Error(`${label}.target.projectRef does not match its environment.`);
  }
  if (
    JSON.stringify(snapshot.coverage?.discoveredSchemas) !==
      JSON.stringify(PROTECTED_SCOPE.discoveredSchemas) ||
    JSON.stringify(snapshot.coverage?.explicitTables) !==
      JSON.stringify(PROTECTED_SCOPE.explicitTables)
  ) {
    throw new Error(`${label} uses unsupported protected-table coverage.`);
  }
  if (snapshot.coverage?.rowFingerprintAlgorithm !== ROW_FINGERPRINT_ALGORITHM) {
    throw new Error(`${label} uses an unsupported row fingerprint algorithm.`);
  }
  if (snapshot.schemaState?.algorithm !== SCHEMA_FINGERPRINT_ALGORITHM) {
    throw new Error(`${label} uses an unsupported schema fingerprint algorithm.`);
  }
  assertFingerprint(snapshot.schemaState?.fingerprint, `${label}.schemaState.fingerprint`);
  assertFingerprint(snapshot.migrationState?.fingerprint, `${label}.migrationState.fingerprint`);

  if (!Array.isArray(snapshot.migrationState?.versions)) {
    throw new Error(`${label}.migrationState.versions must be an array.`);
  }
  for (const version of snapshot.migrationState.versions) {
    if (!/^[0-9]{8,20}$/.test(asText(version))) {
      throw new Error(`${label} contains an invalid migration version.`);
    }
  }
  if (
    new Set(snapshot.migrationState.versions).size !== snapshot.migrationState.versions.length ||
    JSON.stringify(snapshot.migrationState.versions) !==
      JSON.stringify([...snapshot.migrationState.versions].sort())
  ) {
    throw new Error(`${label}.migrationState.versions must be unique and sorted.`);
  }
  if (snapshot.migrationState.fingerprint !== sha256(snapshot.migrationState.versions.join('\n'))) {
    throw new Error(`${label}.migrationState.fingerprint does not match its versions.`);
  }

  const sectionNames = {};
  for (const [sectionName, rows] of [
    ['schemaState.tables', snapshot.schemaState?.tables],
    ['protectedData.tables', snapshot.protectedData?.tables]
  ]) {
    if (!Array.isArray(rows)) {
      throw new Error(`${label}.${sectionName} must be an array.`);
    }
    const names = new Set();
    for (const row of rows) {
      assertExactKeys(
        row,
        sectionName === 'schemaState.tables'
          ? ['columnCount', 'fingerprint', 'name']
          : ['fingerprint', 'name', 'rowCount'],
        `${label}.${sectionName}`
      );
      assertTableName(row?.name, `${label}.${sectionName}.name`);
      if (names.has(row.name)) {
        throw new Error(`${label}.${sectionName} contains duplicate table ${row.name}.`);
      }
      names.add(row.name);
      assertFingerprint(row?.fingerprint, `${label}.${sectionName}.${row.name}.fingerprint`);
      if (
        sectionName === 'schemaState.tables' &&
        (!Number.isSafeInteger(row.columnCount) || row.columnCount < 1)
      ) {
        throw new Error(`${label}.${sectionName}.${row.name}.columnCount is invalid.`);
      }
      if (
        sectionName === 'protectedData.tables' &&
        (!Number.isSafeInteger(row.rowCount) || row.rowCount < 0)
      ) {
        throw new Error(`${label}.${sectionName}.${row.name}.rowCount is invalid.`);
      }
    }
    const orderedNames = rows.map((row) => row.name);
    if (JSON.stringify(orderedNames) !== JSON.stringify([...orderedNames].sort())) {
      throw new Error(`${label}.${sectionName} must be sorted by table name.`);
    }
    sectionNames[sectionName] = orderedNames;
  }
  if (
    JSON.stringify(sectionNames['schemaState.tables']) !==
    JSON.stringify(sectionNames['protectedData.tables'])
  ) {
    throw new Error(`${label} schema and protected-data table coverage differ.`);
  }
  if (!sectionNames['protectedData.tables'].some((name) => name.startsWith('app.'))) {
    throw new Error(`${label} contains no protected app schema tables.`);
  }
  for (const explicitTable of PROTECTED_SCOPE.explicitTables) {
    if (!sectionNames['protectedData.tables'].includes(explicitTable)) {
      throw new Error(`${label} is missing protected table ${explicitTable}.`);
    }
  }
  if (
    snapshot.coverage.protectedTableCount !== sectionNames['protectedData.tables'].length ||
    snapshot.protectedData?.tableCount !== sectionNames['protectedData.tables'].length
  ) {
    throw new Error(`${label} protected table counts do not match coverage.`);
  }
  const expectedSchemaFingerprint = sha256(
    snapshot.schemaState.tables.map((table) => `${table.name}:${table.fingerprint}`).join('\n')
  );
  if (snapshot.schemaState.fingerprint !== expectedSchemaFingerprint) {
    throw new Error(`${label}.schemaState.fingerprint does not match its table metadata.`);
  }
  return snapshot;
}

async function discoverProtectedTables(client) {
  const result = await client.query(`
    select n.nspname as schema_name, c.relname as table_name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and (
        n.nspname = 'app'
        or (n.nspname = 'auth' and c.relname = 'users')
      )
    order by n.nspname, c.relname
  `);
  const tables = result.rows.map((row) => ({
    schema: asText(row.schema_name),
    table: asText(row.table_name)
  }));
  if (!tables.some((table) => table.schema === 'app')) {
    throw new Error('Protected table discovery found no app schema tables.');
  }
  if (!tables.some((table) => table.schema === 'auth' && table.table === 'users')) {
    throw new Error('Protected table discovery could not find auth.users.');
  }
  return tables;
}

async function assertTableReadable(client, table) {
  const name = tableKey(table);
  const result = await client.query(
    `select has_table_privilege(current_user, $1, 'SELECT') as can_select`,
    [name]
  );
  if (result.rows[0]?.can_select !== true) {
    throw new Error(`The database credential cannot read protected table ${name}.`);
  }
}

async function captureTableSchema(client, table) {
  const name = tableKey(table);
  const result = await client.query(
    `
      select
        a.attnum as ordinal,
        a.attname as column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
        a.attnotnull as not_null,
        a.attidentity as identity_kind,
        a.attgenerated as generated_kind,
        coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') as default_expression,
        coalesce(coll.collname, '') as collation_name
      from pg_catalog.pg_attribute a
      left join pg_catalog.pg_attrdef d
        on d.adrelid = a.attrelid
       and d.adnum = a.attnum
      left join pg_catalog.pg_collation coll on coll.oid = a.attcollation
      where a.attrelid = pg_catalog.to_regclass($1)
        and a.attnum > 0
        and not a.attisdropped
      order by a.attnum
    `,
    [name]
  );
  if (result.rows.length === 0) {
    throw new Error(`Protected table ${name} has no visible columns.`);
  }
  return {
    name,
    columnCount: result.rows.length,
    fingerprint: sha256(JSON.stringify(result.rows))
  };
}

async function captureTableRows(client, table, cursorIndex, batchSize = 1000) {
  const name = tableKey(table);
  const cursorName = quoteIdentifier(`release_integrity_${cursorIndex}`);
  const qualifiedName = qualifiedTableName(table);
  await client.query(`
    declare ${cursorName} no scroll cursor for
    select pg_catalog.md5(pg_catalog.to_jsonb(source_row)::text) as row_hash
    from ${qualifiedName} as source_row
    order by 1
  `);

  const hash = crypto.createHash('sha256');
  let rowCount = 0;
  try {
    while (true) {
      const result = await client.query(`fetch forward ${batchSize} from ${cursorName}`);
      if (result.rows.length === 0) {
        break;
      }
      for (const row of result.rows) {
        if (!/^[a-f0-9]{32}$/.test(asText(row.row_hash))) {
          throw new Error(`Database returned an invalid row hash for ${name}.`);
        }
        hash.update(row.row_hash);
        hash.update('\n');
        rowCount += 1;
      }
    }
  } finally {
    await client.query(`close ${cursorName}`);
  }

  return {
    name,
    rowCount,
    fingerprint: `sha256:${hash.digest('hex')}`
  };
}

async function captureMigrationState(client) {
  const exists = await client.query(
    `select pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null as present`
  );
  if (exists.rows[0]?.present !== true) {
    throw new Error('supabase_migrations.schema_migrations is not available.');
  }
  const result = await client.query(`
    select version::text as version
    from supabase_migrations.schema_migrations
    order by version::text
  `);
  const versions = result.rows.map((row) => asText(row.version));
  return {
    versions,
    fingerprint: sha256(versions.join('\n'))
  };
}

async function captureDatabaseState(client, { batchSize = 1000 } = {}) {
  const readOnly = await client.query(`show transaction_read_only`);
  if (asText(readOnly.rows[0]?.transaction_read_only).toLowerCase() !== 'on') {
    throw new Error('Database transaction_read_only is not on; snapshot aborted.');
  }

  const tables = await discoverProtectedTables(client);
  const schemaTables = [];
  const protectedTables = [];
  for (let index = 0; index < tables.length; index += 1) {
    const table = tables[index];
    await assertTableReadable(client, table);
    schemaTables.push(await captureTableSchema(client, table));
    protectedTables.push(await captureTableRows(client, table, index, batchSize));
  }
  const migrationState = await captureMigrationState(client);
  return {
    migrationState,
    schemaState: {
      algorithm: SCHEMA_FINGERPRINT_ALGORITHM,
      fingerprint: sha256(schemaTables.map((table) => `${table.name}:${table.fingerprint}`).join('\n')),
      tables: schemaTables
    },
    protectedData: {
      tables: protectedTables
    }
  };
}

function buildSnapshot({ phase, target, source, databaseState, capturedAt = new Date().toISOString() }) {
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    capturedAt,
    phase,
    target: {
      environment: target.environment,
      projectRef: target.projectRef
    },
    source: {
      gitCommit: asText(source?.gitCommit) || 'unknown',
      gitBranch: asText(source?.gitBranch) || 'unknown',
      workingTreeClean: source?.workingTreeClean === true
    },
    coverage: {
      discoveredSchemas: [...PROTECTED_SCOPE.discoveredSchemas],
      explicitTables: [...PROTECTED_SCOPE.explicitTables],
      rowFingerprintAlgorithm: ROW_FINGERPRINT_ALGORITHM,
      protectedTableCount: databaseState.protectedData.tables.length
    },
    migrationState: databaseState.migrationState,
    schemaState: databaseState.schemaState,
    protectedData: {
      tableCount: databaseState.protectedData.tables.length,
      tables: databaseState.protectedData.tables
    }
  };
  return validateSnapshot(snapshot);
}

function mapByName(rows = []) {
  return new Map(rows.map((row) => [row.name, row]));
}

function compareNamedFingerprints(beforeRows, afterRows, countKey) {
  const beforeByName = mapByName(beforeRows);
  const afterByName = mapByName(afterRows);
  const names = Array.from(new Set([...beforeByName.keys(), ...afterByName.keys()])).sort();
  const changes = [];
  for (const name of names) {
    const before = beforeByName.get(name);
    const after = afterByName.get(name);
    if (before?.fingerprint === after?.fingerprint && before?.[countKey] === after?.[countKey]) {
      continue;
    }
    changes.push({
      name,
      beforeCount: before?.[countKey] ?? null,
      afterCount: after?.[countKey] ?? null,
      fingerprintChanged: before?.fingerprint !== after?.fingerprint,
      changeType: !before ? 'added' : !after ? 'removed' : 'changed'
    });
  }
  return changes;
}

function compareMigrationVersions(beforeVersions, afterVersions) {
  const before = new Set(beforeVersions);
  const after = new Set(afterVersions);
  return {
    added: Array.from(after).filter((version) => !before.has(version)).sort(),
    removed: Array.from(before).filter((version) => !after.has(version)).sort()
  };
}

function compareSnapshots(beforeInput, afterInput, options = {}) {
  const before = validateSnapshot(beforeInput, 'before snapshot');
  const after = validateSnapshot(afterInput, 'after snapshot');
  const policy = asText(options.policy || 'strict').toLowerCase();
  if (!['strict', 'observe'].includes(policy)) {
    throw new Error('Comparison policy must be strict or observe.');
  }
  if (before.phase !== 'pre' || after.phase !== 'post') {
    throw new Error('Comparison requires a pre snapshot followed by a post snapshot.');
  }
  if (Date.parse(before.capturedAt) >= Date.parse(after.capturedAt)) {
    throw new Error('Comparison requires the pre snapshot to be captured before the post snapshot.');
  }

  const hardFailures = [];
  if (before.target.environment !== after.target.environment) {
    hardFailures.push('Target environment mismatch.');
  }
  if (before.target.projectRef !== after.target.projectRef) {
    hardFailures.push('Target project ref mismatch.');
  }
  if (JSON.stringify(before.coverage.discoveredSchemas) !== JSON.stringify(after.coverage.discoveredSchemas)) {
    hardFailures.push('Protected schema coverage mismatch.');
  }
  if (JSON.stringify(before.coverage.explicitTables) !== JSON.stringify(after.coverage.explicitTables)) {
    hardFailures.push('Explicit protected table coverage mismatch.');
  }

  const dataChanges = compareNamedFingerprints(
    before.protectedData.tables,
    after.protectedData.tables,
    'rowCount'
  );
  const schemaChanges = compareNamedFingerprints(
    before.schemaState.tables,
    after.schemaState.tables,
    'columnCount'
  );
  const migrationChanges = compareMigrationVersions(
    before.migrationState.versions,
    after.migrationState.versions
  );
  const allowedTables = normalizeStringSet(options.allowedTables);
  const allowedSchemaTables = normalizeStringSet(options.allowedSchemaTables);
  const allowedMigrations = normalizeStringSet(options.allowedMigrations);
  const unapprovedDataChanges = dataChanges.filter((change) => !allowedTables.has(change.name));
  const unapprovedSchemaChanges = schemaChanges.filter(
    (change) => !allowedSchemaTables.has(change.name)
  );
  const allMigrationChanges = [...migrationChanges.added, ...migrationChanges.removed];
  const unapprovedMigrationChanges = allMigrationChanges.filter(
    (version) => !allowedMigrations.has(version)
  );
  const hasChanges =
    dataChanges.length > 0 ||
    schemaChanges.length > 0 ||
    allMigrationChanges.length > 0;

  let status = 'pass';
  let exitCode = 0;
  if (hardFailures.length > 0) {
    status = 'failed';
    exitCode = 1;
  } else if (policy === 'observe' && hasChanges) {
    status = 'review-required';
    exitCode = 2;
  } else if (
    policy === 'strict' &&
    (unapprovedDataChanges.length > 0 ||
      unapprovedSchemaChanges.length > 0 ||
      unapprovedMigrationChanges.length > 0)
  ) {
    status = 'failed';
    exitCode = 1;
  }

  return {
    policy,
    status,
    exitCode,
    target: before.target,
    hardFailures,
    changes: {
      data: dataChanges,
      schema: schemaChanges,
      migrations: migrationChanges
    },
    unapproved: {
      data: unapprovedDataChanges.map((change) => change.name),
      schema: unapprovedSchemaChanges.map((change) => change.name),
      migrations: unapprovedMigrationChanges
    }
  };
}

export {
  PROTECTED_SCOPE,
  ROW_FINGERPRINT_ALGORITHM,
  SCHEMA_FINGERPRINT_ALGORITHM,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  buildSnapshot,
  captureDatabaseState,
  compareSnapshots,
  normalizeStringSet,
  quoteIdentifier,
  sha256,
  validateSnapshot
};
