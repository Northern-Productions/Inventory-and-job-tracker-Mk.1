import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function windowsAclScript(mode) {
  const isDirectory = mode.endsWith('-directory');
  if (mode.startsWith('protect')) {
    const inheritance = isDirectory
      ? `[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'`
      : '[Security.AccessControl.InheritanceFlags]::None';
    return `$ErrorActionPreference='Stop';$p=[Environment]::GetEnvironmentVariable('CODEX_PRIVATE_ARTIFACT_TARGET','Process');if([string]::IsNullOrWhiteSpace($p)){exit 20};$id=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $p;$acl.SetAccessRuleProtection($true,$false);foreach($existing in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($existing)};$acl.SetOwner($id);$rule=[Security.AccessControl.FileSystemAccessRule]::new($id,[Security.AccessControl.FileSystemRights]::FullControl,${inheritance},[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);[void]$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl`;
  }
  const directoryCheck = isDirectory
    ? `if((($r.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne [Security.AccessControl.InheritanceFlags]::ContainerInherit) -or (($r.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne [Security.AccessControl.InheritanceFlags]::ObjectInherit)){exit 24}`
    : `if($r.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None){exit 24}`;
  return `$ErrorActionPreference='Stop';$p=[Environment]::GetEnvironmentVariable('CODEX_PRIVATE_ARTIFACT_TARGET','Process');if([string]::IsNullOrWhiteSpace($p)){exit 20};$id=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $p;if(-not $acl.AreAccessRulesProtected){exit 21};$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if($rules.Count -ne 1){exit 22};$r=$rules[0];if($r.IdentityReference.Value -ne $id.Value -or $r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)){exit 23};${directoryCheck}`;
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
    const encoded = Buffer.from(windowsAclScript(mode), 'utf16le').toString('base64');
    execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        CODEX_PRIVATE_ARTIFACT_TARGET: artifactPath
      }
    });
  } catch {
    throw categoricalError(
      mode.startsWith('protect') ? 'PRIVATE_ARTIFACT_PROTECTION_FAILED' : 'PRIVATE_ARTIFACT_PROTECTION_UNPROVEN'
    );
  }
}

function protectPrivateArtifact(artifactPath) {
  fs.chmodSync(artifactPath, 0o600);
  if (process.platform === 'win32') {
    invokeWindowsAcl('protect', artifactPath);
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
  verifyPrivateArtifactProtection(filePath);
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
