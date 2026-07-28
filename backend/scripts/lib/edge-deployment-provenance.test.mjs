import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isExactNpmSpecifier,
  runDenoInfo,
  validateLockedGraph,
  verifyMaterializedTree
} from './edge-deployment-provenance.mjs';

const EXACT_SUPABASE_SPECIFIER = 'npm:@supabase/supabase-js@2.102.1';

function runGit(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8'
  }).trim();
}

function lockedGraphFixture() {
  return {
    denoConfig: {
      lock: {
        path: './deno.lock',
        frozen: true
      }
    },
    graph: {
      modules: [
        {
          dependencies: [
            {
              specifier: EXACT_SUPABASE_SPECIFIER,
              npmPackage: '@supabase/supabase-js@2.102.1'
            }
          ]
        }
      ],
      npmPackages: {
        '@supabase/supabase-js@2.102.1': {}
      }
    },
    lock: {
      version: '5',
      specifiers: {
        [EXACT_SUPABASE_SPECIFIER]: '2.102.1'
      },
      npm: {
        '@supabase/supabase-js@2.102.1': {
          integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`
        }
      }
    }
  };
}

test('accepts only immutable exact npm dependency specifiers', () => {
  assert.equal(isExactNpmSpecifier(EXACT_SUPABASE_SPECIFIER), true);
  assert.equal(isExactNpmSpecifier('npm:uuid@11.1.0'), true);
  assert.equal(isExactNpmSpecifier('npm:@supabase/supabase-js@2'), false);
  assert.equal(isExactNpmSpecifier('npm:@supabase/supabase-js@^2.102.1'), false);
  assert.equal(isExactNpmSpecifier('npm:@supabase/supabase-js@latest'), false);
  assert.equal(isExactNpmSpecifier('https://example.invalid/module.ts'), false);
});

test('requires a frozen version-5 lock with package integrity metadata', () => {
  const fixture = lockedGraphFixture();
  const result = validateLockedGraph(fixture);

  assert.deepEqual(result.externalSpecifiers, [
    {
      specifier: EXACT_SUPABASE_SPECIFIER,
      resolved: '@supabase/supabase-js@2.102.1'
    }
  ]);
  assert.equal(result.npmPackages.length, 1);
  assert.equal(result.npmPackages[0].package, '@supabase/supabase-js@2.102.1');

  const mutableFixture = lockedGraphFixture();
  mutableFixture.graph.modules[0].dependencies[0].specifier =
    'npm:@supabase/supabase-js@2';
  assert.throws(
    () => validateLockedGraph(mutableFixture),
    /Mutable or unsupported dependency specifier/
  );

  const invalidIntegrityFixture = lockedGraphFixture();
  invalidIntegrityFixture.lock.npm['@supabase/supabase-js@2.102.1'].integrity =
    'sha512-invalid';
  assert.throws(
    () => validateLockedGraph(invalidIntegrityFixture),
    /lacks valid integrity metadata/
  );

  const unfrozenFixture = lockedGraphFixture();
  unfrozenFixture.denoConfig.lock.frozen = false;
  assert.throws(
    () => validateLockedGraph(unfrozenFixture),
    /must use \.\/deno\.lock in frozen mode/
  );
});

test('resolves a frozen archive graph through source-relative Deno paths', (t) => {
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'edge-deployment-deno-path-test-')
  );
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }));

  const apiRoot = path.join(sourceRoot, 'supabase', 'functions', 'api');
  const sharedRoot = path.join(sourceRoot, 'supabase', 'functions', '_shared');
  fs.mkdirSync(apiRoot, { recursive: true });
  fs.mkdirSync(sharedRoot, { recursive: true });
  fs.writeFileSync(
    path.join(apiRoot, 'deno.json'),
    `${JSON.stringify({ lock: { path: './deno.lock', frozen: true } }, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(apiRoot, 'deno.lock'),
    `${JSON.stringify(
      { version: '5', specifiers: {}, jsr: {}, npm: {}, remote: {} },
      null,
      2
    )}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(apiRoot, 'index.ts'),
    "import { value } from '../_shared/value.ts';\nexport { value };\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(sharedRoot, 'value.ts'),
    'export const value = 1;\n',
    'utf8'
  );

  const graph = runDenoInfo({
    sourceRoot,
    entrypointPath: path.join(apiRoot, 'index.ts'),
    denoConfigPath: path.join(apiRoot, 'deno.json')
  });
  const localModules = graph.modules.filter((module) =>
    String(module.specifier || '').startsWith('file:')
  );

  assert.equal(localModules.length, 2);
  assert.deepEqual(
    localModules.map((module) => path.basename(new URL(module.specifier).pathname)).sort(),
    ['index.ts', 'value.ts']
  );
});

test('certifies an exact git-archive tree and rejects extra or changed bytes', (t) => {
  const testRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'edge-deployment-provenance-test-')
  );
  t.after(() => fs.rmSync(testRoot, { force: true, recursive: true }));

  const repoRoot = path.join(testRoot, 'repo');
  const archiveRoot = path.join(testRoot, 'archive');
  const archivePath = path.join(testRoot, 'source.tar');
  fs.mkdirSync(path.join(repoRoot, 'supabase', 'functions', 'api'), {
    recursive: true
  });
  fs.writeFileSync(
    path.join(repoRoot, 'supabase', 'functions', 'api', 'index.ts'),
    'export const value = 1;\n',
    'utf8'
  );
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'fixture\r\n', 'utf8');

  runGit(repoRoot, ['init']);
  runGit(repoRoot, ['config', 'user.name', 'Provenance Test']);
  runGit(repoRoot, ['config', 'user.email', 'provenance@example.invalid']);
  runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
  runGit(repoRoot, ['add', '.']);
  runGit(repoRoot, ['commit', '-m', 'fixture']);
  const commitSha = runGit(repoRoot, ['rev-parse', 'HEAD']);
  fs.writeFileSync(
    archivePath,
    execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar', commitSha])
  );
  fs.mkdirSync(archiveRoot);
  execFileSync('tar', ['-xf', archivePath, '-C', archiveRoot]);

  const result = verifyMaterializedTree({
    repoRoot,
    sourceRoot: archiveRoot,
    commit: commitSha
  });
  assert.equal(result.commitSha, commitSha);
  assert.equal(result.fileCount, 2);
  assert.match(result.archiveTreeDigest, /^sha256:[a-f0-9]{64}$/);

  fs.writeFileSync(path.join(archiveRoot, 'extra.txt'), 'untracked\n', 'utf8');
  assert.throws(
    () =>
      verifyMaterializedTree({
        repoRoot,
        sourceRoot: archiveRoot,
        commit: commitSha
      }),
    /file set does not exactly match/
  );

  fs.rmSync(path.join(archiveRoot, 'extra.txt'));
  fs.appendFileSync(path.join(archiveRoot, 'README.md'), 'changed\n', 'utf8');
  assert.throws(
    () =>
      verifyMaterializedTree({
        repoRoot,
        sourceRoot: archiveRoot,
        commit: commitSha
      }),
    /Materialized bytes differ from the commit for README\.md/
  );
});
