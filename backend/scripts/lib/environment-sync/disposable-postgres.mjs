import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import pg from 'pg';

import {
  createPrivateDirectory,
  protectPrivateArtifact,
  verifyPrivateArtifactProtection
} from './private-artifacts.mjs';

const { Client } = pg;

const SUPABASE_ROLES = Object.freeze([
  'anon',
  'authenticated',
  'authenticator',
  'dashboard_user',
  'pgbouncer',
  'service_role',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_read_only_user',
  'supabase_storage_admin'
]);

function executable(binDirectory, name) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidate = path.join(binDirectory, `${name}${suffix}`);
  if (!fs.existsSync(candidate)) throw new Error('LOCAL_POSTGRES_TOOLING_UNAVAILABLE');
  return candidate;
}

function resolvePostgresTools(explicitBin = '') {
  const candidates = [
    explicitBin,
    process.env.POSTGRES_BIN,
    process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : '/usr/lib/postgresql/18/bin'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const serverCatalog = path.resolve(candidate, '..', 'share', 'postgres.bki');
      if (!fs.existsSync(serverCatalog)) throw new Error('server catalog unavailable');
      return {
        bin: candidate,
        initdb: executable(candidate, 'initdb'),
        pgCtl: executable(candidate, 'pg_ctl'),
        pgDump: executable(candidate, 'pg_dump'),
        pgRestore: executable(candidate, 'pg_restore')
      };
    } catch {}
  }
  throw new Error('LOCAL_POSTGRES_TOOLING_UNAVAILABLE');
}

async function availableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function privateChildEnvironment() {
  return {
    SystemRoot: process.env.SystemRoot || '',
    WINDIR: process.env.WINDIR || '',
    PATH: process.env.PATH || '',
    TEMP: process.env.TEMP || '',
    TMP: process.env.TMP || '',
    LANG: 'C',
    LC_ALL: 'C'
  };
}

function run(executablePath, args, options = {}) {
  return execFileSync(executablePath, args, {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
    env: privateChildEnvironment(),
    ...options
  });
}

function assertDisposableRoot(rootDirectory, logPath = '') {
  const resolvedRoot = path.resolve(rootDirectory);
  if (!/^environment-sync-rehearsal-(?:source-)?[a-f0-9]{12,16}$/.test(path.basename(resolvedRoot))) {
    throw new Error('DISPOSABLE_POSTGRES_PATH_REJECTED');
  }
  if (logPath) {
    const expectedLog = path.resolve(logPath);
    if (path.dirname(expectedLog) !== resolvedRoot || path.basename(expectedLog) !== 'postgres.log') {
      throw new Error('DISPOSABLE_POSTGRES_LOG_PATH_REJECTED');
    }
  }
  return resolvedRoot;
}

function removeDisposableRootFiles(rootDirectory, logPath) {
  const resolvedRoot = assertDisposableRoot(rootDirectory, logPath);
  const expectedLog = path.resolve(logPath);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      if (fs.existsSync(resolvedRoot)) {
        if (fs.existsSync(expectedLog)) fs.unlinkSync(expectedLog);
        fs.rmSync(resolvedRoot, { recursive: true, force: false });
        if (fs.existsSync(resolvedRoot) && fs.readdirSync(resolvedRoot).length === 0) {
          fs.rmdirSync(resolvedRoot);
        }
      }
    } catch {
      // Windows can retain a just-closed log handle briefly; retry only this exact guarded root.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    if (!fs.existsSync(resolvedRoot)) return true;
  }
  return false;
}

async function startDisposablePostgres({ rootDirectory, postgresBin = '' } = {}) {
  const tools = resolvePostgresTools(postgresBin);
  const root = assertDisposableRoot(rootDirectory);
  if (fs.existsSync(root)) throw new Error('DISPOSABLE_POSTGRES_ROOT_COLLISION');
  const dataDirectory = path.join(root, 'cluster');
  const logPath = path.join(root, 'postgres.log');
  let rootCreated = false;
  let port;
  try {
    createPrivateDirectory(root);
    rootCreated = true;
    const descriptor = fs.openSync(logPath, 'wx', 0o600);
    fs.closeSync(descriptor);
    protectPrivateArtifact(logPath);
    port = await availableLoopbackPort();
    run(tools.initdb, [
      '--pgdata', dataDirectory,
      '--encoding=UTF8',
      '--locale=C',
      '--auth=trust',
      '--username=postgres',
      '--no-sync'
    ]);
    run(tools.pgCtl, [
      '--pgdata', dataDirectory,
      '--log', logPath,
      '--wait',
      '--timeout', '30',
      'start',
      '--options', `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c fsync=on -c synchronous_commit=on`
    ]);
    verifyPrivateArtifactProtection(logPath);
  } catch {
    if (!rootCreated) throw new Error('DISPOSABLE_POSTGRES_START_FAILED_WITH_RESIDUE');
    const processMarker = path.join(dataDirectory, 'postmaster.pid');
    if (fs.existsSync(processMarker)) {
      try {
        run(tools.pgCtl, [
          '--pgdata', dataDirectory,
          '--wait',
          '--timeout', '30',
          'stop',
          '--mode', 'immediate'
        ]);
      } catch {
        throw new Error('DISPOSABLE_POSTGRES_START_FAILED_WITH_RESIDUE');
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    if (!removeDisposableRootFiles(root, logPath)) {
      throw new Error('DISPOSABLE_POSTGRES_START_FAILED_WITH_RESIDUE');
    }
    throw new Error('DISPOSABLE_POSTGRES_START_FAILED');
  }
  const baseUrl = `postgresql://postgres@127.0.0.1:${port}`;
  return {
    tools,
    root,
    dataDirectory,
    logPath,
    port,
    baseUrl,
    connectionString(database = 'postgres') {
      return `${baseUrl}/${encodeURIComponent(database)}?sslmode=disable`;
    },
    async stop() {
      try {
        run(tools.pgCtl, ['--pgdata', dataDirectory, '--wait', '--timeout', '30', 'stop', '--mode', 'immediate']);
      } catch {
        throw new Error('DISPOSABLE_POSTGRES_STOP_FAILED');
      }
    }
  };
}

async function withClient(connectionString, callback, options = {}) {
  const client = new Client({ connectionString, ...options });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function prepareRestoreDatabase(cluster, databaseName) {
  if (!/^x_rehearsal_(?:dev|sandbox)_[a-z0-9_]{1,48}$/.test(databaseName)) {
    throw new Error('DISPOSABLE_DATABASE_NAME_INVALID');
  }
  await withClient(cluster.connectionString(), async (client) => {
    for (const role of SUPABASE_ROLES) {
      await client.query(`do $block$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role "${role}" nologin; end if; end $block$`);
    }
    await client.query(`create database "${databaseName}"`);
  });
  await withClient(cluster.connectionString(databaseName), async (client) => {
    await client.query('create schema if not exists extensions');
    await client.query('create extension if not exists pgcrypto with schema extensions');
  });
  return cluster.connectionString(databaseName);
}

async function removeDisposablePostgres(cluster) {
  await cluster.stop();
  // pg_ctl can return before its Windows log-forwarding handle has fully closed.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  if (!removeDisposableRootFiles(cluster.root, cluster.logPath)) {
    throw new Error('DISPOSABLE_POSTGRES_TEARDOWN_FAILED');
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  if (fs.existsSync(path.resolve(cluster.root))) throw new Error('DISPOSABLE_POSTGRES_TEARDOWN_FAILED');
}

export {
  SUPABASE_ROLES,
  assertDisposableRoot,
  prepareRestoreDatabase,
  removeDisposablePostgres,
  resolvePostgresTools,
  startDisposablePostgres,
  withClient
};
