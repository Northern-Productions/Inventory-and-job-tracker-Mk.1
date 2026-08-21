import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

import {
  protectPrivateArtifact,
  verifyPrivateArtifactProtection,
  writePrivateBytesExclusive
} from './private-artifacts.mjs';

const MAGIC = Buffer.from('XREH001\0', 'ascii');
const WRAPPED_KEY_MAGIC = Buffer.from('XKEY001\0', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + NONCE_BYTES + TAG_BYTES;

function encryptBaselineBytes(bytes, key, nonce = crypto.randomBytes(NONCE_BYTES)) {
  const input = Buffer.from(bytes);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const output = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
  input.fill(0);
  encrypted.fill(0);
  return output;
}

function decryptBaselineBytes(bytes, key) {
  const input = Buffer.from(bytes);
  if (input.length < HEADER_BYTES || !input.subarray(0, MAGIC.length).equals(MAGIC)) {
    input.fill(0);
    throw categoricalError('BASELINE_ARTIFACT_FORMAT_INVALID');
  }
  const nonce = input.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const tag = input.subarray(MAGIC.length + NONCE_BYTES, HEADER_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(input.subarray(HEADER_BYTES)), decipher.final()]);
  } finally {
    input.fill(0);
  }
}

function wrapBaselineDataKey(dataKey, wrappingKey, nonce = crypto.randomBytes(NONCE_BYTES)) {
  if (dataKey?.length !== 32 || wrappingKey?.length !== 32) {
    throw categoricalError('BASELINE_KEY_LENGTH_INVALID');
  }
  const input = Buffer.from(dataKey);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce);
  try {
    const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
    try {
      return Buffer.concat([WRAPPED_KEY_MAGIC, nonce, cipher.getAuthTag(), encrypted]);
    } finally {
      encrypted.fill(0);
    }
  } finally {
    input.fill(0);
  }
}

function unwrapBaselineDataKey(bytes, wrappingKey) {
  const input = Buffer.from(bytes);
  if (
    wrappingKey?.length !== 32 ||
    input.length !== WRAPPED_KEY_MAGIC.length + NONCE_BYTES + TAG_BYTES + 32 ||
    !input.subarray(0, WRAPPED_KEY_MAGIC.length).equals(WRAPPED_KEY_MAGIC)
  ) {
    input.fill(0);
    throw categoricalError('BASELINE_WRAPPED_KEY_FORMAT_INVALID');
  }
  const nonceStart = WRAPPED_KEY_MAGIC.length;
  const tagStart = nonceStart + NONCE_BYTES;
  const payloadStart = tagStart + TAG_BYTES;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    wrappingKey,
    input.subarray(nonceStart, tagStart)
  );
  decipher.setAuthTag(input.subarray(tagStart, payloadStart));
  try {
    return Buffer.concat([decipher.update(input.subarray(payloadStart)), decipher.final()]);
  } catch {
    throw categoricalError('BASELINE_WRAPPED_KEY_AUTHENTICATION_FAILED');
  } finally {
    input.fill(0);
  }
}

function writeWrappedBaselineDataKey({ dataKey, wrappingKey, artifactPath } = {}) {
  const bytes = wrapBaselineDataKey(dataKey, wrappingKey);
  try {
    const durability = writePrivateBytesExclusive(artifactPath, bytes);
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    return {
      component: {
        name: 'postgres-data-key-wrapped',
        size: bytes.length,
        digest
      },
      protection: durability.protection,
      fileFsync: durability.fileFsync,
      directoryFsync: durability.directoryFsync
    };
  } finally {
    bytes.fill(0);
  }
}

function readWrappedBaselineDataKey({ wrappingKey, artifactPath } = {}) {
  verifyPrivateArtifactProtection(artifactPath);
  const bytes = fs.readFileSync(artifactPath);
  try {
    return unwrapBaselineDataKey(bytes, wrappingKey);
  } finally {
    bytes.fill(0);
  }
}

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseDatabaseConnection(connectionString) {
  let url;
  try {
    url = new URL(String(connectionString || ''));
  } catch {
    throw categoricalError('BASELINE_DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw categoricalError('BASELINE_DATABASE_URL_INVALID');
  }
  return {
    host: url.hostname,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslmode: url.searchParams.get('sslmode') || 'require'
  };
}

function postgresChildEnvironment(connectionString, additions = {}) {
  const connection = parseDatabaseConnection(connectionString);
  return {
    SystemRoot: process.env.SystemRoot || '',
    WINDIR: process.env.WINDIR || '',
    PATH: process.env.PATH || '',
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGDATABASE: connection.database,
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGSSLMODE: connection.sslmode,
    ...additions
  };
}

function runStreamingChild(executable, args, options = {}) {
  const child = spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options
  });
  let stderrBytes = 0;
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1024 * 1024) child.kill();
  });
  return child;
}

async function waitForChild(child, errorCode) {
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  if (code !== 0 || signal) throw categoricalError(errorCode);
}

async function captureEncryptedPgDump({
  pgDumpPath,
  connectionString,
  snapshotId,
  artifactPath,
  schemas = ['app', 'app_api', 'public', 'auth', 'supabase_migrations']
} = {}) {
  if (!String(snapshotId || '').trim()) throw categoricalError('BASELINE_SNAPSHOT_REQUIRED');
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const header = Buffer.concat([MAGIC, nonce, Buffer.alloc(TAG_BYTES)]);
  let descriptor;
  let child;
  let childWait;
  let completed = false;
  try {
    descriptor = fs.openSync(artifactPath, 'wx', 0o600);
    protectPrivateArtifact(artifactPath);
    fs.writeSync(descriptor, header, 0, header.length, 0);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const output = fs.createWriteStream(null, { fd: descriptor, start: HEADER_BYTES, autoClose: false });
    const args = [
      '--format=custom',
      '--no-owner',
      '--compress=6',
      `--snapshot=${snapshotId}`,
      ...schemas.flatMap((schema) => ['--schema', schema])
    ];
    child = runStreamingChild(pgDumpPath, args, {
      env: postgresChildEnvironment(connectionString, { PGOPTIONS: '-c statement_timeout=0' })
    });
    childWait = waitForChild(child, 'BASELINE_PG_DUMP_FAILED');
    try {
      await Promise.all([
        pipeline(child.stdout, cipher, output),
        childWait
      ]);
    } catch {
      throw categoricalError('BASELINE_PG_DUMP_FAILED');
    }
    const tag = cipher.getAuthTag();
    fs.writeSync(descriptor, tag, 0, tag.length, MAGIC.length + NONCE_BYTES);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    verifyPrivateArtifactProtection(artifactPath);
    const bytes = fs.readFileSync(artifactPath);
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    bytes.fill(0);
    completed = true;
    return {
      key,
      component: { name: 'postgres-logical-custom-encrypted', size: fs.statSync(artifactPath).size, digest },
      encryption: { algorithm: 'aes-256-gcm', format: 'x-rehearsal-encrypted-pgdump-v1' }
    };
  } catch {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (childWait) {
      try {
        await childWait;
      } catch {
        // The categorical capture error below is the only externally visible failure.
      }
    }
    key.fill(0);
    throw categoricalError('BASELINE_PG_DUMP_FAILED');
  } finally {
    header.fill(0);
    nonce.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!completed) fs.rmSync(artifactPath, { force: true });
  }
}

function readEncryptedHeader(artifactPath) {
  const descriptor = fs.openSync(artifactPath, 'r');
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw categoricalError('BASELINE_ARTIFACT_TRUNCATED');
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw categoricalError('BASELINE_ARTIFACT_FORMAT_INVALID');
    }
    return {
      nonce: Buffer.from(header.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES)),
      tag: Buffer.from(header.subarray(MAGIC.length + NONCE_BYTES, HEADER_BYTES))
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

async function restoreEncryptedPgDump({
  pgRestorePath,
  connectionString,
  artifactPath,
  key
} = {}) {
  verifyPrivateArtifactProtection(artifactPath);
  const connection = parseDatabaseConnection(connectionString);
  const { nonce, tag } = readEncryptedHeader(artifactPath);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const input = fs.createReadStream(artifactPath, { start: HEADER_BYTES });
  const child = runStreamingChild(pgRestorePath, ['--exit-on-error', '--no-owner', '--dbname', connection.database], {
    env: postgresChildEnvironment(connectionString, {
      PGOPTIONS: '-c check_function_bodies=off -c statement_timeout=0'
    })
  });
  const childWait = waitForChild(child, 'BASELINE_PG_RESTORE_FAILED');
  // The archive is supplied on stdin; libpq credentials remain process-only in PG* variables.
  child.stdin.on('error', () => {});
  try {
    await Promise.all([
      pipeline(input, decipher, child.stdin),
      childWait
    ]);
  } catch {
    input.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    try {
      await childWait;
    } catch {
      // Preserve the first categorical restore/decryption failure.
    }
    throw categoricalError('BASELINE_PG_RESTORE_FAILED');
  } finally {
    nonce.fill(0);
    tag.fill(0);
  }
  return { restored: true };
}

function verifyEncryptedComponent(component, artifactPath) {
  verifyPrivateArtifactProtection(artifactPath);
  const bytes = fs.readFileSync(artifactPath);
  try {
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    return component.size === bytes.length && component.digest === digest;
  } finally {
    bytes.fill(0);
  }
}

export {
  HEADER_BYTES,
  captureEncryptedPgDump,
  decryptBaselineBytes,
  encryptBaselineBytes,
  parseDatabaseConnection,
  postgresChildEnvironment,
  readWrappedBaselineDataKey,
  restoreEncryptedPgDump,
  unwrapBaselineDataKey,
  verifyEncryptedComponent,
  wrapBaselineDataKey,
  writeWrappedBaselineDataKey
};
