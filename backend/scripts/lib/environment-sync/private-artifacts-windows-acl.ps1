$ErrorActionPreference = 'Stop'

$mode = [Environment]::GetEnvironmentVariable('CODEX_PRIVATE_ARTIFACT_MODE', 'Process')
$target = [Environment]::GetEnvironmentVariable('CODEX_PRIVATE_ARTIFACT_TARGET', 'Process')
$allowedModes = @('protect', 'verify', 'protect-directory', 'verify-directory')
$exitCode = 0
$probeFile = $null
$probeDirectory = $null
$probeGrandchild = $null

function Fail-Acl([int]$code) {
  throw [InvalidOperationException]::new(('CODEX_ACL_{0}' -f $code))
}

function Read-Acl([string]$path, [string]$kind) {
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
    [Security.AccessControl.AccessControlSections]::Access
  if ($kind -eq 'directory') {
    return [IO.Directory]::GetAccessControl($path, $sections)
  }
  return [IO.File]::GetAccessControl($path, $sections)
}

function Assert-Acl(
  [string]$path,
  [string]$kind,
  [bool]$mustBeProtected,
  [bool]$mustBeInherited
) {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $attributes = [IO.File]::GetAttributes($path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Acl 32 }
  $acl = Read-Acl $path $kind
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
  if ($owner.Value -ne $id.Value) { Fail-Acl 33 }
  if ($acl.AreAccessRulesProtected -ne $mustBeProtected) { Fail-Acl 34 }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { Fail-Acl 35 }
  $directRights = [Security.AccessControl.FileSystemRights]0
  $containerRights = [Security.AccessControl.FileSystemRights]0
  $objectRights = [Security.AccessControl.FileSystemRights]0
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $id.Value) { Fail-Acl 36 }
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { Fail-Acl 37 }
    if ($rule.IsInherited -ne $mustBeInherited) { Fail-Acl 38 }
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit) -ne 0) {
      Fail-Acl 39
    }
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) {
      $directRights = $directRights -bor $rule.FileSystemRights
    }
    if (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0) {
      $containerRights = $containerRights -bor $rule.FileSystemRights
    }
    if (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0) {
      $objectRights = $objectRights -bor $rule.FileSystemRights
    }
    if ($kind -eq 'file' -and $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None) {
      Fail-Acl 40
    }
  }
  $full = [Security.AccessControl.FileSystemRights]::FullControl
  if (($directRights -band $full) -ne $full) { Fail-Acl 41 }
  if (
    $kind -eq 'directory' -and
    ((($containerRights -band $full) -ne $full) -or (($objectRights -band $full) -ne $full))
  ) { Fail-Acl 42 }
}

try {
  if ($allowedModes -notcontains $mode) { Fail-Acl 19 }
  if ([string]::IsNullOrWhiteSpace($target)) { Fail-Acl 20 }
  $isDirectory = $mode.EndsWith('-directory')
  $shouldProtect = $mode.StartsWith('protect')
  $expectedKind = if ($isDirectory) { 'directory' } else { 'file' }
  $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($target))
  if ([string]::IsNullOrWhiteSpace($root)) { Fail-Acl 21 }
  $drive = [IO.DriveInfo]::new($root)
  if ($drive.DriveFormat -ne 'NTFS') { Fail-Acl 31 }
  if ($expectedKind -eq 'directory' -and -not [IO.Directory]::Exists($target)) { Fail-Acl 22 }
  if ($expectedKind -eq 'file' -and -not [IO.File]::Exists($target)) { Fail-Acl 22 }
  if ($shouldProtect) {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = if ($expectedKind -eq 'directory') {
      [Security.AccessControl.DirectorySecurity]::new()
    } else {
      [Security.AccessControl.FileSecurity]::new()
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($id)
    $inheritance = if ($expectedKind -eq 'directory') {
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
      [Security.AccessControl.InheritanceFlags]::None
    }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $id,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
    if ($expectedKind -eq 'directory') {
      [IO.Directory]::SetAccessControl($target, $acl)
    } else {
      [IO.File]::SetAccessControl($target, $acl)
    }
  }
  Assert-Acl $target $expectedKind $true $false
  if ($shouldProtect -and $expectedKind -eq 'directory') {
    $probeToken = [Guid]::NewGuid().ToString('N')
    $probeFile = [IO.Path]::Combine($target, ('private-acl-probe-file-{0}' -f $probeToken))
    $probeDirectory = [IO.Path]::Combine($target, ('private-acl-probe-directory-{0}' -f $probeToken))
    $probeGrandchild = [IO.Path]::Combine($probeDirectory, 'grandchild')
    $stream = [IO.File]::Open(
      $probeFile,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
    $stream.Dispose()
    [void][IO.Directory]::CreateDirectory($probeDirectory)
    $stream = [IO.File]::Open(
      $probeGrandchild,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
    $stream.Dispose()
    Assert-Acl $probeFile 'file' $false $true
    Assert-Acl $probeDirectory 'directory' $false $true
    Assert-Acl $probeGrandchild 'file' $false $true
  }
} catch {
  if ($_.Exception.Message -match '^CODEX_ACL_([0-9]+)$') {
    $exitCode = [int]$matches[1]
  } else {
    $exitCode = 90
  }
} finally {
  if ($probeGrandchild -and [IO.File]::Exists($probeGrandchild)) { [IO.File]::Delete($probeGrandchild) }
  if ($probeFile -and [IO.File]::Exists($probeFile)) { [IO.File]::Delete($probeFile) }
  if ($probeDirectory -and [IO.Directory]::Exists($probeDirectory)) {
    [IO.Directory]::Delete($probeDirectory, $false)
  }
}

if (
  ($probeFile -and [IO.File]::Exists($probeFile)) -or
  ($probeDirectory -and [IO.Directory]::Exists($probeDirectory))
) { exit 43 }
exit $exitCode
