import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const FORMAT_PREFIX_BYTES = 512;
const FORMAT_READ_CHUNK_BYTES = 64;

function assertPathWithinRoot(filePath, allowedRoot) {
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(allowedRoot);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Release-integrity artifacts must stay inside the approved artifact directory.');
  }
  return resolvedPath;
}

function readFormatPrefix(filePath, { fsApi = fs } = {}) {
  const descriptor = fsApi.openSync(filePath, 'r');
  try {
    let prefix = '';
    let position = 0;
    while (position < FORMAT_PREFIX_BYTES) {
      const buffer = Buffer.alloc(
        Math.min(FORMAT_READ_CHUNK_BYTES, FORMAT_PREFIX_BYTES - position)
      );
      const bytesRead = fsApi.readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      prefix += buffer.subarray(0, bytesRead).toString('utf8');
      position += bytesRead;
      const format = prefix.match(/"format"\s*:\s*"([^"]+)"/)?.[1] || '';
      const versionText = prefix.match(/"version"\s*:\s*(\d+)/)?.[1] || '';
      if (format && versionText) {
        return { format, version: Number(versionText) };
      }
    }
    return { format: '', version: null };
  } finally {
    fsApi.closeSync(descriptor);
  }
}

function readCompatibleJson(
  filePath,
  { format, version, label = 'snapshot', maxBytes = DEFAULT_MAX_SNAPSHOT_BYTES, fsApi = fs } = {}
) {
  const stats = fsApi.statSync(filePath);
  if (stats.size > maxBytes) {
    throw new Error(`${label} is too large to be a release-integrity snapshot.`);
  }
  const metadata = readFormatPrefix(filePath, { fsApi });
  if (metadata.format !== format || metadata.version !== version) {
    throw new Error(
      `${label} fingerprint profile is incompatible with this tool; regenerate both snapshots.`
    );
  }
  return JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
}

function syncDirectoryBestEffort(directoryPath, fsApi) {
  let descriptor;
  try {
    descriptor = fsApi.openSync(directoryPath, 'r');
    fsApi.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      fsApi.closeSync(descriptor);
    }
  }
}

function writeJsonAtomic(
  filePath,
  value,
  { allowedRoot, fsApi = fs, uniqueId = () => crypto.randomUUID() } = {}
) {
  if (!allowedRoot) {
    throw new Error('An approved artifact directory is required.');
  }
  const finalPath = assertPathWithinRoot(filePath, allowedRoot);
  const directoryPath = path.dirname(finalPath);
  fsApi.mkdirSync(directoryPath, { recursive: true });
  if (fsApi.existsSync(finalPath)) {
    throw new Error(`Refusing to overwrite existing snapshot: ${finalPath}`);
  }

  const suffix = String(uniqueId());
  if (!/^[A-Za-z0-9-]+$/.test(suffix)) {
    throw new Error('Atomic snapshot temporary identifier is invalid.');
  }
  const tempPath = path.join(
    directoryPath,
    `.${path.basename(finalPath)}.${process.pid}.${suffix}.tmp`
  );
  let descriptor;
  try {
    descriptor = fsApi.openSync(tempPath, 'wx', 0o600);
    fsApi.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsApi.fsyncSync(descriptor);
    fsApi.closeSync(descriptor);
    descriptor = undefined;

    // Hard-link publication is atomic and refuses an existing destination on both POSIX and Windows.
    fsApi.linkSync(tempPath, finalPath);
    fsApi.unlinkSync(tempPath);
    syncDirectoryBestEffort(directoryPath, fsApi);
    return finalPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsApi.closeSync(descriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      if (fsApi.existsSync(tempPath)) {
        fsApi.unlinkSync(tempPath);
      }
    } catch {
      // Preserve the original failure; the final path is never partially written.
    }
    throw error;
  }
}

export {
  DEFAULT_MAX_SNAPSHOT_BYTES,
  assertPathWithinRoot,
  readCompatibleJson,
  readFormatPrefix,
  writeJsonAtomic
};
