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
  const shouldProtect = mode.startsWith('protect');
  const expectedKind = isDirectory ? 'directory' : 'file';
  return `$ErrorActionPreference='Stop';
$p=[Environment]::GetEnvironmentVariable('CODEX_PRIVATE_ARTIFACT_TARGET','Process');
$expectedKind='${expectedKind}';
$shouldProtect=$${shouldProtect ? 'true' : 'false'};
$exitCode=0;
$probeFile=$null;
$probeDirectory=$null;
$probeGrandchild=$null;
function Fail-Acl([int]$code){throw [InvalidOperationException]::new(('CODEX_ACL_{0}' -f $code))}
function Read-Acl([string]$target,[string]$kind){
  $sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access;
  if($kind -eq 'directory'){return [IO.Directory]::GetAccessControl($target,$sections)}
  return [IO.File]::GetAccessControl($target,$sections)
}
function Assert-Acl([string]$target,[string]$kind,[bool]$mustBeProtected,[bool]$mustBeInherited){
  $id=[Security.Principal.WindowsIdentity]::GetCurrent().User;
  $attributes=[IO.File]::GetAttributes($target);
  if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){Fail-Acl 32}
  $acl=Read-Acl $target $kind;
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]);
  if($owner.Value -ne $id.Value){Fail-Acl 33}
  if($acl.AreAccessRulesProtected -ne $mustBeProtected){Fail-Acl 34}
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
  if($rules.Count -eq 0){Fail-Acl 35}
  $directRights=[Security.AccessControl.FileSystemRights]0;
  $containerRights=[Security.AccessControl.FileSystemRights]0;
  $objectRights=[Security.AccessControl.FileSystemRights]0;
  foreach($rule in $rules){
    if($rule.IdentityReference.Value -ne $id.Value){Fail-Acl 36}
    if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){Fail-Acl 37}
    if($rule.IsInherited -ne $mustBeInherited){Fail-Acl 38}
    if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit) -ne 0){Fail-Acl 39}
    if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0){$directRights=$directRights -bor $rule.FileSystemRights}
    if(($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0){$containerRights=$containerRights -bor $rule.FileSystemRights}
    if(($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0){$objectRights=$objectRights -bor $rule.FileSystemRights}
    if($kind -eq 'file' -and $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None){Fail-Acl 40}
  }
  $full=[Security.AccessControl.FileSystemRights]::FullControl;
  if(($directRights -band $full) -ne $full){Fail-Acl 41}
  if($kind -eq 'directory' -and ((($containerRights -band $full) -ne $full) -or (($objectRights -band $full) -ne $full))){Fail-Acl 42}
}
try{
  if([string]::IsNullOrWhiteSpace($p)){Fail-Acl 20}
  $root=[IO.Path]::GetPathRoot([IO.Path]::GetFullPath($p));
  if([string]::IsNullOrWhiteSpace($root)){Fail-Acl 21}
  $drive=[IO.DriveInfo]::new($root);
  if($drive.DriveFormat -ne 'NTFS'){Fail-Acl 31}
  if($expectedKind -eq 'directory' -and -not [IO.Directory]::Exists($p)){Fail-Acl 22}
  if($expectedKind -eq 'file' -and -not [IO.File]::Exists($p)){Fail-Acl 22}
  if($shouldProtect){
    $id=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    if($expectedKind -eq 'directory'){$acl=[Security.AccessControl.DirectorySecurity]::new()}else{$acl=[Security.AccessControl.FileSecurity]::new()}
    $acl.SetAccessRuleProtection($true,$false);
    $acl.SetOwner($id);
    $inheritance=if($expectedKind -eq 'directory'){[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($id,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);
    [void]$acl.AddAccessRule($rule);
    if($expectedKind -eq 'directory'){[IO.Directory]::SetAccessControl($p,$acl)}else{[IO.File]::SetAccessControl($p,$acl)}
  }
  Assert-Acl $p $expectedKind $true $false;
  if($shouldProtect -and $expectedKind -eq 'directory'){
    $probeToken=[Guid]::NewGuid().ToString('N');
    $probeFile=[IO.Path]::Combine($p,('private-acl-probe-file-{0}' -f $probeToken));
    $probeDirectory=[IO.Path]::Combine($p,('private-acl-probe-directory-{0}' -f $probeToken));
    $probeGrandchild=[IO.Path]::Combine($probeDirectory,'grandchild');
    $stream=[IO.File]::Open($probeFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);
    $stream.Dispose();
    [void][IO.Directory]::CreateDirectory($probeDirectory);
    $stream=[IO.File]::Open($probeGrandchild,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);
    $stream.Dispose();
    Assert-Acl $probeFile 'file' $false $true;
    Assert-Acl $probeDirectory 'directory' $false $true;
    Assert-Acl $probeGrandchild 'file' $false $true;
  }
}catch{
  if($_.Exception.Message -match '^CODEX_ACL_([0-9]+)$'){$exitCode=[int]$matches[1]}else{$exitCode=90}
}finally{
  if($probeGrandchild -and [IO.File]::Exists($probeGrandchild)){[IO.File]::Delete($probeGrandchild)}
  if($probeFile -and [IO.File]::Exists($probeFile)){[IO.File]::Delete($probeFile)}
  if($probeDirectory -and [IO.Directory]::Exists($probeDirectory)){[IO.Directory]::Delete($probeDirectory,$false)}
}
if(($probeFile -and [IO.File]::Exists($probeFile)) -or ($probeDirectory -and [IO.Directory]::Exists($probeDirectory))){exit 43}
exit $exitCode`;
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
