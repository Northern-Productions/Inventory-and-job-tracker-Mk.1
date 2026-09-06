import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WINDOWS_ACL_SCRIPT = fileURLToPath(
  new URL('./private-artifacts-windows-acl.ps1', import.meta.url)
);

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function invokeWindowsAcl(mode, artifactPath) {
  try {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const executable = path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    execFileSync(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_ACL_SCRIPT
    ], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        CODEX_PRIVATE_ARTIFACT_MODE: mode,
        CODEX_PRIVATE_ARTIFACT_TARGET: artifactPath
      }
    });
  } catch (error) {
    const reason = new Map([
      [20, 'PRIVATE_ARTIFACT_TARGET_MISSING'],
      [21, 'PRIVATE_ARTIFACT_FILESYSTEM_ROOT_INVALID'],
      [22, 'PRIVATE_ARTIFACT_TARGET_TYPE_INVALID'],
      [31, 'PRIVATE_ARTIFACT_FILESYSTEM_UNSUPPORTED'],
      [32, 'PRIVATE_ARTIFACT_REPARSE_POINT_REJECTED'],
      [33, 'PRIVATE_ARTIFACT_OWNER_MISMATCH'],
      [34, 'PRIVATE_ARTIFACT_DACL_NOT_PROTECTED'],
      [35, 'PRIVATE_ARTIFACT_DACL_EMPTY'],
      [36, 'PRIVATE_ARTIFACT_UNAUTHORIZED_PRINCIPAL'],
      [37, 'PRIVATE_ARTIFACT_DENY_ACE_REJECTED'],
      [38, 'PRIVATE_ARTIFACT_ACE_INHERITANCE_MISMATCH'],
      [39, 'PRIVATE_ARTIFACT_PROPAGATION_INVALID'],
      [40, 'PRIVATE_ARTIFACT_FILE_INHERITANCE_INVALID'],
      [41, 'PRIVATE_ARTIFACT_FULL_CONTROL_MISSING'],
      [42, 'PRIVATE_ARTIFACT_CHILD_INHERITANCE_MISSING'],
      [43, 'PRIVATE_ARTIFACT_PROBE_CLEANUP_FAILED']
    ]).get(Number(error?.status));
    throw categoricalError(reason || (
      mode.startsWith('protect') ? 'PRIVATE_ARTIFACT_PROTECTION_FAILED' : 'PRIVATE_ARTIFACT_PROTECTION_UNPROVEN'
    ));
  }
}

function protectPrivateArtifact(artifactPath) {
  fs.chmodSync(artifactPath, 0o600);
  if (process.platform === 'win32') {
    invokeWindowsAcl('protect', artifactPath);
    return { mechanism: 'ntfs-protected-dacl', ownerOnly: true };
  }
  return verifyPrivateArtifactProtection(artifactPath);
}

function verifyPrivateArtifactProtection(artifactPath) {
  if (process.platform === 'win32') {
    invokeWindowsAcl('verify', artifactPath);
    return { mechanism: 'ntfs-protected-dacl', ownerOnly: true };
  }
  const mode = fs.statSync(artifactPath).mode & 0o777;
  if (mode !== 0o600) {
    throw categoricalError('PRIVATE_ARTIFACT_PROTECTION_UNPROVEN');
  }
  return { mechanism: 'posix-0600', ownerOnly: true };
}

function protectPrivateDirectory(directoryPath) {
  fs.chmodSync(directoryPath, 0o700);
  if (process.platform === 'win32') {
    invokeWindowsAcl('protect-directory', directoryPath);
    return { mechanism: 'ntfs-protected-inheritable-dacl', ownerOnly: true };
  }
  return verifyPrivateDirectoryProtection(directoryPath);
}

function verifyPrivateDirectoryProtection(directoryPath) {
  if (process.platform === 'win32') {
    invokeWindowsAcl('verify-directory', directoryPath);
    return { mechanism: 'ntfs-protected-inheritable-dacl', ownerOnly: true };
  }
  const mode = fs.statSync(directoryPath).mode & 0o777;
  if (mode !== 0o700) {
    throw categoricalError('PRIVATE_ARTIFACT_PROTECTION_UNPROVEN');
  }
  return { mechanism: 'posix-0700', ownerOnly: true };
}

function fsyncDirectory(directoryPath) {
  if (process.platform === 'win32') {
    return 'unsupported';
  }
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(descriptor);
    return 'succeeded';
  } catch {
    return 'failed';
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function assertSafeArtifactName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(name || ''))) {
    throw categoricalError('PRIVATE_ARTIFACT_NAME_INVALID');
  }
  return name;
}

function createPrivateDirectory(directoryPath) {
  const resolved = path.resolve(directoryPath);
  fs.mkdirSync(resolved, { recursive: false, mode: 0o700 });
  protectPrivateDirectory(resolved);
  return resolved;
}

function openPrivateFileExclusive(filePath) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    const protection = protectPrivateArtifact(filePath);
    return { descriptor, protection };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function writePrivateBytesExclusive(filePath, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const { descriptor, protection } = openPrivateFileExclusive(filePath);
  try {
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(descriptor, buffer, offset, buffer.length - offset, null);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  // The exclusive descriptor was returned only after exact-file protection was verified.
  const directoryFsync = fsyncDirectory(path.dirname(filePath));
  if (directoryFsync === 'failed') {
    throw categoricalError('PRIVATE_ARTIFACT_DIRECTORY_FSYNC_FAILED');
  }
  return { protection, fileFsync: 'succeeded', directoryFsync };
}

function writePrivateJsonExclusive(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    return writePrivateBytesExclusive(filePath, bytes);
  } finally {
    bytes.fill(0);
  }
}

function privateArtifactPath(directoryPath, fileName) {
  const safeName = assertSafeArtifactName(fileName);
  const root = path.resolve(directoryPath);
  const target = path.resolve(root, safeName);
  if (path.dirname(target) !== root) {
    throw categoricalError('PRIVATE_ARTIFACT_PATH_INVALID');
  }
  return target;
}

export {
  assertSafeArtifactName,
  createPrivateDirectory,
  fsyncDirectory,
  openPrivateFileExclusive,
  privateArtifactPath,
  protectPrivateArtifact,
  protectPrivateDirectory,
  verifyPrivateArtifactProtection,
  verifyPrivateDirectoryProtection,
  writePrivateBytesExclusive,
  writePrivateJsonExclusive
};
