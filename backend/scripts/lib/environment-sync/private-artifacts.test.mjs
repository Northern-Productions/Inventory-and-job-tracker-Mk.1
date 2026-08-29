import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  createPrivateDirectory,
  verifyPrivateArtifactProtection,
  verifyPrivateDirectoryProtection,
  writePrivateBytesExclusive,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';

const WINDOWS_BASE_COMMIT = 'fa80648799229786b22855415ad19a2f1abb4a1d';
const BROAD_SIDS = Object.freeze([
  ['Everyone', 'S-1-1-0'],
  ['Users', 'S-1-5-32-545'],
  ['Authenticated Users', 'S-1-5-11']
]);

function testRoot(label = 'private-artifacts') {
  return path.join(os.tmpdir(), `${label}-${crypto.randomBytes(8).toString('hex')}`);
}

function removeTestRoot(root) {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^[A-Za-z0-9 _\u0080-\uFFFF.-]+-[a-f0-9]{16}$/u);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: false });
}

function windowsPowerShell(script, environment = {}) {
  const executable = path.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  execFileSync(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      SystemRoot: process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
      WINDIR: process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
      ...environment
    }
  });
}

function addDirectoryRule(target, sid, {
  rights = 'ReadAndExecute',
  inheritance = 'ContainerInherit, ObjectInherit'
} = {}) {
  windowsPowerShell(
    `$ErrorActionPreference='Stop';
$p=[Environment]::GetEnvironmentVariable('CODEX_TEST_TARGET','Process');
$sidValue=[Environment]::GetEnvironmentVariable('CODEX_TEST_SID','Process');
$sid=if([string]::IsNullOrWhiteSpace($sidValue)){[Security.Principal.WindowsIdentity]::GetCurrent().User}else{[Security.Principal.SecurityIdentifier]::new($sidValue)};
$rights=[Security.AccessControl.FileSystemRights][Environment]::GetEnvironmentVariable('CODEX_TEST_RIGHTS','Process');
$inheritance=[Security.AccessControl.InheritanceFlags][Environment]::GetEnvironmentVariable('CODEX_TEST_INHERITANCE','Process');
$sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access;
$acl=[IO.Directory]::GetAccessControl($p,$sections);
$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);
[void]$acl.AddAccessRule($rule);
[IO.Directory]::SetAccessControl($p,$acl)`,
    {
      CODEX_TEST_TARGET: target,
      CODEX_TEST_SID: sid,
      CODEX_TEST_RIGHTS: rights,
      CODEX_TEST_INHERITANCE: inheritance
    }
  );
}

function assertInheritedRule(target, sid) {
  windowsPowerShell(
    `$ErrorActionPreference='Stop';
$p=[Environment]::GetEnvironmentVariable('CODEX_TEST_TARGET','Process');
$sidValue=[Environment]::GetEnvironmentVariable('CODEX_TEST_SID','Process');
$sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access;
$acl=[IO.Directory]::GetAccessControl($p,$sections);
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
if(-not ($rules | Where-Object {$_.IsInherited -and $_.IdentityReference.Value -eq $sidValue})){exit 44}`,
    { CODEX_TEST_TARGET: target, CODEX_TEST_SID: sid }
  );
}

function replaceWithDirectOwnerRule(target) {
  windowsPowerShell(
    `$ErrorActionPreference='Stop';
$p=[Environment]::GetEnvironmentVariable('CODEX_TEST_TARGET','Process');
$id=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=[Security.AccessControl.DirectorySecurity]::new();
$acl.SetAccessRuleProtection($true,$false);
$acl.SetOwner($id);
$rule=[Security.AccessControl.FileSystemAccessRule]::new($id,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);
[void]$acl.AddAccessRule($rule);
[IO.Directory]::SetAccessControl($p,$acl)`,
    { CODEX_TEST_TARGET: target }
  );
}

function windowsOnly(t) {
  if (process.platform !== 'win32') {
    t.skip('Windows DACL behavior is only available on Windows.');
    return false;
  }
  return true;
}

test('actual Windows helper protects parent and inherited descendants before returning', { concurrency: false }, (t) => {
  if (!windowsOnly(t)) return;
  const root = testRoot('private-artifacts-live-regression');
  try {
    createPrivateDirectory(root);
    assert.equal(verifyPrivateDirectoryProtection(root).ownerOnly, true);
    assert.deepEqual(fs.readdirSync(root), []);
    const contract = path.join(root, 'contract.private.json');
    writePrivateJsonExclusive(contract, { format: 'synthetic-contract-v1', count: 1 });
    assert.equal(verifyPrivateArtifactProtection(contract).ownerOnly, true);
  } finally {
    removeTestRoot(root);
  }
});

test('semantic verifier accepts redundant owner ACE representation rejected by the failed commit', { concurrency: false }, async (t) => {
  if (!windowsOnly(t)) return;
  const root = testRoot('private-artifacts-semantic-regression');
  const oldModulePath = path.join(root, 'old-private-artifacts.mjs');
  try {
    createPrivateDirectory(root);
    addDirectoryRule(root, '', { rights: 'ReadAndExecute', inheritance: 'None' });
    assert.equal(verifyPrivateDirectoryProtection(root).ownerOnly, true);

    const oldBytes = execFileSync('git', [
      'show',
      `${WINDOWS_BASE_COMMIT}:backend/scripts/lib/environment-sync/private-artifacts.mjs`
    ], { cwd: path.resolve(import.meta.dirname, '..', '..', '..', '..'), encoding: null, shell: false });
    try {
      fs.writeFileSync(oldModulePath, oldBytes, { flag: 'wx', mode: 0o600 });
    } finally {
      oldBytes.fill(0);
    }
    const oldModule = await import(`${pathToFileURL(oldModulePath).href}?exact-parent`);
    assert.throws(
      () => oldModule.verifyPrivateDirectoryProtection(root),
      (error) => error?.code === 'PRIVATE_ARTIFACT_PROTECTION_UNPROVEN'
    );
  } finally {
    removeTestRoot(root);
  }
});

test('private directory creation converges normal, inherited, broad, nested, and Unicode parents', { concurrency: false }, (t) => {
  if (!windowsOnly(t)) return;
  const roots = [];
  try {
    const normal = testRoot('private-artifacts-normal-parent');
    fs.mkdirSync(normal);
    roots.push(normal);
    assert.equal(verifyPrivateDirectoryProtection(createPrivateDirectory(path.join(normal, 'child'))).ownerOnly, true);

    const broad = testRoot('private-artifacts-broad-parent');
    createPrivateDirectory(broad);
    roots.push(broad);
    addDirectoryRule(broad, 'S-1-5-32-545');
    assert.equal(verifyPrivateDirectoryProtection(createPrivateDirectory(path.join(broad, 'child'))).ownerOnly, true);

    const nested = testRoot('private-artifacts-nested-parent');
    createPrivateDirectory(nested);
    roots.push(nested);
    assert.equal(verifyPrivateDirectoryProtection(createPrivateDirectory(path.join(nested, 'private-child'))).ownerOnly, true);

    const unicode = testRoot('private artifacts Unicode \u03a9');
    fs.mkdirSync(unicode);
    roots.push(unicode);
    assert.equal(verifyPrivateDirectoryProtection(createPrivateDirectory(path.join(unicode, 'child with spaces'))).ownerOnly, true);
  } finally {
    for (const root of roots.reverse()) removeTestRoot(root);
  }
});

test('verifier rejects broad principals and tampering after successful creation', { concurrency: false }, (t) => {
  if (!windowsOnly(t)) return;
  for (const [name, sid] of BROAD_SIDS) {
    const root = testRoot(`private-artifacts-reject-${name.replaceAll(' ', '-')}`);
    try {
      createPrivateDirectory(root);
      addDirectoryRule(root, sid);
      assert.throws(
        () => verifyPrivateDirectoryProtection(root),
        (error) => error?.code === 'PRIVATE_ARTIFACT_UNAUTHORIZED_PRINCIPAL'
      );
    } finally {
      removeTestRoot(root);
    }
  }
});

test('verifier rejects an unauthorized inherited ACE', { concurrency: false }, (t) => {
  if (!windowsOnly(t)) return;
  const root = testRoot('private-artifacts-inherited-broad');
  const child = path.join(root, 'child');
  try {
    fs.mkdirSync(root);
    addDirectoryRule(root, 'S-1-5-32-545');
    fs.mkdirSync(child);
    assertInheritedRule(child, 'S-1-5-32-545');
    assert.throws(
      () => verifyPrivateDirectoryProtection(child),
      (error) => error?.code === 'PRIVATE_ARTIFACT_DACL_NOT_PROTECTED'
    );
  } finally {
    removeTestRoot(root);
  }
});

test('verifier rejects wrong owner, enabled inheritance, and missing descendant flags', { concurrency: false }, (t) => {
  if (!windowsOnly(t)) return;
  assert.throws(
    () => verifyPrivateDirectoryProtection(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'),
    (error) => error?.code === 'PRIVATE_ARTIFACT_OWNER_MISMATCH'
  );

  const inherited = testRoot('private-artifacts-inheritance-enabled');
  const missingFlags = testRoot('private-artifacts-missing-flags');
  try {
    fs.mkdirSync(inherited);
    assert.throws(
      () => verifyPrivateDirectoryProtection(inherited),
      (error) => ['PRIVATE_ARTIFACT_OWNER_MISMATCH', 'PRIVATE_ARTIFACT_DACL_NOT_PROTECTED'].includes(error?.code)
    );

    createPrivateDirectory(missingFlags);
    replaceWithDirectOwnerRule(missingFlags);
    assert.throws(
      () => verifyPrivateDirectoryProtection(missingFlags),
      (error) => error?.code === 'PRIVATE_ARTIFACT_CHILD_INHERITANCE_MISSING'
    );
  } finally {
    removeTestRoot(inherited);
    removeTestRoot(missingFlags);
  }
});

test('verifier rejects junction substitution', { concurrency: false }, (t) => {
  if (!windowsOnly(t)) return;
  const root = testRoot('private-artifacts-reparse');
  const target = testRoot('private-artifacts-reparse-target');
  try {
    createPrivateDirectory(target);
    fs.symlinkSync(target, root, 'junction');
    assert.throws(
      () => verifyPrivateDirectoryProtection(root),
      (error) => error?.code === 'PRIVATE_ARTIFACT_REPARSE_POINT_REJECTED'
    );
  } finally {
    if (fs.existsSync(root)) fs.unlinkSync(root);
    removeTestRoot(target);
  }
});

test('private artifact lifecycle protects signed-style files and nested state directories', { concurrency: false }, (t) => {
  if (!windowsOnly(t)) return;
  const root = testRoot('private-artifacts-end-to-end');
  try {
    createPrivateDirectory(root);
    const contract = path.join(root, 'contract.private.json');
    const inventory = path.join(root, 'operation-inventory.private.json');
    const state = createPrivateDirectory(path.join(root, 'state'));
    const evidence = createPrivateDirectory(path.join(root, 'evidence'));
    writePrivateJsonExclusive(contract, { format: 'synthetic-contract-v1', authenticated: true });
    writePrivateJsonExclusive(inventory, { format: 'synthetic-inventory-v1', stageCount: 2 });
    writePrivateBytesExclusive(path.join(state, 'attempt.private.json'), Buffer.from('{"state":"prepared"}\n'));
    writePrivateBytesExclusive(path.join(evidence, 'result.private.json'), Buffer.from('{"result":"local-only"}\n'));
    for (const directory of [root, state, evidence]) {
      assert.equal(verifyPrivateDirectoryProtection(directory).ownerOnly, true);
    }
    for (const file of [contract, inventory, path.join(state, 'attempt.private.json'), path.join(evidence, 'result.private.json')]) {
      assert.equal(verifyPrivateArtifactProtection(file).ownerOnly, true);
    }
  } finally {
    removeTestRoot(root);
  }
});

test('remediation preparation protects its output before reading authority material', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, 'dev-recovery-remediation-preparation.mjs'), 'utf8');
  assert.ok(source.indexOf('createPrivateDirectory(path.resolve(outputDirectory))') >= 0);
  assert.ok(source.indexOf('createPrivateDirectory(path.resolve(outputDirectory))') < source.indexOf('readAuthorityKey(authorityKeyPath)'));
});
