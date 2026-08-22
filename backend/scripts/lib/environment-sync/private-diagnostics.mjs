import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  openPrivateFileExclusive,
  privateArtifactPath,
  verifyPrivateArtifactProtection
} from './private-artifacts.mjs';

const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;

function categoricalError(code, safeDiagnostic = undefined) {
  const error = new Error(code);
  error.code = code;
  if (safeDiagnostic) error.safeDiagnostic = safeDiagnostic;
  return error;
}

function sanitizePostgresDiagnostic(value) {
  let text = String(value || '');
  text = text
    .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '<database-url>')
    .replace(/\b(?:password|passwd|pwd|token|secret|apikey|api_key|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer <redacted>')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '<token>')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/gi, '<id>')
    .replace(/\b(psql|pg_restore|pg_dump):\/[^:\r\n]+/gi, '$1:<private-path>')
    .replace(/[A-Za-z]:[\\/][^\r\n:'"<>|]+/g, '<private-path>')
    .replace(/\b(?:db\.)?[a-z0-9]{20}\.supabase\.co\b/gi, '<managed-db-host>')
    .replace(/\b[a-z0-9]{20}\.supabase\.co\b/gi, '<managed-host>');

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Command was:/i.test(line));
  const failures = lines.filter((line) =>
    /(?:^|\b)(?:ERROR|FATAL|PANIC|DETAIL|HINT|CONTEXT):|pg_(?:restore|dump):\s*error|psql:.*(?:ERROR|FATAL)|must be owner|permission denied|violates/i.test(line)
  );
  const stages = lines.filter((line) => /MANAGED_OVERLAY_STAGE_/i.test(line)).reverse();
  const ordered = [...new Set([...failures, ...stages, ...lines])].slice(0, 24);
  const sanitized = ordered.join('\n').slice(0, 8192);
  let classification = 'POSTGRES_CHILD_FAILED';
  let sqlState = '';
  if (/must be owner of/i.test(sanitized)) {
    classification = 'POSTGRES_MANAGED_OWNERSHIP_REJECTED';
    sqlState = '42501';
  } else if (/permission denied|insufficient privilege/i.test(sanitized)) {
    classification = 'POSTGRES_INSUFFICIENT_PRIVILEGE';
    sqlState = '42501';
  } else if (/role .* does not exist/i.test(sanitized)) {
    classification = 'POSTGRES_ROLE_REFERENCE_REJECTED';
    sqlState = '42704';
  } else if (/already exists|duplicate object/i.test(sanitized)) {
    classification = 'POSTGRES_TARGET_OBJECT_COLLISION';
    sqlState = '42710';
  } else if (/foreign key constraint|violates foreign key/i.test(sanitized)) {
    classification = 'POSTGRES_RELATIONAL_INTEGRITY_REJECTED';
    sqlState = '23503';
  }
  return {
    classification,
    sqlState,
    excerpt: sanitized || 'PostgreSQL child failed without a diagnostic message.'
  };
}

function writeDiagnosticChunk(descriptor, label, chunk, state) {
  if (state.overflow) return;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const prefix = Buffer.from(`\n[${label}]\n`, 'utf8');
  try {
    const nextSize = state.bytes + prefix.length + bytes.length;
    if (nextSize > MAX_DIAGNOSTIC_BYTES) {
      state.overflow = true;
      return;
    }
    fs.writeSync(descriptor, prefix);
    fs.writeSync(descriptor, bytes);
    state.bytes = nextSize;
  } finally {
    prefix.fill(0);
  }
}

async function runPrivateDiagnosticCommand({
  executable,
  args = [],
  env = {},
  cwd,
  inputPath = '',
  inputStream: suppliedInputStream,
  inputBuffer,
  diagnosticDirectory,
  failureCode = 'POSTGRES_CHILD_FAILED',
  onFailureDiagnostic
} = {}) {
  if (!String(executable || '').trim() || !String(diagnosticDirectory || '').trim()) {
    throw categoricalError('PRIVATE_DIAGNOSTIC_CONFIGURATION_INVALID');
  }
  const artifactPath = privateArtifactPath(
    diagnosticDirectory,
    `postgres-diagnostic-${crypto.randomBytes(16).toString('hex')}.tmp`
  );
  const { descriptor } = openPrivateFileExclusive(artifactPath);
  const state = { bytes: 0, overflow: false };
  let inputStream;
  let raw;
  let child;
  try {
    child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => writeDiagnosticChunk(descriptor, 'stdout', chunk, state));
    child.stderr.on('data', (chunk) => writeDiagnosticChunk(descriptor, 'stderr', chunk, state));
    child.stdin.on('error', () => {});
    if (suppliedInputStream) {
      inputStream = suppliedInputStream;
      inputStream.on('error', () => child.stdin.destroy());
      inputStream.pipe(child.stdin);
    } else if (inputPath) {
      inputStream = fs.createReadStream(inputPath);
      inputStream.on('error', () => child.stdin.destroy());
      inputStream.pipe(child.stdin);
    } else if (inputBuffer !== undefined) {
      child.stdin.end(inputBuffer);
    } else {
      child.stdin.end();
    }
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    if (state.overflow && child.exitCode === null && child.signalCode === null) child.kill();
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    verifyPrivateArtifactProtection(artifactPath);
    raw = fs.readFileSync(artifactPath);
    const safeDiagnostic = sanitizePostgresDiagnostic(raw.toString('utf8'));
    if (code !== 0 || signal || state.overflow) {
      if (typeof onFailureDiagnostic === 'function') {
        await onFailureDiagnostic({ safeDiagnostic, artifactPath, overflow: state.overflow });
      }
      throw categoricalError(failureCode, safeDiagnostic);
    }
    return { ok: true, safeDiagnostic, privateFailureArtifactRetained: false };
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (error?.code === failureCode) throw error;
    throw categoricalError(failureCode, sanitizePostgresDiagnostic(error?.message));
  } finally {
    inputStream?.destroy();
    try { fs.closeSync(descriptor); } catch {}
    if (raw) raw.fill(0);
    if (Buffer.isBuffer(inputBuffer)) inputBuffer.fill(0);
    fs.rmSync(artifactPath, { force: true });
  }
}

export {
  MAX_DIAGNOSTIC_BYTES,
  runPrivateDiagnosticCommand,
  sanitizePostgresDiagnostic
};
