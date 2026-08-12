import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOLING_REFERENCE = /migration-registry|readonly-diagnostics|@electric-sql\/pglite/;

function sourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...sourceFiles(resolved));
    else if (/\.(?:js|mjs|cjs|ts|tsx|jsx|json)$/.test(entry.name)) results.push(resolved);
  }
  return results;
}

test('migration registry and read-only diagnostics remain outside production import graphs', () => {
  const productionFiles = [
    path.join(REPO_ROOT, 'backend', 'server.mjs'),
    ...sourceFiles(path.join(REPO_ROOT, 'backend', 'src')),
    ...sourceFiles(path.join(REPO_ROOT, 'frontend', 'src')),
    ...sourceFiles(path.join(REPO_ROOT, 'supabase', 'functions'))
  ];
  const intersections = productionFiles.filter((filePath) => TOOLING_REFERENCE.test(fs.readFileSync(filePath, 'utf8')));
  assert.deepEqual(intersections, []);

  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'backend', 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(packageJson.dependencies || {}, '@electric-sql/pglite'), false);
  assert.equal(TOOLING_REFERENCE.test(packageJson.scripts.start), false);
  assert.equal(TOOLING_REFERENCE.test(packageJson.scripts['start:unsafe']), false);
  assert.equal(TOOLING_REFERENCE.test(packageJson.scripts.dev), false);
});
