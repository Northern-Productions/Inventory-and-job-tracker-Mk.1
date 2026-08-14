import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildMigrationRegistry,
  findMigration,
  getLatestMigration,
  MIGRATION_REGISTRY_COHERENT,
  MIGRATION_REGISTRY_COHERENT_WITH_LEGACY_WARNINGS,
  MIGRATION_REGISTRY_INCOHERENT,
  migrationExistsExactlyOnce,
  serializeMigrationRegistry
} from './migration-registry.mjs';

const STRICT_POLICY = Object.freeze({
  schemaVersion: 1,
  strictMirrorLogicalStart: 1,
  strictMirrorSupabaseVersionStart: '20000101000000'
});
const REGISTRY_CLI = fileURLToPath(new URL('../migration-registry.mjs', import.meta.url));

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function sourceFile(filePath, value = 'select 1;\n') {
  const bytes = Buffer.from(value, 'utf8');
  return { path: filePath, bytes, byteLength: bytes.length, contentIdentity: sha256(bytes) };
}

function pair(logicalId, version, name, value = 'select 1;\n') {
  return [
    sourceFile(`backend/migrations/${logicalId}_${name}.sql`, value),
    sourceFile(`supabase/migrations/${version}_${name}.sql`, value)
  ];
}

function issueCodes(registry) {
  return registry.issues.map((issue) => issue.code);
}

function run(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${command} failed`);
  return String(result.stdout || '').trim();
}

function git(repo, args) {
  return run('git', ['-C', repo, ...args]);
}

function makeRepo(t, { autocrlf = false } = {}) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-registry-test-'));
  const repo = path.join(container, 'repo');
  fs.mkdirSync(repo);
  run('git', ['init', '-b', 'main', repo], { cwd: container });
  git(repo, ['config', 'user.name', 'Migration Registry Test']);
  git(repo, ['config', 'user.email', 'migration-registry@example.invalid']);
  git(repo, ['config', 'core.autocrlf', autocrlf ? 'true' : 'false']);
  fs.mkdirSync(path.join(repo, 'backend', 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'supabase', 'migrations'), { recursive: true });
  t.after(() => fs.rmSync(container, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return repo;
}

function writePair(repo, logicalId, version, name, value, { stage = true } = {}) {
  const backend = path.join(repo, 'backend', 'migrations', `${logicalId}_${name}.sql`);
  const supabase = path.join(repo, 'supabase', 'migrations', `${version}_${name}.sql`);
  fs.writeFileSync(backend, value);
  fs.writeFileSync(supabase, value);
  if (stage) git(repo, ['add', '--', backend, supabase]);
}

test('current repository chain through 0199 is coherent with explicit legacy warnings', () => {
  const registry = buildMigrationRegistry();
  const latest = getLatestMigration(registry);

  assert.equal(registry.overall, MIGRATION_REGISTRY_COHERENT_WITH_LEGACY_WARNINGS);
  assert.equal(latest.logicalId, '0199');
  assert.equal(latest.supabaseVersion, '20260813100000');
  assert.equal(latest.exactMirror, true);
  const schemaGuard = fs.readFileSync(
    new URL('../check-schema-latest.mjs', import.meta.url),
    'utf8'
  );
  assert.match(
    schemaGuard,
    new RegExp(`const LATEST_MIGRATION = '${latest.logicalId}_${latest.name}\\.sql';`)
  );
  assert.equal(registry.summary.failures, 0);
  assert.deepEqual(issueCodes(registry), [
    'LEGACY_DUPLICATE_LOGICAL_MIGRATION',
    'LEGACY_MIGRATION_MIRROR_BYTE_DIFFERENCE',
    'LEGACY_MIGRATION_WITHOUT_MIRROR'
  ]);
});

test('mirror mismatch fails deterministically', () => {
  const source = [
    sourceFile('backend/migrations/0001_example.sql', 'select 1;\n'),
    sourceFile('supabase/migrations/20260101000000_example.sql', 'select 2;\n')
  ];
  const first = buildMigrationRegistry({ source, policy: STRICT_POLICY });
  const second = buildMigrationRegistry({ source, policy: STRICT_POLICY });

  assert.equal(first.overall, MIGRATION_REGISTRY_INCOHERENT);
  assert.deepEqual(second, first);
  assert.ok(issueCodes(first).includes('REQUIRED_MIGRATION_MIRROR_MISMATCH'));
});

test('missing required mirror fails', () => {
  const registry = buildMigrationRegistry({
    source: [sourceFile('backend/migrations/0001_example.sql')],
    policy: STRICT_POLICY
  });
  assert.equal(registry.overall, MIGRATION_REGISTRY_INCOHERENT);
  assert.ok(issueCodes(registry).includes('REQUIRED_MIGRATION_MIRROR_MISSING'));
});

test('duplicate logical migration fails in the strict chain', () => {
  const registry = buildMigrationRegistry({
    source: [
      ...pair('0001', '20260101000000', 'first'),
      ...pair('0001', '20260101010000', 'second')
    ],
    policy: STRICT_POLICY
  });
  assert.ok(issueCodes(registry).includes('DUPLICATE_LOGICAL_MIGRATION'));
});

test('duplicate Supabase timestamp fails', () => {
  const registry = buildMigrationRegistry({
    source: [
      ...pair('0001', '20260101000000', 'first'),
      ...pair('0002', '20260101000000', 'second')
    ],
    policy: STRICT_POLICY
  });
  assert.ok(issueCodes(registry).includes('DUPLICATE_SUPABASE_VERSION'));
});

test('malformed mapping name fails', () => {
  const registry = buildMigrationRegistry({
    source: [sourceFile('backend/migrations/not-a-migration.sql')],
    policy: STRICT_POLICY
  });
  assert.ok(issueCodes(registry).includes('MALFORMED_MIGRATION_NAME'));
});

test('incorrect cross-stream ordering fails', () => {
  const registry = buildMigrationRegistry({
    source: [
      ...pair('0001', '20260102000000', 'first'),
      ...pair('0002', '20260101000000', 'second')
    ],
    policy: STRICT_POLICY
  });
  assert.ok(issueCodes(registry).includes('MIGRATION_ORDERING_VIOLATION'));
});

test('exact byte differences are not normalized away', () => {
  const registry = buildMigrationRegistry({
    source: [
      sourceFile('backend/migrations/0001_example.sql', 'select 1;\n'),
      sourceFile('supabase/migrations/20260101000000_example.sql', 'select 1;\r\n')
    ],
    policy: STRICT_POLICY
  });
  assert.ok(issueCodes(registry).includes('REQUIRED_MIGRATION_MIRROR_MISMATCH'));
  assert.notEqual(registry.entries[0].contentIdentity, registry.entries[0].supabaseContentIdentity);
});

test('CRLF worktree bytes resolve to canonical LF Git index bytes', (t) => {
  const repo = makeRepo(t, { autocrlf: true });
  writePair(repo, '0001', '20260101000000', 'example', 'select 1;\r\n');

  const registry = buildMigrationRegistry({ repoRoot: repo, policy: STRICT_POLICY });
  const expected = sha256(Buffer.from('select 1;\n', 'utf8'));

  assert.equal(registry.overall, MIGRATION_REGISTRY_COHERENT);
  assert.equal(registry.entries[0].contentIdentity, expected);
  assert.equal(registry.entries[0].exactMirror, true);
});

test('newly staged migration participates before commit', (t) => {
  const repo = makeRepo(t);
  writePair(repo, '0001', '20260101000000', 'first', 'select 1;\n');
  git(repo, ['commit', '-m', 'test: first migration']);
  writePair(repo, '0002', '20260101010000', 'second', 'select 2;\n');

  const registry = buildMigrationRegistry({ repoRoot: repo, policy: STRICT_POLICY });

  assert.equal(getLatestMigration(registry).logicalId, '0002');
  assert.equal(registry.summary.backendMigrations, 2);
});

test('unstaged migration bytes fail closed instead of being silently ignored', (t) => {
  const repo = makeRepo(t);
  writePair(repo, '0001', '20260101000000', 'first', 'select 1;\n');
  git(repo, ['commit', '-m', 'test: first migration']);
  fs.appendFileSync(path.join(repo, 'backend', 'migrations', '0001_first.sql'), '-- unstaged\n');

  assert.throws(
    () => buildMigrationRegistry({ repoRoot: repo, policy: STRICT_POLICY }),
    (error) => error.code === 'MIGRATION_BYTES_NOT_STAGED'
  );
});

test('latest migration calculation uses logical ordering, not input ordering', () => {
  const registry = buildMigrationRegistry({
    source: [
      ...pair('0002', '20260101010000', 'second'),
      ...pair('0001', '20260101000000', 'first')
    ],
    policy: STRICT_POLICY
  });
  assert.equal(getLatestMigration(registry).logicalId, '0002');
});

test('historical lookup is exact and reports ambiguity', () => {
  const registry = buildMigrationRegistry({
    source: [
      ...pair('0001', '20260101000000', 'first'),
      ...pair('0001', '20260101010000', 'second')
    ],
    policy: { ...STRICT_POLICY, strictMirrorLogicalStart: 2 }
  });

  assert.equal(findMigration(registry, '0001', { name: 'second' }).supabaseVersion, '20260101010000');
  assert.equal(migrationExistsExactlyOnce(registry, '0001', { name: 'first' }), true);
  assert.equal(migrationExistsExactlyOnce(registry, '0001'), false);
  assert.throws(() => findMigration(registry, '0001'), /ambiguous/);
});

test('JSON output and registry identity are deterministic', () => {
  const source = [...pair('0001', '20260101000000', 'example')];
  const first = buildMigrationRegistry({ source, policy: STRICT_POLICY });
  const second = buildMigrationRegistry({ source: [...source].reverse(), policy: STRICT_POLICY });

  assert.equal(serializeMigrationRegistry(first), serializeMigrationRegistry(second));
  assert.equal(first.registryIdentity, second.registryIdentity);
  assert.match(serializeMigrationRegistry(first), /"byteSource": "git-index-blob-v1"/);
});

test('CLI check and JSON modes are deterministic and privacy-safe', () => {
  const first = spawnSync(process.execPath, [REGISTRY_CLI, '--json'], {
    encoding: 'utf8', shell: false, windowsHide: true
  });
  const second = spawnSync(process.execPath, [REGISTRY_CLI, '--json'], {
    encoding: 'utf8', shell: false, windowsHide: true
  });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout);
  assert.equal(JSON.parse(first.stdout).latest.logicalId, '0199');
  assert.equal(first.stderr, '');

  const checked = spawnSync(process.execPath, [REGISTRY_CLI, '--check'], {
    encoding: 'utf8', shell: false, windowsHide: true
  });
  assert.equal(checked.status, 0);
  assert.match(checked.stdout, /MIGRATION_REGISTRY_COHERENT_WITH_LEGACY_WARNINGS/);
});

test('CLI errors are categorical', () => {
  const result = spawnSync(process.execPath, [REGISTRY_CLI, '--unsupported'], {
    encoding: 'utf8', shell: false, windowsHide: true
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[migration-registry\] Unsupported option\. Use --help for usage\.\r?\n$/);
});
