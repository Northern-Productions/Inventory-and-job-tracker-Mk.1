import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertApplicationRoutineDefaultSecurity,
  captureApplicationRoutineDefaultSecurity
} from './application-routine-default-security.mjs';

const backendMigrationUrl = new URL(
  '../../migrations/0204_global_function_default_execute_hardening.sql',
  import.meta.url
);
const supabaseMigrationUrl = new URL(
  '../../../supabase/migrations/20260823100000_global_function_default_execute_hardening.sql',
  import.meta.url
);
const historicalMigrationUrl = new URL(
  '../../migrations/0102_public_rpc_authenticated_permission_hardening.sql',
  import.meta.url
);

function resolvePostgresBin() {
  const toolchainRoot = path.join(os.homedir(), '.codex', 'toolchains');
  const portableCandidates = existsSync(toolchainRoot)
    ? readdirSync(toolchainRoot)
        .filter((entry) => /^postgresql-(?:18|17)[-.]/.test(entry))
        .sort()
        .reverse()
        .map((entry) => path.join(toolchainRoot, entry, 'pgsql', 'bin'))
    : [];
  const candidates = [
    process.env.POSTGRES_BIN,
    ...portableCandidates,
    process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : undefined,
    process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin' : undefined,
    '/usr/lib/postgresql/18/bin',
    '/usr/lib/postgresql/17/bin'
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      if (!existsSync(path.resolve(candidate, '..', 'share', 'postgres.bki'))) return false;
      execFileSync(path.join(candidate, process.platform === 'win32' ? 'initdb.exe' : 'initdb'), ['--version'], {
        stdio: 'ignore'
      });
      return true;
    } catch {
      return false;
    }
  });
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error('DISPOSABLE_POSTGRES_PORT_UNAVAILABLE');
  return port;
}

function executable(bin, name) {
  return path.join(bin, process.platform === 'win32' ? `${name}.exe` : name);
}

async function privilegeState(client, signature) {
  return (
    await client.query(
      `select
         has_function_privilege('public', $1::regprocedure, 'EXECUTE') as public_execute,
         has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_execute,
         has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authenticated_execute,
         has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role_execute,
         has_function_privilege('postgres', $1::regprocedure, 'EXECUTE') as owner_execute`,
      [signature]
    )
  ).rows[0];
}

async function invokeAs(client, role, sql, expectedValue) {
  await client.query(`set role ${role}`);
  try {
    const result = await client.query(sql);
    assert.equal(result.rows[0].value, expectedValue);
  } finally {
    await client.query('reset role');
  }
}

async function rejectAs(client, role, sql) {
  await client.query(`set role ${role}`);
  try {
    await assert.rejects(client.query(sql), /permission denied for function/i);
  } finally {
    await client.query('reset role');
  }
}

test('0204 migration mirrors are exact and encode the reviewed forward-only contract', () => {
  const backend = readFileSync(backendMigrationUrl, 'utf8');
  const supabase = readFileSync(supabaseMigrationUrl, 'utf8');
  const historical = readFileSync(historicalMigrationUrl, 'utf8');

  assert.equal(supabase, backend);
  assert.match(
    historical,
    /alter default privileges in schema public revoke execute on functions from public;/i
  );
  assert.match(
    backend,
    /alter default privileges for role postgres\s+revoke execute on functions from public;/i
  );
  assert.match(
    backend,
    /alter default privileges for role postgres in schema public, app, app_api\s+revoke execute on functions from public, anon, authenticated, service_role;/i
  );
  assert.match(backend, /APPLICATION_ROUTINE_CREATOR_ROLE_UNRECOGNIZED/);
  assert.match(backend, /APPLICATION_ROUTINE_GLOBAL_DEFAULT_UNSAFE/);
  assert.match(backend, /APPLICATION_ROUTINE_SCHEMA_DEFAULT_UNSAFE/);
  assert.doesNotMatch(backend, /\b(grant|revoke)\s+execute\s+on\s+(function|procedure)\s+/i);
  assert.doesNotMatch(backend, /\b(create|alter|drop)\s+(table|sequence|type|schema)\b/i);
});

test('semantic guard rejects missing, exposed, grant-option, and wrong-creator contracts', () => {
  const safe = {
    ownerDistribution: [
      { schema_name: 'app', owner_role: 'postgres', routine_count: 1 },
      { schema_name: 'app_api', owner_role: 'postgres', routine_count: 1 },
      { schema_name: 'public', owner_role: 'postgres', routine_count: 1 }
    ],
    functionDefaults: [
      {
        scope: '<global>',
        grantee: 'postgres',
        privilege_type: 'EXECUTE',
        is_grantable: false
      }
    ]
  };
  assert.equal(assertApplicationRoutineDefaultSecurity(safe), safe);
  assert.throws(
    () => assertApplicationRoutineDefaultSecurity({ ...safe, functionDefaults: [] }),
    { code: 'APPLICATION_ROUTINE_GLOBAL_DEFAULT_MISSING' }
  );
  assert.throws(
    () =>
      assertApplicationRoutineDefaultSecurity({
        ...safe,
        functionDefaults: [
          ...safe.functionDefaults,
          { scope: '<global>', grantee: 'PUBLIC', privilege_type: 'EXECUTE', is_grantable: false }
        ]
      }),
    { code: 'APPLICATION_ROUTINE_GLOBAL_DEFAULT_UNSAFE' }
  );
  assert.throws(
    () =>
      assertApplicationRoutineDefaultSecurity({
        ...safe,
        functionDefaults: [
          { ...safe.functionDefaults[0], is_grantable: true }
        ]
      }),
    { code: 'APPLICATION_ROUTINE_GLOBAL_DEFAULT_UNSAFE' }
  );
  assert.throws(
    () =>
      assertApplicationRoutineDefaultSecurity({
        ...safe,
        ownerDistribution: [
          ...safe.ownerDistribution,
          { schema_name: 'public', owner_role: 'alternate_creator', routine_count: 1 }
        ]
      }),
    { code: 'APPLICATION_ROUTINE_CREATOR_ROLE_UNRECOGNIZED' }
  );
});

const postgresBin = resolvePostgresBin();
test(
  'PostgreSQL proves the 0102 defect, 0204 closure, explicit exposure, role specificity, and table/sequence preservation',
  { timeout: 120_000, skip: postgresBin ? false : 'PostgreSQL 17+ binaries are unavailable.' },
  async () => {
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'global-function-default-'));
    const dataDirectory = path.join(temporaryRoot, 'data');
    const initdb = executable(postgresBin, 'initdb');
    const pgCtl = executable(postgresBin, 'pg_ctl');
    const port = await reserveLoopbackPort();
    let started = false;
    let client;
    try {
      execFileSync(
        initdb,
        ['-D', dataDirectory, '--username=postgres', '--auth=trust', '--encoding=UTF8', '--no-locale'],
        { stdio: 'ignore' }
      );
      execFileSync(pgCtl, ['-D', dataDirectory, '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], {
        stdio: 'ignore'
      });
      started = true;
      client = new Client({
        connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
        application_name: 'global-function-default-security-test'
      });
      await client.connect();
      await client.query(`
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin;
        create role alternate_creator nologin;
        create schema app authorization postgres;
        create schema app_api authorization postgres;
        grant usage on schema public, app, app_api to anon, authenticated, service_role;
        alter default privileges for role postgres in schema public
          grant execute on functions to anon, authenticated, service_role;
        alter default privileges for role postgres in schema app
          grant select, insert, update, delete on tables to service_role;
        alter default privileges for role postgres in schema app
          grant usage, select on sequences to service_role;
      `);

      await client.query(
        'alter default privileges in schema public revoke execute on functions from public'
      );
      await client.query(
        'create function public.historical_schema_revoke_probe() returns integer language sql as $$ select 7 $$'
      );
      const historicalState = await privilegeState(
        client,
        'public.historical_schema_revoke_probe()'
      );
      assert.equal(historicalState.public_execute, true);
      assert.equal(historicalState.anon_execute, true);
      await invokeAs(
        client,
        'anon',
        'select public.historical_schema_revoke_probe() as value',
        7
      );

      const currentAclSql = `
        select
          namespace.nspname as schema_name,
          routine.oid::regprocedure::text as signature,
          owner.rolname as owner_role,
          coalesce(routine.proacl::text, '<null>') as acl
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        join pg_catalog.pg_roles owner on owner.oid = routine.proowner
        where namespace.nspname = any(array['public','app','app_api'])
          and not exists (
            select 1 from pg_catalog.pg_depend dependency
            where dependency.classid = 'pg_proc'::regclass
              and dependency.objid = routine.oid
              and dependency.deptype = 'e'
          )
        order by schema_name, signature
      `;
      const beforeAcl = (await client.query(currentAclSql)).rows;
      await client.query(readFileSync(backendMigrationUrl, 'utf8'));
      const afterAcl = (await client.query(currentAclSql)).rows;
      assert.deepEqual(afterAcl, beforeAcl);

      const contract = await captureApplicationRoutineDefaultSecurity(client);
      assert.equal(assertApplicationRoutineDefaultSecurity(contract), contract);

      await client.query(
        'create function public.closed_by_default_probe() returns integer language sql as $$ select 11 $$'
      );
      const closedState = await privilegeState(client, 'public.closed_by_default_probe()');
      assert.deepEqual(closedState, {
        public_execute: false,
        anon_execute: false,
        authenticated_execute: false,
        service_role_execute: false,
        owner_execute: true
      });
      await rejectAs(client, 'anon', 'select public.closed_by_default_probe() as value');
      await rejectAs(client, 'authenticated', 'select public.closed_by_default_probe() as value');
      await rejectAs(client, 'service_role', 'select public.closed_by_default_probe() as value');

      await client.query(
        'grant execute on function public.closed_by_default_probe() to authenticated'
      );
      const exposedState = await privilegeState(client, 'public.closed_by_default_probe()');
      assert.deepEqual(exposedState, {
        public_execute: false,
        anon_execute: false,
        authenticated_execute: true,
        service_role_execute: false,
        owner_execute: true
      });
      await invokeAs(
        client,
        'authenticated',
        'select public.closed_by_default_probe() as value',
        11
      );

      await client.query(`
        create table app.future_table_probe (id integer primary key);
        create sequence app.future_sequence_probe;
      `);
      const objectDefaults = (
        await client.query(`
          select
            has_table_privilege('service_role', 'app.future_table_probe', 'SELECT') as table_select,
            has_table_privilege('service_role', 'app.future_table_probe', 'INSERT') as table_insert,
            has_table_privilege('service_role', 'app.future_table_probe', 'UPDATE') as table_update,
            has_table_privilege('service_role', 'app.future_table_probe', 'DELETE') as table_delete,
            has_sequence_privilege('service_role', 'app.future_sequence_probe', 'USAGE') as sequence_usage,
            has_sequence_privilege('service_role', 'app.future_sequence_probe', 'SELECT') as sequence_select
        `)
      ).rows[0];
      assert.deepEqual(objectDefaults, {
        table_select: true,
        table_insert: true,
        table_update: true,
        table_delete: true,
        sequence_usage: true,
        sequence_select: true
      });

      await client.query('grant create on schema public to alternate_creator');
      await client.query('set role alternate_creator');
      try {
        await client.query(
          'create function public.wrong_creator_probe() returns integer language sql as $$ select 13 $$'
        );
      } finally {
        await client.query('reset role');
      }
      const wrongCreatorState = await privilegeState(client, 'public.wrong_creator_probe()');
      assert.equal(wrongCreatorState.public_execute, true);
      await assert.rejects(
        async () =>
          assertApplicationRoutineDefaultSecurity(
            await captureApplicationRoutineDefaultSecurity(client)
          ),
        { code: 'APPLICATION_ROUTINE_CREATOR_ROLE_UNRECOGNIZED' }
      );
    } finally {
      if (client) await client.end().catch(() => undefined);
      if (started) {
        execFileSync(pgCtl, ['-D', dataDirectory, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
);
