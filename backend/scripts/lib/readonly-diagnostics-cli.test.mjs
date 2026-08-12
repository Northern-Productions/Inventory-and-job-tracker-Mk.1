import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { REPOSITORY_READONLY_CHARACTERIZATION } from './readonly-diagnostics-characterizations.mjs';

const CLI = fileURLToPath(new URL('../readonly-diagnostics.mjs', import.meta.url));

function isolatedEnvironment(container) {
  return {
    PATH: path.dirname(process.execPath),
    SYSTEMROOT: process.env.SystemRoot || '',
    TEMP: container,
    TMP: container,
    HOME: container,
    USERPROFILE: container,
    NODE_NO_WARNINGS: '1'
  };
}

function runCli(args, cwd, env = isolatedEnvironment(cwd)) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 10_000
  });
}

test('CLI dry validation is deterministic and constructs no database client', () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-cli-'));
  try {
    const inventoryPath = path.join(container, 'reviewed-inventory.json');
    fs.writeFileSync(inventoryPath, `${JSON.stringify(REPOSITORY_READONLY_CHARACTERIZATION, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const result = runCli(['--inventory', inventoryPath, '--target', 'local', '--dry-validate', '--json'], container);
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.validation, 'PASSED');
    assert.equal(report.databaseClientConstructed, false);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('CLI rejection is categorical and does not disclose private paths or SQL', () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-cli-'));
  try {
    const privateName = 'private-artifact-name-must-not-appear.json';
    const inventoryPath = path.join(container, privateName);
    fs.writeFileSync(inventoryPath, '{"unsafe":"private SQL DELETE"}\n', { flag: 'wx', mode: 0o600 });
    const result = runCli(['--inventory', inventoryPath, '--target', 'local', '--dry-validate'], container);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^\[readonly-diagnostic\] [A-Z0-9_]+\r?\n$/);
    assert.equal(result.stderr.includes(privateName), false);
    assert.equal(result.stderr.includes('DELETE'), false);
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('CLI help needs no connection configuration', () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-cli-'));
  try {
    const result = runCli(['--help'], container);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /diagnostics:readonly|readonly-diagnostics/);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('CLI rejects target mismatch and unsupported options before client construction', () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-cli-'));
  try {
    const inventoryPath = path.join(container, 'reviewed-inventory.json');
    fs.writeFileSync(inventoryPath, `${JSON.stringify(REPOSITORY_READONLY_CHARACTERIZATION)}\n`, { flag: 'wx', mode: 0o600 });
    const mismatch = runCli(['--inventory', inventoryPath, '--target', 'dev', '--dry-validate'], container);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /CLI_TARGET_MISMATCH/);
    const unsupported = runCli(['--inventory', inventoryPath, '--target', 'local', '--dry-validate', '--unknown'], container);
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /CLI_ARGUMENT_INVALID/);
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});
