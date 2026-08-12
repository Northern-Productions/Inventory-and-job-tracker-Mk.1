import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  formatRepositoryDoctorReport,
  REPOSITORY_HEALTHY,
  REPOSITORY_HEALTHY_WITH_WARNINGS,
  REPOSITORY_UNSAFE_FOR_CODEX,
  runRepositoryDoctor
} from './repo-doctor.mjs';

const PROCESS_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1'
};

function runProcess(command, args, { cwd, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    env: PROCESS_ENV
  });
  assert.equal(result.error, undefined, `${command} could not start`);
  assert.equal(result.status, 0, `${command} ${args[0] || ''} failed`);
  return String(result.stdout || '').trim();
}

function git(repo, args, options = {}) {
  return runProcess('git', ['-C', repo, ...args], options);
}

function makeRepository(t) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-doctor-test-'));
  const repo = path.join(container, 'repo');
  fs.mkdirSync(repo);
  runProcess('git', ['init', '-b', 'main', repo], { cwd: container });
  git(repo, ['config', 'user.name', 'Repository Doctor Test']);
  git(repo, ['config', 'user.email', 'repo-doctor@example.invalid']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(repo, 'docs', 'automation'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Test policy\n');
  fs.writeFileSync(path.join(repo, 'docs', 'automation', 'codex-operating-manual.md'), '# Test manual\n');
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'repository doctor fixture\n');
  git(repo, ['add', '--', 'AGENTS.md', 'docs/automation/codex-operating-manual.md', 'seed.txt']);
  git(repo, ['commit', '-m', 'test: initialize repository']);
  t.after(() => fs.rmSync(container, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return { container, repo };
}

function doctor(repo, options = {}) {
  return runRepositoryDoctor({ expectedRoot: repo, cwd: repo, includeToolchain: false, ...options });
}

function getCheck(report, id) {
  const matches = report.repositoryChecks.filter((check) => check.id === id);
  assert.equal(matches.length, 1, `expected one ${id} result`);
  return matches[0];
}

function hashTree(root) {
  const hash = crypto.createHash('sha256');
  const walk = (directory, relative = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childPath = path.join(directory, entry.name);
      hash.update(childRelative).update('\0');
      if (entry.isDirectory()) {
        hash.update('directory\0');
        walk(childPath, childRelative);
      } else if (entry.isSymbolicLink()) {
        hash.update('link\0').update(fs.readlinkSync(childPath)).update('\0');
      } else {
        hash.update('file\0').update(fs.readFileSync(childPath)).update('\0');
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}

test('healthy normal repository is deterministic, private, and non-mutating', (t) => {
  const { container, repo } = makeRepository(t);
  git(repo, ['tag', 'test-policy']);
  git(repo, ['pack-refs', '--all', '--prune']);
  const before = hashTree(path.join(repo, '.git'));

  const first = doctor(repo);
  const second = doctor(repo);
  const after = hashTree(path.join(repo, '.git'));

  assert.equal(first.overall, REPOSITORY_HEALTHY);
  assert.deepEqual(second, first);
  assert.equal(after, before);
  assert.equal(getCheck(first, 'repository.storage').status, 'PASS');
  assert.equal(getCheck(first, 'refs.packed').status, 'PASS');
  assert.ok(getCheck(first, 'refs.packed').metrics.refs >= 1);
  const output = formatRepositoryDoctorReport(first);
  assert.equal(output.includes(repo), false);
  assert.equal(output.includes(container), false);
});

test('healthy multiple-worktree repository is reciprocal', (t) => {
  const { container, repo } = makeRepository(t);
  const linked = path.join(container, 'linked');
  git(repo, ['worktree', 'add', '-b', 'feature/linked', linked]);

  const report = runRepositoryDoctor({ expectedRoot: repo, cwd: linked, includeToolchain: false });

  assert.equal(report.overall, REPOSITORY_HEALTHY);
  assert.equal(getCheck(report, 'worktrees.registration').status, 'PASS');
  assert.equal(getCheck(report, 'worktrees.registration').metrics.live, 2);
});

test('missing core.worktree target fails closed deterministically', (t) => {
  const { container, repo } = makeRepository(t);
  git(repo, ['config', 'core.worktree', path.join(container, 'deleted-worktree')]);

  const first = doctor(repo);
  const second = doctor(repo);

  assert.equal(first.overall, REPOSITORY_UNSAFE_FOR_CODEX);
  assert.deepEqual(second, first);
  assert.equal(getCheck(first, 'canonical.core_worktree').status, 'FAIL');
  assert.equal(getCheck(first, 'canonical.plumbing').status, 'FAIL');
  assert.equal(formatRepositoryDoctorReport(first).includes(container), false);
  assert.equal(JSON.stringify(first).includes(container), false);
});

test('valid canonical core.worktree target is accepted', (t) => {
  const { repo } = makeRepository(t);
  git(repo, ['config', 'core.worktree', repo]);

  const report = doctor(repo);

  assert.equal(report.overall, REPOSITORY_HEALTHY);
  assert.equal(getCheck(report, 'canonical.core_worktree').status, 'PASS');
});

test('loose ref containing a NUL byte fails closed deterministically', (t) => {
  const { container, repo } = makeRepository(t);
  const refDirectory = path.join(repo, '.git', 'refs', 'codex');
  fs.mkdirSync(refDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(refDirectory, 'incident'),
    Buffer.concat([Buffer.from('0'.repeat(40)), Buffer.from([0]), Buffer.from('\n')])
  );

  const first = doctor(repo);
  const second = doctor(repo);

  assert.equal(first.overall, REPOSITORY_UNSAFE_FOR_CODEX);
  assert.deepEqual(second, first);
  assert.equal(getCheck(first, 'refs.loose').status, 'FAIL');
  assert.equal(getCheck(first, 'git.log_all').status, 'FAIL');
  assert.equal(getCheck(first, 'git.show_ref').status, 'FAIL');
  assert.equal(formatRepositoryDoctorReport(first).includes(container), false);
  assert.equal(JSON.stringify(first).includes(container), false);
});

test('ref pointing to a missing object fails closed', (t) => {
  const { repo } = makeRepository(t);
  const refDirectory = path.join(repo, '.git', 'refs', 'codex');
  fs.mkdirSync(refDirectory, { recursive: true });
  fs.writeFileSync(path.join(refDirectory, 'missing-object'), `${'f'.repeat(40)}\n`);

  const report = doctor(repo);

  assert.equal(report.overall, REPOSITORY_UNSAFE_FOR_CODEX);
  assert.equal(getCheck(report, 'refs.objects').status, 'FAIL');
});

test('harmless dangling object is a warning', (t) => {
  const { repo } = makeRepository(t);
  git(repo, ['hash-object', '-w', '--stdin'], { input: 'unreferenced object\n' });

  const report = doctor(repo);

  assert.equal(report.overall, REPOSITORY_HEALTHY_WITH_WARNINGS);
  assert.equal(getCheck(report, 'objects.integrity').status, 'WARNING');
});

test('stale prunable worktree registration is a warning', (t) => {
  const { container, repo } = makeRepository(t);
  const stale = path.join(container, 'stale');
  git(repo, ['worktree', 'add', '-b', 'feature/stale', stale]);
  fs.rmSync(stale, { recursive: true, force: true });

  const report = doctor(repo);

  assert.equal(report.overall, REPOSITORY_HEALTHY_WITH_WARNINGS);
  assert.equal(getCheck(report, 'worktrees.registration').status, 'WARNING');
  assert.equal(getCheck(report, 'worktrees.registration').metrics.stalePrunable, 1);
});

test('detached canonical HEAD is understandable and warns', (t) => {
  const { repo } = makeRepository(t);
  git(repo, ['checkout', '--detach']);

  const report = doctor(repo);

  assert.equal(report.overall, REPOSITORY_HEALTHY_WITH_WARNINGS);
  assert.equal(getCheck(report, 'repository.head_state').status, 'WARNING');
  assert.equal(getCheck(report, 'canonical.head_state').status, 'WARNING');
});

test('canonical root on a feature branch is a warning', (t) => {
  const { repo } = makeRepository(t);
  git(repo, ['checkout', '-b', 'feature/example']);

  const report = doctor(repo);

  assert.equal(report.overall, REPOSITORY_HEALTHY_WITH_WARNINGS);
  assert.equal(getCheck(report, 'repository.head_state').status, 'PASS');
  assert.equal(getCheck(report, 'canonical.head_state').status, 'WARNING');
});

test('missing operating manual fails closed', (t) => {
  const { repo } = makeRepository(t);
  fs.rmSync(path.join(repo, 'docs', 'automation', 'codex-operating-manual.md'));

  const report = doctor(repo);

  assert.equal(report.overall, REPOSITORY_UNSAFE_FOR_CODEX);
  assert.equal(getCheck(report, 'policy.availability').status, 'FAIL');
});

test('unavailable optional tool is separate from repository health', (t) => {
  const { repo } = makeRepository(t);

  const report = runRepositoryDoctor({
    expectedRoot: repo,
    cwd: repo,
    includeToolchain: true,
    toolchainDefinitions: [
      {
        name: 'optional-test-tool',
        command: 'repository-doctor-command-that-does-not-exist',
        args: ['--version'],
        optional: true
      }
    ]
  });

  assert.equal(report.overall, REPOSITORY_HEALTHY);
  assert.equal(report.toolchain.overall, 'TOOLCHAIN_READY_WITH_WARNINGS');
  assert.deepEqual(report.toolchain.checks, [
    { id: 'optional-test-tool', status: 'WARNING', summary: 'optional tool unavailable' }
  ]);
});

test('codex refresh runs repository health before ordinary Git discovery', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(testDirectory, '..', 'codex-task-refresh.mjs'), 'utf8');
  const doctorCall = source.indexOf('const repositoryHealth = runRepositoryDoctor()');
  const repositoryDiscovery = source.indexOf('const repoRoot = getRepoRoot()');

  assert.ok(doctorCall >= 0);
  assert.ok(repositoryDiscovery > doctorCall);
});
